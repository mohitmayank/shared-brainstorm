import { useCallback, useState } from 'react';
import type { WireSession, WireParticipant, WireSuggestion } from '../state.js';
import { postCoordinatorAnswer } from '../lib/api.js';
import { DecisionsPanel } from '../components/coordinator/DecisionsPanel.js';
import { CoordinatorQuestionCard } from '../components/coordinator/CoordinatorQuestionCard.js';

interface CoordinatorProps {
  session: WireSession;
  isCoordinator: true; // gate enforced upstream in App.tsx
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
export function Coordinator({ session }: CoordinatorProps) {
  const q = session.current_question;
  const [cards, setCards] = useState<Record<string, CardState>>({});

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
        // WR-03: leave `recording: true` on success. The server has already
        // resolved the question, so the buttons must stay disabled until the
        // `question_resolved` WS event flips the card to its resolved variant
        // via the reducer (controls are gated on `isResolved || recording`).
        // Clearing `recording` synchronously here reopened a window where a
        // fast second pick fired a redundant POST that the server rejects with
        // 409 — surfacing a confusing "already resolved" error on the happy
        // path. Only the error branch below re-enables the controls.
      } catch (e: unknown) {
        const status = (e as { status?: number }).status;
        const msg =
          status === 409
            ? 'That question was already resolved.'
            : `Couldn't record that answer — try again. (${status ?? 'network'})`;
        patchCard(ticketId, { recording: false, error: msg });
      }
    },
    [patchCard],
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

  const hasContent = q !== null || session.decisions.length > 0;

  return (
    <main aria-label="Coordinator view" data-testid="coordinator-page">
      <div className="card coordinator-header">
        <h1>shared-brainstorm — coordinator</h1>
        <p className="muted" style={{ marginBottom: '.5rem' }}>
          {session.brief}
        </p>
        <div className="participants">
          {session.participants.map((p) => (
            <span key={p.id} className="participant">
              {p.display_name}
            </span>
          ))}
        </div>
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
