import { useCallback, useEffect, useRef, useState } from 'react';
import type { WireSession, WireParticipant, WireSuggestion } from '../state.js';
import { postCoordinatorAnswer, postApprove, postKick, postLock } from '../lib/api.js';
import { DecisionsPanel } from '../components/coordinator/DecisionsPanel.js';
import { CoordinatorQuestionCard } from '../components/coordinator/CoordinatorQuestionCard.js';

interface CoordinatorProps {
  session: WireSession;
  isCoordinator: true; // gate enforced upstream in App.tsx
  roomLocked: boolean;
}

/** Per-ticket pick UI state (UI-SPEC Per-Component Contract). */
interface CardState {
  selectedSuggestionId?: string;
  overrideText: string;
  recording: boolean;
  error: string | null;
}

const EMPTY_CARD: CardState = {
  overrideText: '',
  recording: false,
  error: null,
};

/**
 * WR-06 bounded fallback re-enable for the record button. Long enough that the
 * `question_resolved` WS event normally flips the card to its resolved variant
 * first (avoiding the double-POST race that the server rejects with 409), short
 * enough that the control can never stay permanently stuck if that event never
 * lands.
 */
const RECORD_FALLBACK_REENABLE_MS = 5000;

function nameFor(participants: WireParticipant[], id: string): string {
  return participants.find((p) => p.id === id)?.display_name ?? id;
}

/**
 * Coordinator timeline (COORD-01 / COORD-03). Renders the header, the decisions
 * panel, and the current question card. Owns the per-ticket pick state map keyed
 * by `ticket_id` (defensive against multiple simultaneous questions — Phase 3
 * only ever has one) and the `postCoordinatorAnswer` orchestration. The card
 * flips to resolved purely from the incoming `question_resolved` WS event
 * (handled by the reducer) — this component only drives the POST + error copy.
 */
