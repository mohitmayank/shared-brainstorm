import type { WireSession, WireParticipant } from '../state.js';
import { QuestionCard } from '../components/QuestionCard.js';

interface Props {
  session: WireSession;
  me: WireParticipant;
}

export function Session({ session, me }: Props) {
  const q = session.current_question;
  const activeQuestion = q && q.status === 'broadcast' ? q : null;

  return (
    <>
      <div className="card">
        <h1>shared-brainstorm</h1>
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
        <QuestionCard question={activeQuestion} me={me} participants={session.participants} />
      )}

      {!activeQuestion && (
        <div className="join-empty-cta card" data-testid="join-empty-cta">
          <h2>You're in!</h2>
          <p className="muted">
            Waiting for the first question… You'll see it here the moment the host posts one.
          </p>
          <span className="join-connected-dot" />
          <span className="muted">Connected</span>
        </div>
      )}
    </>
  );
}
