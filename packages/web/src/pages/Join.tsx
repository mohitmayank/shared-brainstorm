import { useState } from 'react';
import type { FormEvent } from 'react';

export interface JoinProps {
  defaultName: string;
  onSubmit: (name: string) => Promise<void>;
  error: string | null;
  /** Set to true when the server returned 423 (room locked by the coordinator). */
  locked?: boolean;
}

export function Join({ defaultName, onSubmit, error, locked }: JoinProps) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(name.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: '2rem' }}>
      <h1>shared-brainstorm</h1>
      {locked ? (
        <p className="error">The session is currently locked. Ask the host to unlock it and try again.</p>
      ) : (
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '.75rem' }}>
            <label htmlFor="name">Display name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              required
              autoFocus
            />
          </div>
          {error && (
            <p className="error" style={{ marginBottom: '.5rem' }}>
              {error}
            </p>
          )}
          <button type="submit" disabled={busy || name.trim().length === 0}>
            {busy ? 'Joining…' : 'Join session'}
          </button>
        </form>
      )}
    </div>
  );
}
