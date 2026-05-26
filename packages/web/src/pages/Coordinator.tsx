import { useCallback, useEffect, useRef, useState } from 'react';
import { CoordinatorAnswerErrorBody } from '@shared-brainstorm/shared';
import type { WireSession, WireParticipant, WireSuggestion } from '../state.js';
import {
  postCoordinatorAnswer,
  postCoordinatorSuggestion,
  postApprove,
  postKick,
  postLock,
} from '../lib/api.js';
import { DecisionsPanel } from '../components/coordinator/DecisionsPanel.js';
import { CoordinatorQuestionCard } from '../components/coordinator/CoordinatorQuestionCard.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { IdleNudgeBanner } from '../components/IdleNudgeBanner.js';
import { EmptyRoomNotice } from '../components/EmptyRoomNotice.js';
import { ShareLinkButton } from '../components/ShareLinkButton.js';

interface CoordinatorProps {
  session: WireSession;
  isCoordinator: true; // gate enforced upstream in App.tsx
  roomLocked: boolean;
  sessionStatus: 'waiting' | 'question_open' | 'choosing' | 'done';
  onPicking: (ticketId: string, state: 'start' | 'stop') => void;
  /** CHAT-01: WS send function for the coordinator's chat messages. */
  onChat: (text: string) => void;
  /** WR-03: whether the WS is currently open — gates the ChatPanel Send affordance. */
  wsConnected: boolean;
  /** Phase 11 (ROOM-02): set when server emits room_idle_nudge for the current question. */
  idleNudge: { question_id: string } | null;
  /** Phase 11 (ROOM-03): set when all approved participants have disconnected. */
  roomEmpty: boolean;
  /**
   * Phase 14 (SHARE-01/02): participant join URL from UiState.publicUrl; null when server is
   * pre-Phase-14 or URL not yet known. When non-null, renders the ShareLinkButton in the header.
   */
  publicUrl: string | null;
}

/** Per-ticket pick UI state (UI-SPEC Per-Component Contract). */
interface CardState {
  selectedSuggestionId?: string;
  overrideText: string;
  recording: boolean;
  error: string | null;
  // Coordinator-as-planner: in-progress free-text answer the coordinator is
  // contributing to the suggestion pool (separate from the override text).
  addAnswerText: string;
  // D-08: locally-patched resolution for the rejected-pick → resolved flip.
  // Distinct from question.resolution which comes via WS events.
  resolvedBy?: { value: string; source: string; picked_by: string };
}