export function Coordinator({ session, roomLocked }: CoordinatorProps) {
  const q = session.current_question;
  const [cards, setCards] = useState<Record<string, CardState>>({});

  // WR-02/WR-03: per-ticket fallback-timer handles. Keyed by ticket so a new
  // record supersedes its predecessor, a resolved question clears its own
  // pending timer, and unmount clears every outstanding timer — preventing a
  // setState-on-unmounted-component path and a stale/pruned-ticket patch.
  const fallbackTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearFallbackTimer = useCallback((ticketId: string) => {
    const handle = fallbackTimers.current.get(ticketId);
    if (handle !== undefined) {
      clearTimeout(handle);
      fallbackTimers.current.delete(ticketId);
    }
  }, []);

  // Clear all pending timers on unmount.
  useEffect(() => {
    const timers = fallbackTimers.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  // When a question is resolved (the reducer flips `current_question` away from
  // a ticket), clear that ticket's pending fallback timer so it can no longer
  // patch the now-terminal card.
  const activeTicketId = q?.ticket_id ?? null;
  useEffect(() => {
    for (const ticketId of [...fallbackTimers.current.keys()]) {
      if (ticketId !== activeTicketId) clearFallbackTimer(ticketId);
    }
  }, [activeTicketId, clearFallbackTimer]);

  const cardFor = (ticketId: string): CardState => cards[ticketId] ?? EMPTY_CARD;

  const patchCard = useCallback((ticketId: string, patch: Partial<CardState>) => {
    setCards((prev) => ({
      ...prev,
      [ticketId]: { ...EMPTY_CARD, ...prev[ticketId], ...patch },
    }));
  }, []);

  const onSelectSuggestion = useCallback(
    (ticketId: string, suggestionId: string) => {
      patchCard(ticketId, { selectedSuggestionId: suggestionId, error: null });
    },
    [patchCard],
  );

  const onChangeOverride = useCallback(
    (ticketId: string, text: string) => {
      patchCard(ticketId, { overrideText: text });
    },
    [patchCard],
  );

  const record = useCallback(
    async (
      ticketId: string,
      value: string,
      source: 'suggestion' | 'override',
    ): Promise<void> => {
      patchCard(ticketId, { recording: true, error: null });
      try {
        await postCoordinatorAnswer({ ticket_id: ticketId, value, source });
        // WR-03: leave `recording: true` on success so the `question_resolved`
        // WS event can flip the card to its resolved variant via the reducer
        // (controls are gated on `isResolved || recording`). Clearing
        // `recording` synchronously here reopened a window where a fast second
        // pick fired a redundant POST that the server rejects with 409 —
        // surfacing a confusing "already resolved" error on the happy path.
        //
        // WR-06: but `question_resolved` is the *only* re-enable path, so if
        // that event never lands (WS drop between the 200 and the broadcast,
        // a reconnect whose replay missed the event after it aged out of the
        // 500-event RingBuffer, or a backgrounded tab coalescing the frame)
        // the button stays disabled forever even though the answer WAS
        // recorded. Add a bounded fallback re-enable: long enough that the
        // resolved variant normally takes over first (avoiding the double-POST
        // race), but short enough that the control can never get permanently
        // stuck. If the resolved event already arrived, the card is in its
        // resolved variant and `recording` is moot.
        //
        // WR-02/WR-03: supersede any prior timer for this ticket before
        // scheduling, store the handle so it can be cleared on unmount/resolve,
        // and self-evict the map entry when the timer fires.
        clearFallbackTimer(ticketId);
        fallbackTimers.current.set(
          ticketId,
          setTimeout(() => {
            fallbackTimers.current.delete(ticketId);
            patchCard(ticketId, { recording: false });
          }, RECORD_FALLBACK_REENABLE_MS),
        );
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        const msg =
          status === 409
            ? 'That question was already resolved.'
            : `Couldn't record that answer — try again. (${status ?? 'network'})`;
        patchCard(ticketId, { recording: false, error: msg });
      }
    },
    [patchCard, clearFallbackTimer],
  );

  const onRecordSuggestion = useCallback(
    (ticketId: string, suggestions: WireSuggestion[]) => {
      const card = cards[ticketId];
      const picked = suggestions.find((s) => s.id === card?.selectedSuggestionId);
      if (!picked) return;
      void record(ticketId, picked.value, 'suggestion');
    },
    [cards, record],
  );

  const onRecordOverride = useCallback(
    (ticketId: string) => {
      const card = cards[ticketId];
      const value = (card?.overrideText ?? '').trim();
      if (!value) return;
      void record(ticketId, value, 'override');
    },
    [cards, record],
  );

  const handleApprove = useCallback(async (participantId: string) => {
    try {
      await postApprove({ participant_id: participantId });
    } catch {
      // optimistic; WS participant_status_changed confirms the change
    }
  }, []);

  const handleKick = useCallback(async (participantId: string) => {
    try {
      await postKick({ participant_id: participantId });
    } catch {
      // optimistic; WS participant_status_changed confirms the change
    }
  }, []);

  const handleLock = useCallback(async (locked: boolean) => {
    try {
      await postLock({ locked });
    } catch {
      // optimistic; WS room_locked confirms the change
    }
  }, []);

  const hasContent = q !== null || session.decisions.length > 0;

  return (
    <main aria-label="Coordinator view" data-testid="coordinator-page">
      <div className="card coordinator-header">
        <h1>shared-brainstorm — coordinator</h1>
        <p className="muted" style={{ marginBottom: '.5rem' }}>
          {session.brief}
        </p>
        <div className="coordinator-roster">
          {session.participants.filter((p) => p.status === 'pending').map((p) => (
            <div key={p.id} className="coordinator-roster-pending">
              <span>{p.display_name}</span>
              <span className="muted"> wants to join</span>
              <button
                type="button"
                className="coordinator-roster-approve"
                aria-label={`Approve ${p.display_name}`}
                onClick={() => void handleApprove(p.id)}
              >
                Approve
              </button>
            </div>
          ))}
          {session.participants.filter((p) => p.status === 'approved').map((p) => (
            <div key={p.id} className="coordinator-roster-approved">
              <span className="participant">{p.display_name}</span>
              {/* TODO: Plan 04-03 — Kick button */}
              <button
                type="button"
                className="coordinator-roster-kick"
                aria-label={`Kick ${p.display_name} from the session`}
                onClick={() => void handleKick(p.id)}
              >
                Kick
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="coordinator-lock-toggle"
          aria-pressed={roomLocked}
          onClick={() => void handleLock(!roomLocked)}
        >
          {roomLocked ? '🔓 Unlock room' : '🔒 Lock room'}
        </button>
      </div>

      <DecisionsPanel decisions={session.decisions} />

      <div aria-live="polite" aria-relevant="additions text">
        {q !== null ? (
          <CoordinatorQuestionCard
            question={q}
            participants={session.participants}
            participantName={(id) => nameFor(session.participants, id)}
            selectedSuggestionId={cardFor(q.ticket_id).selectedSuggestionId}
            overrideText={cardFor(q.ticket_id).overrideText}
            recording={cardFor(q.ticket_id).recording}
            error={cardFor(q.ticket_id).error}
            onSelectSuggestion={(suggestionId) => onSelectSuggestion(q.ticket_id, suggestionId)}
            onChangeOverride={(text) => onChangeOverride(q.ticket_id, text)}
            onRecordSuggestion={() => onRecordSuggestion(q.ticket_id, q.suggestions)}
            onRecordOverride={() => onRecordOverride(q.ticket_id)}
          />
        ) : !hasContent ? (
          <div className="card">
            <p className="muted">Waiting for the AI host to post a question…</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
