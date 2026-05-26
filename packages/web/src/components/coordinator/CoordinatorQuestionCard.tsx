import type { WireQuestion, WireParticipant } from '../../state.js';
import { SuggestionRow } from './SuggestionRow.js';
import { CommentRow } from './CommentRow.js';

interface CoordinatorQuestionCardProps {
  question: WireQuestion;
  participants: WireParticipant[];
  participantName: (participantId: string) => string;
  selectedSuggestionId: string | undefined;
  overrideText: string;
  recording: boolean;
  error: string | null;
  // Coordinator-as-planner: free-text answer the coordinator contributes to the pool.
  addAnswerText: string;
  // D-08: locally-patched resolution for the rejected-pick → resolved flip path.
  // Distinct from question.resolution which comes via WS events.
  resolvedBy?: { value: string; source: string; picked_by: string };
  onSelectSuggestion: (suggestionId: string) => void;
  onChangeOverride: (text: string) => void;
  onRecordSuggestion: () => void;
  onRecordOverride: () => void;
  onChangeAddAnswer: (text: string) => void;
  onAddAnswer: () => void;
}

/**
 * One question card on the coordinator timeline (UI-SPEC Per-Component Contract).
 *
 * Resolved variant (`question.status === 'resolved'`): shows the decided answer,
 * renders suggestions/comments read-only, and exposes a focusable
 * `coordinator-resolved-marker` span so AT users hear the flip.
 *
 * Unresolved variant: a radiogroup of suggestions + the Record affordances. The
 * parent owns the POST; this component only fires the callbacks and renders the
 * `recording`/`error` UI. The card flips between variants when the reducer
 * applies the incoming `question_resolved` event — no local resolved state.
 */
