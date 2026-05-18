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
          {session.participants.map((p) => (
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
        <div className="card">
          <p className="muted">Waiting for a question from the AI host…</p>
        </div>
      )}
    </>
  );
}
