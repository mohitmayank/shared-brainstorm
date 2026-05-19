// packages/server/src/install/claude-code.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { installClaudeCode } from './claude-code.js';
import type { SpawnFn } from './claude-code.js';

// ---------------------------------------------------------------------------
// Fake process factory (adapted from CloudflaredTransport.test.ts)
// Exposes stdout instead of stderr because `claude mcp list` writes to stdout.
// ---------------------------------------------------------------------------

interface FakeProcessOpts {
  stdoutLines?: string[];
  exitCode?: number;
  exitDelayMs?: number;
}

function makeFakeProcess(opts: FakeProcessOpts = {}): ChildProcess {
  const emitter = new EventEmitter();

  const stdoutSource = opts.stdoutLines
    ? Readable.from(opts.stdoutLines.map((l) => l + '\n'))
    : Readable.from([]);

  const fake = Object.assign(emitter, {
    pid: 12345,
    exitCode: null as number | null,
    stdin: null,
    stdout: stdoutSource,
    stderr: Readable.from([]),
    kill(_signal?: NodeJS.Signals | number): boolean {
      fake.exitCode = 0;
      emitter.emit('close', 0, null);
      return true;
    },
  });

  if (opts.exitCode !== undefined) {
    const delay = opts.exitDelayMs ?? 5;
    const exitCode = opts.exitCode;
    setTimeout(() => {
      fake.exitCode = exitCode;
      emitter.emit('close', exitCode, null);
    }, delay);
  }

  return fake as unknown as ChildProcess;
}

/** Build a minimal SpawnFn shim that always returns the provided fake process. */
function makeSpawnFn(fakeProc: ChildProcess): SpawnFn {
  return (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => fakeProc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installClaudeCode', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'sb-cc-test-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('writes ~/.claude.json with shared-brainstorm entry', async () => {
    const { configPath } = await installClaudeCode({ home: tmpHome });
    expect(configPath).toBe(join(tmpHome, '.claude.json'));
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed['mcpServers'] as Record<string, unknown>;
    expect(servers['shared-brainstorm']).toEqual({
      command: 'npx',
      args: ['-y', 'shared-brainstorm'],
    });
  });

  it('does not overwrite existing mcpServers siblings', async () => {
    const configPath = join(tmpHome, '.claude.json');
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
      'utf8',
    );
    await installClaudeCode({ home: tmpHome });
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed['mcpServers'] as Record<string, unknown>;
    expect(servers['other']).toBeDefined();
    expect(servers['shared-brainstorm']).toBeDefined();
  });

  it('preserves unrelated top-level keys in ~/.claude.json merge', async () => {
    const configPath = join(tmpHome, '.claude.json');
    await writeFile(
      configPath,
      JSON.stringify({
        unrelatedUserKey: { deep: 'value' },
        projects: { existing: 'project' },
        mcpServers: { other: { command: 'other' } },
      }),
      'utf8',
    );
    await installClaudeCode({ home: tmpHome });
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['unrelatedUserKey']).toEqual({ deep: 'value' });
    expect(parsed['projects']).toEqual({ existing: 'project' });
    const servers = parsed['mcpServers'] as Record<string, unknown>;
    expect(servers['other']).toBeDefined();
    expect(servers['shared-brainstorm']).toBeDefined();
  });

  it('verify warns when claude mcp list does not list shared-brainstorm', async () => {
    const fakeProc = makeFakeProcess({
      stdoutLines: ['claude.ai Google Drive: ... - ! Needs authentication'],
      exitCode: 0,
      exitDelayMs: 5,
    });
    const errors: string[] = [];
    const origErr = console.error;
    // eslint-disable-next-line no-console
    console.error = (msg: string) => {
      errors.push(String(msg));
    };
    try {
      await installClaudeCode({ home: tmpHome, spawn: makeSpawnFn(fakeProc) });
    } finally {
      // eslint-disable-next-line no-console
      console.error = origErr;
    }
    expect(errors.some((e) => e.includes('shared-brainstorm'))).toBe(true);
    expect(errors.some((e) => e.includes('claude mcp add'))).toBe(true);
  });

  it('verify skips silently when claude is not on PATH', async () => {
    const errors: string[] = [];
    const origErr = console.error;
    // eslint-disable-next-line no-console
    console.error = (msg: string) => {
      errors.push(String(msg));
    };
    try {
      await installClaudeCode({
        home: tmpHome,
        spawn: (() => {
          const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }) as unknown as SpawnFn,
      });
    } finally {
      // eslint-disable-next-line no-console
      console.error = origErr;
    }
    expect(errors).toHaveLength(0); // ENOENT must be SILENT per D-14
  });

  it('verify is silent on the happy path', async () => {
    const fakeProc = makeFakeProcess({
      stdoutLines: [
        'shared-brainstorm: shared-brainstorm  - ✓ Connected',
        'plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected',
      ],
      exitCode: 0,
      exitDelayMs: 5,
    });
    const errors: string[] = [];
    const origErr = console.error;
    // eslint-disable-next-line no-console
    console.error = (msg: string) => {
      errors.push(String(msg));
    };
    try {
      await installClaudeCode({ home: tmpHome, spawn: makeSpawnFn(fakeProc) });
    } finally {
      // eslint-disable-next-line no-console
      console.error = origErr;
    }
    expect(errors).toHaveLength(0);
  });
});
