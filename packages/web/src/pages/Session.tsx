import type { WireSession, WireParticipant } from '../state.js';
import { QuestionCard } from '../components/QuestionCard.js';
import { SessionStatusPill } from '../components/SessionStatusPill.js';

interface Props {
  session: WireSession;
  me: WireParticipant;
  sessionStatus: 'waiting' | 'question_open' | 'choosing' | 'done';
  presence: Record<string, { activity: string; expiresAt: number }>;
  onTyping: (questionId: string, state: 'start' | 'stop') => void;
}

export function Session({ session, me, sessionStatus, presence, onTyping }: Props) {
  const q = session.current_question;
  const activeQuestion = q && q.status === 'broadcast' ? q : null;

  return (
    <>
      <div className="card">
        <h1>shared-brainstorm</h1>
        <SessionStatusPill status={sessionStatus} />
        <p style={{ marginBottom: '.5rem' }}>{session.brief}</p>
        <div className="participants">
          {/* WR-03: show only approved participants. Kicked and pending participants
              are retained in the server's participants array (correct per design),
              but an approved participant must not see not-yet-approved joiners or
              removed teammates listed as active. Mirrors Coordinator.tsx filtering. */}
          {session.participants
            .filter((p) => p.status === 'approved')
            .map((p) => (
              <span key={p.id} className="participant">
                {p.display_name}
                {p.id === me.id && <span className="muted"> (you)</span>}
                {/* PRES-02: activity line — show for OTHER participants only */}
                {p.id !== me.id && (
                  <span
                    className="presence-activity-line"
                    data-testid={`presence-activity-${p.id}`}
                    aria-live="polite"
                  >
                    {presence[p.id]?.activity === 'typing' && (
                      <>
                        <span className="presence-typing-dot" aria-hidden="true" />
                        {p.display_name} is writing…
                      </>
                    )}
                  </span>
                )}
              </span>
            ))}
        </div>
      </div>

      {session.decisions.length > 0 && (
        <div className="card">
          <h2>Decisions</h2>
          <ul className="decisions">
            {session.decisions.map((d) => (
              <li key={d.question_id}>
                <span className="muted">{d.question}</span> → <strong>{d.answer}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      {activeQuestion && (
        <QuestionCard question={activeQuestion} me={me} participants={session.participants} onTyping={onTyping} />
      )}

      {sessionStatus === 'choosing' && (
        <p
          className="presence-coordinator-picking muted"
          data-testid="presence-coordinator-picking"
          role="status"
          aria-live="polite"
        >
          Coordinator is picking the final answer
        </p>
      )}

      {!activeQuestion && sessionStatus !== 'done' && (
        <div className="join-empty-cta card" data-testid="join-empty-cta">
          <h2>You're in!</h2>
          <p className="muted">
            AI is thinking… You'll see the first question here the moment it's posted.
          </p>
          <span className="join-connected-dot" aria-hidden="true" />
          <span className="muted">Connected</span>
        </div>
      )}
    </>
  );
}
