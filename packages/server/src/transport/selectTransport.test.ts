import { describe, expect, it, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  detectCloudflaredVersion,
  selectTransport,
  validateBindOverride,
} from './selectTransport.js';
import { LanTransport } from './LanTransport.js';
import { CloudflaredTransport } from './CloudflaredTransport.js';
import type { SpawnFn } from './CloudflaredTransport.js';

// ---------------------------------------------------------------------------
// Fake-process helper for `cloudflared --version --short` probing.
// ---------------------------------------------------------------------------

interface VersionProcOpts {
  stdoutLines?: string[];
  exitCode?: number | null;
  exitDelayMs?: number;
}

function makeVersionProc(opts: VersionProcOpts): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = opts.stdoutLines
    ? Readable.from(opts.stdoutLines.map((l) => l + '\n'))
    : Readable.from([]);
  const fake = Object.assign(emitter, {
    pid: 88000,
    exitCode: null as number | null,
    killed: false,
    stdin: null,
    stdout,
    stderr: null,
    kill: vi.fn(() => {
      fake.killed = true;
      return true;
    }),
  });
  if (opts.exitCode !== undefined) {
    const exitCode = opts.exitCode;
    setTimeout(() => {
      fake.exitCode = exitCode;
      emitter.emit('exit', exitCode, null);
    }, opts.exitDelayMs ?? 5);
  }
  return fake as unknown as ChildProcess;
}

