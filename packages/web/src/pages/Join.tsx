import { useState } from 'react';
import type { FormEvent } from 'react';

export interface JoinProps {
  defaultName: string;
  onSubmit: (name: string) => Promise<void>;
  error: string | null;
}

export function Join({ defaultName, onSubmit, error }: JoinProps) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [nameOverride, setNameOverride] = useState(false);

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
        {defaultName && !nameOverride && (
          <p className="muted" style={{ marginBottom: '.5rem' }}>
            Joining as <strong>{defaultName}</strong>.{' '}
            <button
              type="button"
              onClick={() => setNameOverride(true)}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              Not you? Change name
            </button>
          </p>
        )}
        {error && (
          <p className="error" style={{ marginBottom: '.5rem' }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || name.trim().length === 0}>
          {busy ? 'Joining…' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
