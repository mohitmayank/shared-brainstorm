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
  onSelectSuggestion: (suggestionId: string) => void;
  onChangeOverride: (text: string) => void;
  onRecordSuggestion: () => void;
  onRecordOverride: () => void;
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
  participantName,
  selectedSuggestionId,
  overrideText,
  recording,
  error,
  onSelectSuggestion,
  onChangeOverride,
  onRecordSuggestion,
  onRecordOverride,
}: CoordinatorQuestionCardProps) {
  const isResolved = question.status === 'resolved';
  const { suggestions, comments } = question;

  return (
    <article
      aria-label="Question"
      data-testid={`coordinator-question-${question.ticket_id}`}
      className="card coordinator-question-card"
    >
      <h2>Question</h2>
      <p style={{ marginBottom: '.5rem' }}>{question.text}</p>

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

      {isResolved && question.resolution && (
        <p style={{ marginBottom: '.5rem' }}>
          <strong>✓ Decided: {question.resolution.value}</strong>
          <span className="muted"> by Initiator ({question.resolution.source})</span>
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
              participantName={participantName(s.participant_id)}
              ticketId={question.ticket_id}
              isSelected={!isResolved && selectedSuggestionId === s.id}
              disabled={isResolved || recording}
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

      {!isResolved && (
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
