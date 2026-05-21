// packages/server/src/install/messaging.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../../../');
const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');

// ---------------------------------------------------------------------------
// DISC-01: README messaging
// ---------------------------------------------------------------------------

describe('DISC-01: README messaging', () => {
  it('contains the primary value prop string', () => {
    expect(readme.includes('live in their browser, in seconds, with nothing to install')).toBe(true);
  });

  it('contains the concrete Postgres/DynamoDB example', () => {
    expect(readme.includes('Postgres or DynamoDB')).toBe(true);
  });

  it('does not contain stale 6-digit join code references', () => {
    expect(readme.includes('6-digit')).toBe(false);
  });

  it('does not contain stale join code references', () => {
    expect(readme.toLowerCase().includes('join code')).toBe(false);
  });

  it('does not use generic team collaboration phrasing', () => {
    expect(readme.includes('team collaboration')).toBe(false);
  });

  it('contains absolute GitHub demo link', () => {
    expect(readme.includes('github.com/mohitmayank/shared-brainstorm')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DISC-01: install success message
// ---------------------------------------------------------------------------

describe('DISC-01: install success message', () => {
  let stdoutCalls: string[];

  beforeEach(() => {
    stdoutCalls = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runInstall claude-code emits what-to-do-next line', async () => {
    await runInstall('claude-code');
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('runInstall codex emits what-to-do-next line', async () => {
    await runInstall('codex');
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('runInstall opencode emits what-to-do-next line', async () => {
    await runInstall('opencode');
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('runInstall gemini-cli emits what-to-do-next line', async () => {
    await runInstall('gemini-cli');
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });
});