export function CoordinatorQuestionCard({
  question,
  participants,
  participantName,
  selectedSuggestionId,
  overrideText,
  recording,
  error,
  addAnswerText,
  resolvedBy,
  onSelectSuggestion,
  onChangeOverride,
  onRecordSuggestion,
  onRecordOverride,
  onChangeAddAnswer,
  onAddAnswer,
}: CoordinatorQuestionCardProps) {
  const isResolved = question.status === 'resolved';
  // D-08: prefer question.resolution (WS path), fall back to resolvedBy (409 flip path).
  const effectiveResolution = question.resolution ?? resolvedBy ?? null;
  // D-08: a 409 flip sets resolvedBy before the question_resolved WS event flips
  // question.status — so `isResolved` alone leaves the pick UI live in the gap
  // (worst in the degraded-WS case where 409s happen). `settled` closes that
  // window: the question is decided once EITHER signal lands, so the Record
  // buttons disappear and suggestion rows lock immediately on the flip.
  const settled = isResolved || !!resolvedBy;
  // Attribution: picked_by may be absent for pre-Phase-9 events — degrade gracefully.
  const who = effectiveResolution?.picked_by;
  const { suggestions, comments } = question;
  // Coordinator-as-planner: when the question carries options, the coordinator
  // picks from them like any participant (QuestionCard) instead of retyping a
  // label into the free-text box.
  const hasOptions = !!(question.options && question.options.length > 0);
  // Coordinator-as-planner: resolve a suggestion's display name, preferring the
  // embedded coordinator display_name (no roster entry) over the roster lookup.
  const nameForSuggestion = (s: WireQuestion['suggestions'][number]): string =>
    s.author_kind === 'coordinator' ? (s.display_name ?? 'Coordinator') : participantName(s.participant_id);

  return (
    <article
      aria-label="Question"
      data-testid={`coordinator-question-${question.ticket_id}`}
      className="card coordinator-question-card"
    >
      <h2>Question</h2>
      <p style={{ marginBottom: '.5rem' }}>{question.text}</p>

      {question.status === 'broadcast' &&
        (() => {
          // Coordinator-as-planner: the coordinator's own suggestion is NOT a
          // participant answer — exclude it from the "N/M answered" count so the
          // coordinator's contribution never produces e.g. "3/2 answered".
          const answeredParticipants = [
            ...new Map(
              question.suggestions
                .filter((s) => s.author_kind !== 'coordinator')
                .map((s) => [s.participant_id, s]),
            ).values(),
          ];
          const approvedCount = participants.filter((p) => p.status === 'approved').length;
          const names = answeredParticipants
            .slice(0, 3)
            .map((s) => participantName(s.participant_id));
          const overflow = Math.max(0, answeredParticipants.length - 3);
          const nameStr =
            overflow > 0 ? `${names.join(', ')} +${overflow} more` : names.join(', ');
          return (
            <p
              className="muted batch-progress"
              data-testid={`batch-progress-${question.id}`}
              role="status"
              aria-live="polite"
              style={{ marginBottom: '.25rem' }}
            >
              {answeredParticipants.length === 0
                ? `0/${approvedCount} answered — waiting on participants`
                : `${answeredParticipants.length}/${approvedCount} answered — ${nameStr}`}
            </p>
          );
        })()}

      {question.recommendation && (
        <p className="muted" style={{ marginBottom: '.5rem' }}>
          AI recommendation: {question.recommendation}
        </p>
      )}

      {question.options && question.options.length > 0 && (
        <div className="participants" style={{ marginBottom: '.5rem' }}>
          {question.options.map((o) => (
            <span key={o.label} className="participant">
              {o.label}
              {o.description && <span className="muted"> – {o.description}</span>}
            </span>
          ))}
        </div>
      )}

      {settled && effectiveResolution && (
        <p style={{ marginBottom: '.5rem' }}>
          <strong>✓ Decided: {effectiveResolution.value}</strong>
          <span className="muted">
            {' '}chosen{who ? ` by ${who}` : ''} ({effectiveResolution.source})
          </span>
          <span
            tabIndex={-1}
            data-testid="coordinator-resolved-marker"
            aria-label="Question resolved"
          />
        </p>
      )}

      <h3>Suggestions ({suggestions.length})</h3>
      {suggestions.length === 0 ? (
        <p className="muted">No suggestions yet — waiting on participants.</p>
      ) : (
        <div role="radiogroup" aria-label="Pick a suggestion">
          {suggestions.map((s, i) => (
            <SuggestionRow
              key={s.id}
              suggestion={s}
              participantName={nameForSuggestion(s)}
              ticketId={question.ticket_id}
              isSelected={!settled && selectedSuggestionId === s.id}
              disabled={settled || recording}
              index={i}
              onSelect={() => onSelectSuggestion(s.id)}
            />
          ))}
        </div>
      )}

      {comments.length > 0 && (
        <>
          <h3>Comments ({comments.length})</h3>
          <ul className="comments">
            {comments.map((c) => (
              <CommentRow
                key={c.id}
                comment={c}
                participantName={participantName(c.participant_id)}
              />
            ))}
          </ul>
        </>
      )}

      {/* CHATAI-01 / CHATAI-02: read-only clarification thread.
          Clarifications are a SEPARATE array — NEVER mixed into the suggestion
          radiogroup above. The coordinator sees them as context only. */}
      {question.clarifications.length > 0 && (
        <div className="clarify-thread" data-testid={`clarify-thread-${question.id}`}>
          <h3>Ask the AI</h3>
          <p
            className="muted clarify-readonly-note"
            data-testid="clarify-readonly-note"
          >
            Read-only — clarifications don't affect the final answer.
          </p>
          <ul className="clarify-list">
            {question.clarifications.map((cl) => (
              <li key={cl.id}>
                <strong>{participantName(cl.participant_id)}</strong>: {cl.text}
                {cl.answer !== undefined ? (
                  <div>
                    <span aria-hidden="true">🤖</span> AI: {cl.answer}
                  </div>
                ) : (
                  <span
                    className="muted clarify-pending"
                    data-testid={`clarify-pending-${cl.id}`}
                    role="status"
                    aria-live="polite"
                  >
                    <span className="presence-typing-dot" aria-hidden="true" /> Waiting for the AI…
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!settled && (
        <>
          <h3>Pick the final answer</h3>
          <div className="coordinator-pick-actions">
            <button
              type="button"
              data-testid="coordinator-record-suggestion"
              aria-label="Record selected suggestion as final answer"
              disabled={!selectedSuggestionId || recording}
              onClick={onRecordSuggestion}
            >
              {recording ? 'Recording…' : 'Record this'}
            </button>
            <button
              type="button"
              data-testid="coordinator-synthesize"
              aria-label="Synthesize answer (deferred — not available)"
              disabled
            >
              Synthesize
            </button>
            <span className="muted coordinator-synth-note">(LLM synth — deferred)</span>
          </div>
          <p className="muted" style={{ marginTop: '.25rem' }}>
            Select a suggestion above to enable.
          </p>

          {/* Coordinator-as-planner: contribute your own answer to the pool. This
              is VISUALLY DISTINCT from the override/finalize block below — it does
              NOT resolve the question; the answer joins the suggestion list and can
              be picked later like any other candidate. */}
          <div
            className="coordinator-add-answer"
            data-testid="coordinator-add-answer"
            style={{ marginTop: '.75rem' }}
          >
            <h3>Add your answer (as a planner)</h3>
            <p className="muted" style={{ marginBottom: '.35rem' }}>
              Seed the pool with your own candidate — it joins the suggestions above.
            </p>
            {hasOptions ? (
              // Mirror the participant radio group: select an option instead of
              // retyping its label. The chosen label populates `addAnswerText`.
              <div role="radiogroup" aria-label="Pick an option to add" style={{ marginBottom: '.35rem' }}>
                {question.options!.map((o) => (
                  <label
                    key={o.label}
                    data-testid={`coordinator-add-answer-option-${o.label}`}
                    style={{ display: 'block', marginBottom: '.25rem', cursor: 'pointer' }}
                  >
                    <input
                      type="radio"
                      name={`coordinator-add-answer-${question.id}`}
                      value={o.label}
                      checked={addAnswerText === o.label}
                      onChange={() => onChangeAddAnswer(o.label)}
                      style={{ width: 'auto', marginRight: '.5rem' }}
                    />
                    <strong>{o.label}</strong>
                    {o.description && <span className="muted"> – {o.description}</span>}
                  </label>
                ))}
              </div>
            ) : (
              <textarea
                data-testid="coordinator-add-answer-textarea"
                aria-label="Add your answer as a suggestion"
                maxLength={2000}
                value={addAnswerText}
                onChange={(e) => onChangeAddAnswer(e.target.value)}
                style={{ marginBottom: '.35rem' }}
              />
            )}
            <div>
              <button
                type="button"
                data-testid="coordinator-add-answer-submit"
                aria-label="Add your answer to the suggestions"
                disabled={!addAnswerText.trim() || recording}
                onClick={onAddAnswer}
              >
                Add to suggestions
              </button>
            </div>
          </div>

          <h3 style={{ marginTop: '.75rem' }}>Or write your own answer</h3>
          <textarea
            data-testid="coordinator-override-textarea"
            aria-label="Override answer"
            maxLength={4000}
            value={overrideText}
            onChange={(e) => onChangeOverride(e.target.value)}
            style={{ marginBottom: '.35rem' }}
          />
          <div>
            <button
              type="button"
              data-testid="coordinator-record-override"
              aria-label="Record typed override as final answer"
              disabled={!overrideText.trim() || recording}
              onClick={onRecordOverride}
            >
              {recording ? 'Recording…' : 'Record override'}
            </button>
          </div>

          {error && (
            <p
              className="error coordinator-error"
              role="alert"
              data-testid="coordinator-pick-error"
              style={{ marginTop: '.5rem' }}
            >
              {error}
            </p>
          )}
        </>
      )}
    </article>
  );
}
