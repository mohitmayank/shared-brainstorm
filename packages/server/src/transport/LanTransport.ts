import { networkInterfaces } from 'node:os';
import type {
  Transport,
  TransportErrorReason,
  TransportInfo,
  TransportLocal,
} from './Transport.js';

/**
 * Resolve a host string to something a peer on the LAN can actually reach.
 *
 * - If `preferredHost` is provided AND is not the wildcard `0.0.0.0`, return
 *   it as-is. The caller is asserting that they want this exact host in the
 *   URL (could be an explicit LAN IP, a hostname, or a loopback for tests).
 * - Otherwise (`'0.0.0.0'` or `undefined`), scan `os.networkInterfaces()` for
 *   the first non-internal IPv4 address. This is the common dev case where
 *   the HTTP server binds the wildcard but the URL we hand out must be a
 *   concrete address.
 * - Fall back to `127.0.0.1` if no LAN interface exists (offline laptop,
 *   sandboxed CI, etc.). The accompanying warning makes clear the helper
 *   probably can't reach it.
 */
export function pickReachableIp(preferredHost?: string): string {
  if (preferredHost && preferredHost !== '0.0.0.0') return preferredHost;
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) {
    if (!list) continue;
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '127.0.0.1';
}

export class LanTransport implements Transport {
  // Stored for interface conformance; LAN URLs never change mid-session so
  // this is intentionally never invoked. See Transport.onUrlChange docs.
  private onUrlChangeCb: ((newUrl: string) => void) | null = null;
  // REL-03 scaffolding (02-04): LAN URLs are stable for the session, so this
  // callback is stored but never invoked. Symmetry with onUrlChange.
  private onErrorCb: ((reason: TransportErrorReason) => void) | null = null;

  async start(local: TransportLocal): Promise<TransportInfo> {
    const ip = pickReachableIp(local.host);
    return {
      publicUrl: `http://${ip}:${local.port}`,
      kind: 'lan',
      warning: 'LAN-only mode: helpers must be on the same network.',
      // D-13 / D-15: LAN keeps wildcard bind + non-Secure cookie.
      bind: '0.0.0.0',
      secureCookie: false,
    };
  }

  async stop(): Promise<void> {
    /* no-op: nothing to tear down for LAN */
  }

  onUrlChange(cb: (newUrl: string) => void): void {
    this.onUrlChangeCb = cb;
  }

  onError(cb: (reason: TransportErrorReason) => void): void {
    this.onErrorCb = cb;
  }

  bindHint(): '0.0.0.0' {
    return '0.0.0.0';
  }
}
