import { spawn as nodeSpawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Transport } from './Transport.js';
import { LanTransport } from './LanTransport.js';
import { CloudflaredTransport } from './CloudflaredTransport.js';
import type { SpawnFn } from './CloudflaredTransport.js';

const exec = promisify(execFile);

/**
 * D-11 (corrected): pin the cloudflared *binary* via the CLOUDFLARED_VERSION
 * env var when the npx-fallback wrapper downloads it on first invocation. See
 * 02-RESEARCH §Concern 1 for why `npx -p cloudflared@X.Y.Z` does not work
 * (it pins the wrapper, not the binary).
 *
 * Pinned: 2026-05-19 — cloudflared 2025.11.1 (latest stable per RESEARCH §3).
 */
const CLOUDFLARED_VERSION_PIN = '2025.11.1';

/**
 * Default `isOnPath` — wraps `which`/`where` for shell-PATH detection.
 * Exported for selectTransport's internal use; tests can inject their own
 * implementation via `selectTransport({ isOnPath })`.
 */
async function defaultIsOnPath(cmd: string): Promise<boolean> {
  try {
    await exec(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** Default spawn used by `detectCloudflaredVersion` when none is injected. */
const defaultSpawn: SpawnFn = nodeSpawn as SpawnFn;

export interface DetectCloudflaredVersionOpts {
  /** Injectable for tests; defaults to `node:child_process.spawn`. */
  spawnFn?: SpawnFn;
  /** Executable to probe (defaults to `'cloudflared'`). */
  command?: string;
  /** Per-call timeout (defaults to 5000 ms). */
  timeoutMs?: number;
}

/**
 * REL-11 / D-11: one-shot probe of `cloudflared --version --short`.
 *
 * Returns the trimmed stdout (e.g. `'2025.11.1'`) on a clean exit-zero, or
 * `null` if the command errored, exited non-zero, hung past the timeout, or
 * produced no output. Never throws — the caller treats `null` as "unknown".
 *
 * Per 02-RESEARCH §3 and DeepWiki cite, modern cloudflared supports `--short`
 * and prints just the version string. Older binaries that lack `--short` will
 * exit non-zero (good — we return null and the caller falls through to
 * `version=unknown`).
 *
 * This is NOT a continuous probe; intended for one-shot logging in
 * `selectTransport()`. Not exported on a hot path.
 */
export async function detectCloudflaredVersion(
  opts: DetectCloudflaredVersionOpts = {},
): Promise<string | null> {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const command = opts.command ?? 'cloudflared';
  const timeoutMs = opts.timeoutMs ?? 5_000;

  return new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawnFn(command, ['--version', '--short'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve(null);
      return;
    }

    let stdoutBuf = '';
    let resolved = false;

    const finish = (value: string | null): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // Best-effort kill — if it's already dead this is a no-op.
      try {
        if (child!.exitCode === null && !child!.killed) child!.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        if (stdoutBuf.length > 4_096) stdoutBuf = stdoutBuf.slice(0, 4_096);
      });
    }

    child.on('error', () => finish(null));
    child.on('exit', (code: number | null) => {
      if (code === 0) {
        const trimmed = stdoutBuf.trim();
        finish(trimmed.length > 0 ? trimmed : null);
      } else {
        finish(null);
      }
    });
  });
}

export interface SelectTransportOpts {
  prefer?: 'cloudflared' | 'npx-cloudflared' | 'lan';
  /**
   * Injection point for tests so they don't need to spawn `which`/`where`.
   * Defaults to the real shell-PATH probe.
   */
  isOnPath?: (cmd: string) => Promise<boolean>;
  /**
   * Injection point for tests so the `cloudflared --version --short` probe
   * can be mocked without a real binary on PATH. Defaults to real spawn.
   */
  spawnFn?: SpawnFn;
}

