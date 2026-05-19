import type { SessionManager } from '../session/SessionManager.js';
import type { Transport, TransportErrorReason } from '../transport/Transport.js';
import type { RunningServer } from '../http/index.js';

/**
 * Snapshot of the last terminal transport failure. Mirrors `TransportErrorReason`
 * (which the `onError` callback delivers) but adds an `at` ISO timestamp captured
 * at the moment the failure was observed, so `askGroup` can reference when the
 * tunnel went down.
 */
export interface LastTransportError {
  code: TransportErrorReason['code'];
  message: string;
  restart_count: number;
  at: string;
}

export interface McpState {
  manager: SessionManager | null;
  transport: Transport | null;
  http: RunningServer | null;
  publicUrl: string | null;
  /**
   * Set to `true` when the active transport invokes `onError(...)` with a terminal
   * failure (e.g. cloudflared exhausting its restart budget). While set, `askGroup`
   * returns a structured MCP error instead of blocking on `awaitAnswer`. Per D-10
   * the session stays alive — only `stopSession` clears this flag (via reset on
   * the next `startSession`).
   */
  transportFailed: boolean;
  /** Details of the most recent `onError` payload; `null` until first failure. */
  lastTransportError: LastTransportError | null;
}

export const mcpState: McpState = {
  manager: null,
  transport: null,
  http: null,
  publicUrl: null,
  transportFailed: false,
  lastTransportError: null,
};
