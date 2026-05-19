/**
 * Transport interface — the v1→v2 abstraction seam.
 *
 * In v1 we have two concrete transports:
 *   - `LanTransport`   (zero deps; helpers must share the LAN)
 *   - `CloudflaredTransport` (Phase 7; spawns `cloudflared` for a public URL)
 *
 * In v2 a hosted relay will appear as just another `Transport` impl, so the
 * rest of the server (HTTP handlers, session manager, CLI) never needs to
 * know which transport is in play — it only sees a `publicUrl` and a stable
 * `kind` discriminator. Keep this interface small and free of HTTP details.
 *
 * The `'mock'` kind is reserved for tests / future MockTransport (Phase 6+);
 * declared here so the discriminated union is exhaustive from day one.
 *
 * Phase 2 (REL-08, REL-09, REL-03 scaffolding) widens the interface with:
 *   - `bind` advisory on `TransportInfo` — HTTP server consumes for `serve({hostname})`
 *   - `secureCookie` advisory on `TransportInfo` — cookie helper consumes for `Secure` flag
 *   - `bindHint()` method — synchronous accessor so `startSession` can choose the bind
 *     BEFORE `.start()` is called (which itself depends on the HTTP server's local port)
 *   - `onError(cb)` method — surface terminal transport failures (e.g. cloudflared exhausting
 *     restart attempts). Wave 2 (02-04) only declares + scaffolds; CloudflaredTransport's
 *     actual restart-loop wiring lands in 02-05.
 */

export interface TransportLocal {
  host: string;
  port: number;
}

export interface TransportInfo {
  publicUrl: string;
  kind: 'cloudflared' | 'npx-cloudflared' | 'lan' | 'mock';
  warning?: string;
  /**
   * Advisory bind hint matching `bindHint()`. The HTTP server commits to a bind
   * BEFORE `.start()` resolves (see Pattern 4 in 02-RESEARCH §8), so this field
   * is informational on the return path; the live decision is made via `bindHint()`.
   */
  bind: '127.0.0.1' | '0.0.0.0';
  /**
   * Whether the cookie helper should attach a `Secure` attribute. True only for
   * transports where the participant-facing URL is HTTPS (cloudflared).
   */
  secureCookie: boolean;
}

/**
 * Reason payload for `onError(cb)`. The `code` values are kept narrow so that
 * the corresponding Zod schema in `packages/shared/src/events.ts` (added by 02-06)
 * can stay in sync. Adding a new code requires updating both files.
 */
export interface TransportErrorReason {
  code: 'cloudflared_permanent_failure' | 'cloudflared_version_mismatch';
  message: string;
  restart_count: number;
}

export interface Transport {
  start(local: TransportLocal): Promise<TransportInfo>;
  stop(): Promise<void>;
  /**
   * Subscribe to URL changes that happen mid-session (e.g. cloudflared
   * restarts). LAN/mock transports may store the callback but never fire it
   * because their URL is stable for the session.
   */
  onUrlChange(cb: (newUrl: string) => void): void;
  /**
   * Subscribe to terminal transport failures (e.g. cloudflared exhausting its
   * restart budget). Phase 2 wave 2 (02-04) declares this and stores the
   * callback on each subclass; the actual firing path for cloudflared lands in
   * 02-05. LAN/Mock transports store the callback but never invoke it.
   */
  onError(cb: (reason: TransportErrorReason) => void): void;
  /**
   * Synchronous accessor for the bind address this transport expects the HTTP
   * server to use. Needed because the HTTP server must commit to a bind BEFORE
   * `.start()` is called (the local port is required by some transports).
   * Each concrete transport returns the same value that `.start()`'s
   * `TransportInfo.bind` would have returned. See 02-04 Step 4 for context.
   */
  bindHint(): '127.0.0.1' | '0.0.0.0';
}
