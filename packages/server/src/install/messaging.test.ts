// packages/server/src/install/messaging.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
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

  it('embeds the YouTube demo video', () => {
    expect(readme.includes('youtu.be/cP9V4pDTtVQ')).toBe(true);
  });

  it('no longer references the removed interactive walkthrough', () => {
    expect(readme.includes('htmlpreview.github.io')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DISC-01: install success message
// ---------------------------------------------------------------------------

describe('DISC-01: install success message', () => {
  let stdoutCalls: string[];
  let tmpHome: string;
  // Deterministic probe so the cloudflared advisory doesn't shell out to
  // which/where on the test machine. Pretend cloudflared is installed.
  const probe = async (cmd: string): Promise<boolean> => cmd === 'cloudflared';

  beforeEach(() => {
    // Isolate filesystem writes to a temp dir — prevents runInstall from
    // writing to ~/.claude.json, ~/.shared-brainstorm/prompts/, etc.
    tmpHome = mkdtempSync(join(tmpdir(), 'sb-msg-test-'));
    stdoutCalls = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutCalls.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('runInstall claude-code emits what-to-do-next line', async () => {
    await runInstall('claude-code', { home: tmpHome, probe });
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('runInstall codex emits what-to-do-next line', async () => {
    await runInstall('codex', { home: tmpHome, probe });
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('runInstall opencode emits what-to-do-next line', async () => {
    await runInstall('opencode', { home: tmpHome, probe });
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('runInstall gemini-cli emits what-to-do-next line', async () => {
    await runInstall('gemini-cli', { home: tmpHome, probe });
    const combined = stdoutCalls.join('');
    expect(combined.includes('ask your agent to brainstorm')).toBe(true);
  });

  it('emits the cloudflared advisory (found, since the probe reports it)', async () => {
    await runInstall('claude-code', { home: tmpHome, probe });
    const combined = stdoutCalls.join('');
    expect(combined.includes('cloudflared found')).toBe(true);
  });

  it('suggests installing cloudflared when it is absent', async () => {
    const absent = async (): Promise<boolean> => false;
    await runInstall('claude-code', { home: tmpHome, probe: absent });
    const combined = stdoutCalls.join('');
    expect(combined.toLowerCase().includes('install cloudflared')).toBe(true);
  });
});
