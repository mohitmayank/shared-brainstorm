import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..'); // packages/server/src/install -> repo root

const PAIRS = [
  [
    resolve(root, 'skills/claude-code/shared-brainstorm/SKILL.md'),
    resolve(root, 'packages/server/skills/claude-code/shared-brainstorm/SKILL.md'),
  ],
  [
    resolve(root, 'skills/_generic/prompt-fragment.md'),
    resolve(root, 'packages/server/skills/_generic/prompt-fragment.md'),
  ],
] as const;

describe('skill mirror — root and bundled copies must be byte-identical (lesson #12)', () => {
  for (const [a, b] of PAIRS) {
    it(`${a} === ${b}`, async () => {
      const [ra, rb] = await Promise.all([readFile(a, 'utf8'), readFile(b, 'utf8')]);
      expect(rb).toBe(ra);
    });
  }

  it('both claude-code SKILL.md copies contain the Redaction section (REL-10)', async () => {
    const raw = await readFile(PAIRS[0][0], 'utf8');
    expect(raw).toMatch(/^## Redaction\b/m);
    expect(raw).toMatch(/best-effort/i);
    expect(raw).toMatch(/SHARED_BRAINSTORM_NO_REDACT/);
  });

  it('both _generic prompt-fragment.md copies contain the Redaction section (REL-10)', async () => {
    const raw = await readFile(PAIRS[1][0], 'utf8');
    expect(raw).toMatch(/^## Redaction\b/m);
    expect(raw).toMatch(/best-effort/i);
    expect(raw).toMatch(/SHARED_BRAINSTORM_NO_REDACT/);
  });
});