function makeVersionSpawnFn(proc: ChildProcess): SpawnFn {
  return (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => proc;
}

/**
 * selectTransport / validateBindOverride tests — REL-08 (Wave-0 gap).
 *
 * The two surfaces under test:
 *   1. selectTransport's auto-detect chain (LAN preferred wins, cloudflared
 *      first, npx fallback, LAN last-resort) — verified via the injectable
 *      `isOnPath` probe.
 *   2. validateBindOverride's parser per D-17 (corrected): accept IPv4 dotted-
 *      quad + IPv6 forms, reject hostnames + malformed input.
 */

describe('selectTransport — auto-detect chain', () => {
  it('prefer: "lan" returns a LanTransport instance', async () => {
    const t = await selectTransport({ prefer: 'lan' });
    expect(t).toBeInstanceOf(LanTransport);
    // bindHint stays consistent with the start() advisory (D-13).
    expect(t.bindHint()).toBe('0.0.0.0');
  });

  it('returns CloudflaredTransport when cloudflared is on PATH', async () => {
    const probed: string[] = [];
    const t = await selectTransport({
      isOnPath: async (cmd) => {
        probed.push(cmd);
        return cmd === 'cloudflared';
      },
    });
    expect(t).toBeInstanceOf(CloudflaredTransport);
    expect(probed).toEqual(['cloudflared']);
    expect(t.bindHint()).toBe('127.0.0.1');
  });

  it('falls back to npx-cloudflared when only npx is on PATH', async () => {
    const probed: string[] = [];
    const t = await selectTransport({
      isOnPath: async (cmd) => {
        probed.push(cmd);
        return cmd === 'npx';
      },
    });
    expect(t).toBeInstanceOf(CloudflaredTransport);
    expect(probed).toEqual(['cloudflared', 'npx']);
  });

  it('falls back to LanTransport when neither cloudflared nor npx is on PATH', async () => {
    const probed: string[] = [];
    const t = await selectTransport({
      isOnPath: async (cmd) => {
        probed.push(cmd);
        return false;
      },
    });
    expect(t).toBeInstanceOf(LanTransport);
    expect(probed).toEqual(['cloudflared', 'npx']);
  });
});

describe('validateBindOverride — REL-08 / D-17 (corrected)', () => {
  // ── Accept: IPv4 ────────────────────────────────────────────────────────

  it('accepts 127.0.0.1 (loopback)', () => {
    expect(validateBindOverride('127.0.0.1')).toEqual({
      kind: 'accept',
      value: '127.0.0.1',
    });
  });

  it('accepts 0.0.0.0 (wildcard)', () => {
    expect(validateBindOverride('0.0.0.0')).toEqual({
      kind: 'accept',
      value: '0.0.0.0',
    });
  });

  it('accepts a typical interface IP (192.168.1.42)', () => {
    expect(validateBindOverride('192.168.1.42')).toEqual({
      kind: 'accept',
      value: '192.168.1.42',
    });
  });

  it('accepts 255.255.255.255 (boundary)', () => {
    expect(validateBindOverride('255.255.255.255')).toEqual({
      kind: 'accept',
      value: '255.255.255.255',
    });
  });

  it('trims surrounding whitespace before accepting an IPv4', () => {
    expect(validateBindOverride('  10.0.0.1  ')).toEqual({
      kind: 'accept',
      value: '10.0.0.1',
    });
  });

  // ── Reject: IPv4 ────────────────────────────────────────────────────────

  it('rejects 256.0.0.1 (octet > 255)', () => {
    const r = validateBindOverride('256.0.0.1');
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toMatch(/must be.*IPv4.*IPv6|octet.*range/i);
  });

  it('rejects 1.2.3 (truncated IPv4)', () => {
    const r = validateBindOverride('1.2.3');
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toMatch(/IPv4.*IPv6/i);
  });

  // ── Accept: IPv6 ────────────────────────────────────────────────────────

  it('accepts ::1 (IPv6 loopback)', () => {
    expect(validateBindOverride('::1')).toEqual({ kind: 'accept', value: '::1' });
  });

  it('accepts :: (IPv6 wildcard)', () => {
    expect(validateBindOverride('::')).toEqual({ kind: 'accept', value: '::' });
  });

  it('accepts fe80::1 (link-local IPv6)', () => {
    expect(validateBindOverride('fe80::1')).toEqual({
      kind: 'accept',
      value: 'fe80::1',
    });
  });

  it('accepts a fully-expanded IPv6 (2001:db8::8a2e:370:7334)', () => {
    expect(validateBindOverride('2001:db8::8a2e:370:7334')).toEqual({
      kind: 'accept',
      value: '2001:db8::8a2e:370:7334',
    });
  });

  // ── Reject: hostnames / garbage / shape mismatches ──────────────────────

  it('rejects "localhost" (hostname, not IP)', () => {
    const r = validateBindOverride('localhost');
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toMatch(/IPv4.*IPv6/i);
  });

  it('rejects "my-host.local" (FQDN-style hostname)', () => {
    const r = validateBindOverride('my-host.local');
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toMatch(/IPv4.*IPv6/i);
  });

  it('rejects "example.com" (domain name)', () => {
    const r = validateBindOverride('example.com');
    expect(r.kind).toBe('reject');
  });

  it('rejects "not an address" (contains whitespace)', () => {
    const r = validateBindOverride('not an address');
    expect(r.kind).toBe('reject');
  });

  it('rejects an IPv6-shaped string with whitespace', () => {
    const r = validateBindOverride(':: 1');
    expect(r.kind).toBe('reject');
  });

  it('rejects an over-long candidate (>45 chars)', () => {
    // 46 colons → > 45 chars; would shape-match the IPv6 branch otherwise.
    const r = validateBindOverride(':'.repeat(46));
    expect(r.kind).toBe('reject');
  });

  // ── Absent: empty / undefined / whitespace ──────────────────────────────

  it('returns absent for undefined', () => {
    expect(validateBindOverride(undefined)).toEqual({ kind: 'absent' });
  });

  it('returns absent for empty string', () => {
    expect(validateBindOverride('')).toEqual({ kind: 'absent' });
  });

  it('returns absent for whitespace-only string (after trim)', () => {
    expect(validateBindOverride('   ')).toEqual({ kind: 'absent' });
    expect(validateBindOverride('\t\n')).toEqual({ kind: 'absent' });
  });
});

// ---------------------------------------------------------------------------
// Phase 2 / 02-05 — REL-11 version detection + D-11 binary-pin via env var
// ---------------------------------------------------------------------------

describe('detectCloudflaredVersion — REL-11 / D-11', () => {
  it('returns the trimmed version string when --short prints it and exit is 0', async () => {
    const proc = makeVersionProc({
      stdoutLines: ['2025.11.1'],
      exitCode: 0,
    });
    const v = await detectCloudflaredVersion({
      spawnFn: makeVersionSpawnFn(proc),
      command: 'cloudflared',
    });
    expect(v).toBe('2025.11.1');
  });

  it('returns null when the probe exits non-zero (e.g. older binary without --short)', async () => {
    const proc = makeVersionProc({
      stdoutLines: ['cloudflared: unknown flag --short'],
      exitCode: 2,
    });
    const v = await detectCloudflaredVersion({
      spawnFn: makeVersionSpawnFn(proc),
    });
    expect(v).toBeNull();
  });

  it('returns null when the probe hangs past timeoutMs (5s default → use short override)', async () => {
    // Build a fake that never exits.
    const emitter = new EventEmitter();
    const fake = Object.assign(emitter, {
      pid: 88001,
      exitCode: null as number | null,
      killed: false,
      stdin: null,
      stdout: Readable.from([]),
      stderr: null,
      kill: vi.fn(() => {
        fake.killed = true;
        return true;
      }),
    });
    const spawnFn = makeVersionSpawnFn(fake as unknown as ChildProcess);

    const v = await detectCloudflaredVersion({
      spawnFn,
      timeoutMs: 25,
    });
    expect(v).toBeNull();
    // Best-effort kill should have been invoked on timeout.
    expect(fake.kill).toHaveBeenCalled();
  });

  it('returns null when the spawn function itself throws synchronously', async () => {
    const spawnFn: SpawnFn = (() => {
      throw new Error('ENOENT');
    }) as SpawnFn;
    const v = await detectCloudflaredVersion({ spawnFn });
    expect(v).toBeNull();
  });

  it('returns null when stdout is empty even though exit is 0', async () => {
    const proc = makeVersionProc({
      // No stdout lines at all.
      exitCode: 0,
    });
    const v = await detectCloudflaredVersion({ spawnFn: makeVersionSpawnFn(proc) });
    expect(v).toBeNull();
  });
});

describe('selectTransport — version detection + npx-fallback pinning (REL-11 / D-11)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the detected version when cloudflared is on PATH', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = makeVersionProc({
      stdoutLines: ['2025.11.1'],
      exitCode: 0,
    });

    const t = await selectTransport({
      isOnPath: async (cmd) => cmd === 'cloudflared',
      spawnFn: makeVersionSpawnFn(proc),
    });

    expect(t).toBeInstanceOf(CloudflaredTransport);
    const banner = warnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /cloudflared detected on PATH: version=2025\.11\.1/.test(c[0]),
    );
    expect(banner).toBeDefined();
  });

  it('logs version=unknown when --version --short fails (older cloudflared)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = makeVersionProc({
      exitCode: 2,
    });

    await selectTransport({
      isOnPath: async (cmd) => cmd === 'cloudflared',
      spawnFn: makeVersionSpawnFn(proc),
    });

    const banner = warnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /cloudflared detected on PATH: version=unknown/.test(c[0]),
    );
    expect(banner).toBeDefined();
  });

  it('does NOT probe --version on the npx-fallback path (would trigger npm fetch)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Track whether `spawnFn` was invoked. If selectTransport probed --version
    // on the npx path, this would fire and we'd see a call. We assert ZERO.
    const spawnFn = vi.fn((): ChildProcess => {
      throw new Error('spawn should not be invoked on npx-fallback path');
    });

    const t = await selectTransport({
      isOnPath: async (cmd) => cmd === 'npx',
      spawnFn: spawnFn as unknown as SpawnFn,
    });

    expect(t).toBeInstanceOf(CloudflaredTransport);
    expect(spawnFn).not.toHaveBeenCalled();

    // The fallback banner is logged with the pinned version.
    const banner = warnSpy.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        /cloudflared via npx fallback/.test(c[0]) &&
        /2025\.11\.1/.test(c[0]),
    );
    expect(banner).toBeDefined();
  });

  it('npx-fallback CloudflaredTransport is constructed with CLOUDFLARED_VERSION env pin (D-11)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const t = await selectTransport({
      isOnPath: async (cmd) => cmd === 'npx',
    });

    expect(t).toBeInstanceOf(CloudflaredTransport);
    const env = (t as CloudflaredTransport)._getSpawnEnv();
    expect(env).toBeDefined();
    expect(env!.CLOUDFLARED_VERSION).toBe('2025.11.1');
    // Must merge with process.env — verify a well-known key is preserved.
    expect(env!.PATH).toBe(process.env.PATH);
  });

  it('system cloudflared on PATH does NOT receive a spawnEnv (respects user install — D-11)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const proc = makeVersionProc({ stdoutLines: ['2025.11.1'], exitCode: 0 });

    const t = await selectTransport({
      isOnPath: async (cmd) => cmd === 'cloudflared',
      spawnFn: makeVersionSpawnFn(proc),
    });

    expect(t).toBeInstanceOf(CloudflaredTransport);
    expect((t as CloudflaredTransport)._getSpawnEnv()).toBeUndefined();
  });
});
