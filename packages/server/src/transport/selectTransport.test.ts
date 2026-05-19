import { describe, expect, it } from 'vitest';
import { selectTransport, validateBindOverride } from './selectTransport.js';
import { LanTransport } from './LanTransport.js';
import { CloudflaredTransport } from './CloudflaredTransport.js';

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
