import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { WireQuestion, WireParticipant } from '../state.js';
import { postSuggestion, postComment } from '../lib/api.js';

interface Props {
  question: WireQuestion;
  me: WireParticipant;
  participants: WireParticipant[];
  /** Phase 5 (PRES-02): debounced typing notification callback — wired to WS in Plan 03. */
  onTyping?: (questionId: string, state: 'start' | 'stop') => void;
}

function nameFor(participants: WireParticipant[], id: string): string {
  return participants.find((p) => p.id === id)?.display_name ?? id;
}

export function QuestionCard({ question, me, participants, onTyping }: Props) {
  const mySuggestion = question.suggestions.find((s) => s.participant_id === me.id);
  const hasOptions = !!(question.options && question.options.length > 0);

  const [editing, setEditing] = useState<boolean>(mySuggestion === undefined);
  const [sugValue, setSugValue] = useState(mySuggestion?.value ?? '');
  const [sugRationale, setSugRationale] = useState(mySuggestion?.rationale ?? '');
  const [commentText, setCommentText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Phase 5 (PRES-02): typing debounce timer ref (T-05-11: at most one pending timeout).
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup on unmount — mirrors Coordinator.tsx fallbackTimers pattern exactly.
  useEffect(() => {
    return () => {
      if (typingTimer.current !== null) {
        clearTimeout(typingTimer.current);
        typingTimer.current = null;
      }
    };
  }, []);

  // Keep the form in sync if the question changes (e.g. a new round starts).
  useEffect(() => {
    setEditing(mySuggestion === undefined);
    setSugValue(mySuggestion?.value ?? '');
    setSugRationale(mySuggestion?.rationale ?? '');
    // We only want to reset when the *question identity* or *my submission*
    // changes, not on every render. mySuggestion.value can change locally
    // without us wanting to clobber the edit buffer — the WS event handler
    // updates the underlying `question` prop already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id, mySuggestion?.id]);

  const canInput = question.status === 'broadcast';

  async function handleSuggestion(e: FormEvent) {
    e.preventDefault();
    if (!sugValue.trim()) return;
    // Phase 5 (PRES-02): stop typing indicator before the API call.
    onTyping?.(question.id, 'stop');
    if (typingTimer.current !== null) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    setBusy(true);
    setErr(null);
    try {
      const args: { question_id: string; value: string; rationale?: string } = {
        question_id: question.id,
        value: sugValue.trim(),
      };
      if (sugRationale.trim()) args.rationale = sugRationale.trim();
      await postSuggestion(args);
      setEditing(false);
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function handleComment(e: FormEvent) {
    e.preventDefault();
    if (!commentText.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await postComment({ question_id: question.id, text: commentText.trim() });
      setCommentText('');
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setSugValue(mySuggestion?.value ?? '');
    setSugRationale(mySuggestion?.rationale ?? '');
    setEditing(true);
  }

  const otherSuggestions = question.suggestions.filter((s) => s.participant_id !== me.id);

  return (
    <div className="card">
      <h2>Current question</h2>
      <p style={{ marginBottom: '.5rem' }}>{question.text}</p>

      {question.status === 'broadcast' && (
        <p
          className="muted batch-progress"
          data-testid={`batch-progress-${question.id}`}
          role="status"
          aria-live="polite"
          style={{ marginBottom: '.25rem' }}
        >
          {new Set(question.suggestions.map((s) => s.participant_id)).size} answered
        </p>
      )}

      {question.recommendation && (
        <p className="muted" style={{ marginBottom: '.5rem' }}>
          AI recommendation: {question.recommendation}
        </p>
      )}

      {/* Your pick / form */}
      {canInput && !editing && mySuggestion && (
        <div className="card your-pick" style={{ marginBottom: '.75rem' }}>
          <strong>Your pick:</strong> {mySuggestion.value}
          {mySuggestion.rationale && (
            <span className="muted"> ({mySuggestion.rationale})</span>
          )}
          <div style={{ marginTop: '.35rem' }}>
            <button type="button" onClick={startEdit} disabled={busy}>
              Edit
            </button>
          </div>
        </div>
      )}

      {canInput && editing && (
        <form onSubmit={handleSuggestion} style={{ marginBottom: '.75rem' }}>
          {hasOptions ? (
            <div style={{ marginBottom: '.5rem' }}>
              {question.options!.map((o) => (
                <label
                  key={o.label}
                  style={{ display: 'block', marginBottom: '.25rem', cursor: 'pointer' }}
                >
                  <input
                    type="radio"
                    name={`opt-${question.id}`}
                    value={o.label}
                    checked={sugValue === o.label}
                    onChange={(e) => setSugValue(e.target.value)}
                    style={{ width: 'auto', marginRight: '.5rem' }}
                  />
                  <strong>{o.label}</strong>
                  {o.description && <span className="muted"> – {o.description}</span>}
                </label>
              ))}
            </div>
          ) : (
            <div style={{ marginBottom: '.35rem' }}>
              <input
                type="text"
                placeholder="Your answer"
                value={sugValue}
                onChange={(e) => {
                  setSugValue(e.target.value);
                  // Phase 5 (PRES-02): send typing start + debounce stop after 1.5s idle.
                  onTyping?.(question.id, 'start');
                  if (typingTimer.current !== null) clearTimeout(typingTimer.current);
                  typingTimer.current = setTimeout(() => {
                    typingTimer.current = null;
                    onTyping?.(question.id, 'stop');
                  }, 1500);
                }}
                onBlur={() => {
                  // Phase 5 (PRES-02): stop typing on blur.
                  onTyping?.(question.id, 'stop');
                  if (typingTimer.current !== null) {
                    clearTimeout(typingTimer.current);
                    typingTimer.current = null;
                  }
                }}
                maxLength={2000}
                autoFocus
              />
            </div>
          )}
          <input
            type="text"
            placeholder="Rationale (optional)"
            value={sugRationale}
            onChange={(e) => setSugRationale(e.target.value)}
            maxLength={2000}
            style={{ marginBottom: '.35rem' }}
          />
          <div className="row">
            <button type="submit" disabled={busy || !sugValue.trim()}>
              {mySuggestion ? 'Update pick' : 'Submit'}
            </button>
            {mySuggestion && (
              <button
                type="button"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}

      {otherSuggestions.length > 0 && (
        <>
          <h3>Other suggestions</h3>
          <ul className="suggestions">
            {otherSuggestions.map((s) => (
              <li key={s.id}>
                <strong>{nameFor(participants, s.participant_id)}</strong>: {s.value}
                {s.rationale && <span className="muted"> ({s.rationale})</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {question.comments.length > 0 && (
        <>
          <h3>Comments</h3>
          <ul className="comments">
            {question.comments.map((c) => (
              <li key={c.id}>
                <strong>{nameFor(participants, c.participant_id)}</strong>: {c.text}
              </li>
            ))}
          </ul>
        </>
      )}

      {canInput && (
        <form onSubmit={handleComment}>
          <div className="row">
            <input
              type="text"
              placeholder="Add a comment"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              maxLength={4000}
            />
            <button type="submit" disabled={busy || !commentText.trim()}>
              Comment
            </button>
          </div>
        </form>
      )}

      {err && (
        <p className="error" style={{ marginTop: '.5rem' }}>
          {err}
        </p>
      )}

      {question.status !== 'broadcast' && (
        <p className="muted" style={{ marginTop: '.5rem' }}>
          Status: {question.status}
          {question.resolution && ` — Answer: ${question.resolution.value}`}
        </p>
      )}
    </div>
  );
}
