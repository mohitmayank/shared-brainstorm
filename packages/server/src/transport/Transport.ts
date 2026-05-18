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
 */

export interface TransportLocal {
  host: string;
  port: number;
}

export interface TransportInfo {
  publicUrl: string;
  kind: 'cloudflared' | 'npx-cloudflared' | 'lan' | 'mock';
  warning?: string;
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
}
