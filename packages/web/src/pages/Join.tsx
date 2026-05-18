import { useState } from 'react';
import type { FormEvent } from 'react';

export interface JoinProps {
  defaultName: string;
  defaultCode: string;
  onSubmit: (name: string, code: string) => Promise<void>;
  error: string | null;
}

export function Join({ defaultName, defaultCode, onSubmit, error }: JoinProps) {
  const [name, setName] = useState(defaultName);
  const [code, setCode] = useState(defaultCode);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSubmit(name.trim(), code.trim());
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
        <div style={{ marginBottom: '.75rem' }}>
          <label htmlFor="code">Join code (6 digits)</label>
          <input
            id="code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            pattern="\d{6}"
            inputMode="numeric"
            required
          />
        </div>
        {error && (
          <p className="error" style={{ marginBottom: '.5rem' }}>
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || name.trim().length === 0 || code.length !== 6}>
          {busy ? 'Joining…' : 'Join session'}
        </button>
      </form>
    </div>
  );
}
