import { useState, type FormEvent } from 'react';
import type { WireParticipant, WireChatEntry } from '../state.js';

interface ChatPanelProps {
  chat: WireChatEntry[];
  /** null for the coordinator (no participant identity). */
  me: WireParticipant | null;
  isCoordinator: boolean;
  /** null for the coordinator. */
  myStatus: 'pending' | 'approved' | 'kicked' | null;
  onSend: (text: string) => void;
}

/**
 * CHAT-01: Session-level room chat panel. Visually and structurally distinct
 * from per-question suggestion/comment streams.
 *
 * Coordinator messages are labeled "(host)". Compose input is only rendered
 * for the coordinator or approved participants — pending/kicked participants
 * can read the chat but cannot post (canPost gate).
 *
 * The chat-messages region has a fixed max-height with internal scroll
 * (layout-shift-free per UI-SPEC §51).
 */
export function ChatPanel({ chat, me, isCoordinator, myStatus, onSend }: ChatPanelProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canPost = isCoordinator || myStatus === 'approved';

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      onSend(text.trim());
      setText('');
    } catch {
      setErr("Couldn't send that — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card chat-panel" data-testid="chat-panel">
      <h3>Room chat</h3>
      <div
        className="chat-messages"
        data-testid="chat-messages"
        role="log"
        aria-live="polite"
        style={{ maxHeight: '18rem', overflowY: 'auto' }}
      >
        {chat.length === 0 ? (
          <p className="muted">No messages yet — say hello to the room.</p>
        ) : (
          <ul>
            {chat.map((entry) => (
              <li
                key={entry.id}
                className="chat-message"
                data-testid={`chat-message-${entry.id}`}
                data-actor={entry.actor_kind}
              >
                <strong>
                  {entry.display_name}
                  {entry.actor_kind === 'coordinator' && ' (host)'}
                  {me && entry.actor_id === me.id && ' (you)'}
                </strong>
                {': '}
                {entry.text}
                <span className="muted" style={{ marginLeft: '.5rem', fontSize: '.875rem' }}>
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {canPost && (
        <form onSubmit={handleSend} className="chat-compose">
          <div className="row">
            <input
              data-testid="chat-input"
              type="text"
              placeholder="Message the room…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4000}
            />
            <button
              data-testid="chat-send"
              type="submit"
              disabled={busy || !text.trim()}
            >
              Send
            </button>
          </div>
        </form>
      )}
      {err && <p className="error">{err}</p>}
    </section>
  );
}
