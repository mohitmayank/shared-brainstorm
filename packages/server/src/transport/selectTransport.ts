import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Transport } from './Transport.js';
import { LanTransport } from './LanTransport.js';
import { CloudflaredTransport } from './CloudflaredTransport.js';

const exec = promisify(execFile);

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

export interface SelectTransportOpts {
  prefer?: 'cloudflared' | 'npx-cloudflared' | 'lan';
  /**
   * Injection point for tests so they don't need to spawn `which`/`where`.
   * Defaults to the real shell-PATH probe.
   */
  isOnPath?: (cmd: string) => Promise<boolean>;
}

export async function selectTransport(opts: SelectTransportOpts = {}): Promise<Transport> {
  if (opts.prefer === 'lan') return new LanTransport();
  const probe = opts.isOnPath ?? defaultIsOnPath;
  if (await probe('cloudflared'))
    return new CloudflaredTransport({ command: 'cloudflared' });
  if (await probe('npx'))
    return new CloudflaredTransport({
      command: 'npx',
      args: ['--yes', 'cloudflared', 'tunnel'],
    });
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
