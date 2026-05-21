// packages/web/src/pages/Join.test.tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, 'Join.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// DISC-01: Join.tsx copy
// ---------------------------------------------------------------------------

describe('DISC-01: Join.tsx copy', () => {
  it('contains the value-prop tagline', () => {
    expect(
      src.includes('A teammate is running an AI brainstorm and wants your input.'),
    ).toBe(true);
  });

  it('contains the what-happens-next reassurance', () => {
    expect(src.includes("The host lets you in, then you'll see their questions.")).toBe(true);
  });

  it('preserves the remembered-name affordance', () => {
    expect(src.includes('Not you? Change name')).toBe(true);
  });

  it('preserves the Continue button', () => {
    expect(src.includes('Continue')).toBe(true);
  });
});