export async function selectTransport(opts: SelectTransportOpts = {}): Promise<Transport> {
  if (opts.prefer === 'lan') return new LanTransport();
  const probe = opts.isOnPath ?? defaultIsOnPath;
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  if (await probe('cloudflared')) {
    // REL-11: log detected version once per selectTransport() call. Non-blocking
    // — if `--version --short` fails (e.g. older cloudflared without --short),
    // we still proceed; we just don't know the version. D-11: do not override
    // a user-installed system cloudflared, so no env-pinning here.
    const version = await detectCloudflaredVersion({ command: 'cloudflared', spawnFn });
    // eslint-disable-next-line no-console -- REL-11 diagnostic banner.
    console.warn(`cloudflared detected on PATH: version=${version ?? 'unknown'}`);
    return new CloudflaredTransport({ command: 'cloudflared' });
  }

  if (await probe('npx')) {
    // REL-11 / D-11 corrected: pin the binary version via env var. We skip the
    // `--version` probe here because the binary isn't downloaded yet — probing
    // it would itself trigger the npm fetch we are trying to control.
    // eslint-disable-next-line no-console -- REL-11 diagnostic banner.
    console.warn(
      `cloudflared via npx fallback — CLOUDFLARED_VERSION env var pins the binary version (current pin: ${CLOUDFLARED_VERSION_PIN})`,
    );
    return new CloudflaredTransport({
      command: 'npx',
      // `-p cloudflared cloudflared tunnel` — runs the `cloudflared` binary
      // from the `cloudflared` npm package. The `buildArgs` helper appends
      // `--url http://host:port` at spawn time.
      args: ['-p', 'cloudflared', 'cloudflared', 'tunnel'],
      // Pinned: 2026-05-19 — cloudflared 2025.11.1 (D-11 corrected: pin the
      // binary via CLOUDFLARED_VERSION, not via `npx -p cloudflared@X.Y.Z`).
      spawnEnv: { ...process.env, CLOUDFLARED_VERSION: CLOUDFLARED_VERSION_PIN },
    });
  }
  return new LanTransport();
}

// ---------------------------------------------------------------------------
// SHARED_BRAINSTORM_BIND override validation (REL-08 / D-17 corrected)
// ---------------------------------------------------------------------------

export type BindOverrideResult =
  | { kind: 'accept'; value: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'absent' };

/**
 * Validate the `SHARED_BRAINSTORM_BIND` env var per D-17 (corrected by research
 * 2026-05-19 + user discussion):
 *
 * - Empty / whitespace-only / undefined → `{ kind: 'absent' }` (silent fall-through
 *   to transport default).
 * - Valid IPv4 dotted-quad (each octet 0..255) → `{ kind: 'accept', value }`.
 * - Permissive IPv6 (contains `:`, no whitespace, ≤45 chars) → `{ kind: 'accept', value }`.
 *   Node's `serve({hostname})` ultimately validates the address itself; this layer
 *   just rules out the obvious wrong-shape inputs (hostnames like `localhost`,
 *   FQDNs like `my-host.local`).
 * - Anything else (hostnames, FQDNs, garbage) → `{ kind: 'reject', reason }`.
 *
 * Pure: never reads `process.env`. Caller passes the raw string (or undefined).
 * Easy to unit-test (REL-08 coverage).
 */
export function validateBindOverride(raw: string | undefined): BindOverrideResult {
  if (raw === undefined) return { kind: 'absent' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'absent' };

  // IPv4 dotted-quad with each octet in 0..255.
  const ipv4Match = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map((s) => Number.parseInt(s, 10));
    if (octets.every((n) => n >= 0 && n <= 255)) {
      return { kind: 'accept', value: trimmed };
    }
    return {
      kind: 'reject',
      reason: 'must be an IPv4 or IPv6 address (octet out of range 0-255)',
    };
  }

  // Permissive IPv6: contains `:`, no whitespace, length ≤ 45 (max IPv6 textual
  // length including zone-id is 45 chars). Node's listen() does the real parse.
  // Excludes hostnames like `localhost` (no `:`) and `my-host.local` (no `:`).
  if (trimmed.includes(':') && !/\s/.test(trimmed) && trimmed.length <= 45) {
    return { kind: 'accept', value: trimmed };
  }

  return {
    kind: 'reject',
    reason: 'must be an IPv4 or IPv6 address',
  };
}