const EMPTY_CARD: CardState = {
  overrideText: '',
  recording: false,
  error: null,
  addAnswerText: '',
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
export function Coordinator({ session, roomLocked, sessionStatus, onPicking, onChat, wsConnected, idleNudge, roomEmpty, publicUrl }: CoordinatorProps) {
  const openQuestions = session.questions ?? [];
  const [cards, setCards] = useState<Record<string, CardState>>({});
  // Phase 11 (ROOM-02): dismiss-ack keyed by question_id. Re-arms automatically when
  // a room_idle_nudge for a different question arrives (new question_id breaks equality).
  // Mirrors the dismissedTunnelUrl pattern in App.tsx (Pitfall 3).
  const [dismissedIdleNudgeQuestionId, setDismissedIdleNudgeQuestionId] = useState<string | null>(null);

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

  // When a question is resolved (the reducer removes it from questions[]),
  // clear that ticket's pending fallback timer so it can no longer patch
  // the now-terminal card.
  const activeTicketIds = new Set(openQuestions.map((q) => q.ticket_id));
  useEffect(() => {
    for (const ticketId of [...fallbackTimers.current.keys()]) {
      if (!activeTicketIds.has(ticketId)) clearFallbackTimer(ticketId);
    }
    // Stable serialized set for dependency comparison (RESEARCH.md Pitfall 7)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify([...activeTicketIds].sort()), clearFallbackTimer]);

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
      // PRES-03: the coordinator is now actively picking — signal 'choosing' so
      // participants see "Coordinator is picking the final answer" DURING deliberation,
      // not just for the few ms of the record() fetch. recordAnswer later resolves the
      // question (choosing → resolved), which clears the caption.
      onPicking(ticketId, 'start');
    },
    [patchCard, onPicking],
  );

  const onChangeOverride = useCallback(
    (ticketId: string, text: string) => {
      patchCard(ticketId, { overrideText: text });
    },
    [patchCard],
  );

  const onChangeAddAnswer = useCallback(
    (ticketId: string, text: string) => {
      patchCard(ticketId, { addAnswerText: text });
    },
    [patchCard],
  );

  // Coordinator-as-planner: contribute the coordinator's own answer to the pool.
  // This is NOT a finalize — it does not set `recording` and does not resolve the
  // question. The new suggestion arrives via the `suggestion_added` broadcast and
  // can then be selected + recorded with source 'suggestion' via the pick path.
  const onAddAnswer = useCallback(
    async (ticketId: string): Promise<void> => {
      const value = (cards[ticketId]?.addAnswerText ?? '').trim();
      if (!value) return;
      try {
        await postCoordinatorSuggestion({ ticket_id: ticketId, value });
        patchCard(ticketId, { addAnswerText: '', error: null });
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        const msg =
          status === 409
            ? 'That question was already resolved.'
            : `Couldn't add that answer — try again. (${status ?? 'network'})`;
        patchCard(ticketId, { error: msg });
      }
    },
    [cards, patchCard],
  );

  const record = useCallback(
    async (
      ticketId: string,
      value: string,
      source: 'suggestion' | 'override',
    ): Promise<void> => {
      patchCard(ticketId, { recording: true, error: null });
      onPicking(ticketId, 'start'); // PRES-03: signal 'choosing' status to participants
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
        // onPicking 'stop' is NOT sent on success — recordAnswer transitions
        // the session status server-side via session_status_changed event.
        clearFallbackTimer(ticketId);
        fallbackTimers.current.set(
          ticketId,
          setTimeout(() => {
            fallbackTimers.current.delete(ticketId);
            patchCard(ticketId, { recording: false });
          }, RECORD_FALLBACK_REENABLE_MS),
        );
      } catch (e: unknown) {
        onPicking(ticketId, 'stop'); // PRES-03: clear 'choosing' on failure so participants aren't stuck
        const status = (e as { status?: number }).status;
        if (status === 409) {
          // D-08: read winning resolution and flip card to resolved variant instead
          // of showing the dead-end "already resolved" error toast (UI-SPEC).
          // WR-02: narrow the caught body with the shared Zod schema instead of an
          // `as` cast so a server-side shape drift fails the safeParse (→ generic
          // error copy) rather than silently producing an undefined resolution.
          const parsedBody = CoordinatorAnswerErrorBody.safeParse((e as { body?: unknown }).body);
          if (parsedBody.success && parsedBody.data.resolution) {
            // Pitfall 3 (WR-06): clear fallback timer BEFORE patching so it cannot
            // re-enable recording on a now-terminal card.
            clearFallbackTimer(ticketId);
            patchCard(ticketId, { recording: false, resolvedBy: parsedBody.data.resolution });
            return;
          }
          // Fallback: no resolution in body (old server without D-08) — show error copy.
          patchCard(ticketId, { recording: false, error: 'That question was already resolved.' });
          return;
        }
        patchCard(ticketId, {
          recording: false,
          error: `Couldn't record that answer — try again. (${status ?? 'network'})`,
        });
      }
    },
    [patchCard, clearFallbackTimer, onPicking],
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

  const hasContent = openQuestions.length > 0 || session.decisions.length > 0;

  return (
    <main aria-label="Coordinator view" data-testid="coordinator-page">
      <div className="card coordinator-header">
        <h1>shared-brainstorm — coordinator</h1>
        <SessionStatusPill status={sessionStatus} />
        {idleNudge !== null && idleNudge.question_id !== dismissedIdleNudgeQuestionId && (
          <IdleNudgeBanner onDismiss={() => setDismissedIdleNudgeQuestionId(idleNudge.question_id)} />
        )}
        {publicUrl !== null && <ShareLinkButton publicUrl={publicUrl} />}
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
          {session.participants.filter((p) => p.status === 'kicked').map((p) => (
            <div key={p.id} className="coordinator-roster-kicked">
              <span className="participant muted">{p.display_name}</span>
              <span className="muted"> removed</span>
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

      {/* CHAT-01: session-level room chat — coordinator always allowed to post */}
      <ChatPanel
        chat={session.chat ?? []}
        me={null}
        isCoordinator={true}
        myStatus={null}
        onSend={onChat}
        connected={wsConnected}
      />

      <div aria-live="polite" aria-relevant="additions text">
        {/* Phase 11 (ROOM-03): show empty-room notice above question cards when all approved participants left */}
        {roomEmpty && openQuestions.some((q) => q.status === 'broadcast') && (
          <EmptyRoomNotice />
        )}
        {openQuestions.length > 0 ? (
          <div data-testid="batch-question-list">
            {/* Gate the hint on UNRESOLVED questions only — once a batch is partially
                resolved, resolved cards stay in openQuestions (flip-in-place), so
                counting all of them would keep the hint up after only one remains open. */}
            {openQuestions.filter((q) => q.status === 'broadcast').length > 1 && (
              <p className="muted batch-hint" data-testid="batch-hint" role="note">
                Resolve each question independently — picking one won't affect the others.
              </p>
            )}
            {openQuestions.map((q) => (
              <CoordinatorQuestionCard
                key={q.ticket_id}
                question={q}
                participants={session.participants}
                participantName={(id) => nameFor(session.participants, id)}
                selectedSuggestionId={cardFor(q.ticket_id).selectedSuggestionId}
                overrideText={cardFor(q.ticket_id).overrideText}
                recording={cardFor(q.ticket_id).recording}
                error={cardFor(q.ticket_id).error}
                addAnswerText={cardFor(q.ticket_id).addAnswerText}
                {...(cardFor(q.ticket_id).resolvedBy !== undefined
                  ? { resolvedBy: cardFor(q.ticket_id).resolvedBy }
                  : {})}
                onSelectSuggestion={(suggestionId) => onSelectSuggestion(q.ticket_id, suggestionId)}
                onChangeOverride={(text) => onChangeOverride(q.ticket_id, text)}
                onRecordSuggestion={() => onRecordSuggestion(q.ticket_id, q.suggestions)}
                onRecordOverride={() => onRecordOverride(q.ticket_id)}
                onChangeAddAnswer={(text) => onChangeAddAnswer(q.ticket_id, text)}
                onAddAnswer={() => void onAddAnswer(q.ticket_id)}
              />
            ))}
          </div>
        ) : !hasContent ? (
          <div className="card">
            <p className="muted">Waiting for the AI host to post a question…</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
