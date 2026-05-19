import type { Context, Env, MiddlewareHandler } from 'hono';
import type { Clock } from '../../session/clock.js';
import { readParticipantCookie } from '../cookies.js';

/**
 * REL-06 — Hono rate-limit middleware factory.
 *
 * Sliding-window limiter: keeps a timestamp array per key, drops entries
 * older than `windowMs` on each request, and rejects with a structured
 * 429 when the remaining count is >= `limit`.
 *
 * Storage is created **inside** the factory closure (per Pitfall 1 in
 * 02-RESEARCH.md): each call to `rateLimit({...})` produces an
 * independent middleware with its own `Map`. The optional `storage`
 * parameter exists purely so tests can inspect or pre-seed state.
 *
 * Wired to routes by 02-03 — this plan delivers only the building block.
 */

export interface RateLimitOpts {
  /** Maximum number of requests allowed within `windowMs`. */
  limit: number;
  /** Sliding window in milliseconds. */
  windowMs: number;
  /** Derives the per-request identity (IP, cookie, etc.). */
  keyFn: (c: Context) => string;
  /** Injectable clock — use `fixedClock` in tests, `realClock` in prod. */
  clock: Clock;
  /** Optional pre-seeded storage; created internally if omitted. */
  storage?: Map<string, number[]>;
}

/**
 * Build a Hono rate-limit middleware over the supplied options.
 *
 * Behavior:
 * - On the success path, push the current timestamp onto the key's array
 *   and call `next()`.
 * - On the reject path, do NOT push a timestamp — a flooding client must
 *   not extend their own lockout. Respond `429` with JSON body
 *   `{ error: 'rate_limited', retry_after_ms: N }` plus a
 *   `Retry-After: ceil(N/1000)` header.
 *
 * `retryAfterMs` is computed from the oldest still-in-window timestamp:
 * `oldest + windowMs - now`.
 */
export function rateLimit<E extends Env = Env>(opts: RateLimitOpts): MiddlewareHandler<E> {
  const store = opts.storage ?? new Map<string, number[]>();
  return async (c, next) => {
    const key = opts.keyFn(c);
    const now = opts.clock.now().getTime();
    const cutoff = now - opts.windowMs;
    const prior = store.get(key) ?? [];
    const hits = prior.filter((t) => t > cutoff);
    if (hits.length >= opts.limit) {
      const oldest = hits[0]!;
      const retryAfterMs = oldest + opts.windowMs - now;
      c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return c.json({ error: 'rate_limited', retry_after_ms: retryAfterMs }, 429);
    }
    hits.push(now);
    store.set(key, hits);
    await next();
    return;
  };
}

/**
 * Key extractor for per-IP-limited routes (e.g. `/api/join` — D-01).
 *
 * Prefers `cf-connecting-ip` (set authoritatively by Cloudflare when traffic
 * arrives through the tunnel), falls back to the first entry of
 * `x-forwarded-for`, finally falls back to the literal `'unknown'` so the
 * map never gets a null/empty key.
 */
export function joinKey(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf && cf.length > 0) return cf;
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && first.length > 0) return first;
  }
  return 'unknown';
}

/**
 * Key extractor for per-cookie-limited routes (`/api/suggestion`,
 * `/api/comment` — D-01). The `requireParticipant` middleware already
 * 401s a missing cookie before this runs, so the `'no-cookie'` fallback
 * is purely defensive.
 */
export function cookieKey(c: Context): string {
  return readParticipantCookie(c) ?? 'no-cookie';
}

/**
 * Default rate-limit configurations (D-02). 02-03 will read the matching
 * env vars (`SHARED_BRAINSTORM_RATE_LIMIT_JOIN`, `_SUGGESTION`, `_COMMENT`)
 * and fall back to these.
 */
export const joinDefault: { limit: number; windowMs: number } = {
  limit: 5,
  windowMs: 60_000,
};

export const suggestionDefault: { limit: number; windowMs: number } = {
  limit: 30,
  windowMs: 60_000,
};

export const commentDefault: { limit: number; windowMs: number } = {
  limit: 30,
  windowMs: 60_000,
};

/**
 * Parse a rate-limit env-var spec of the form `N/window` where
 * `window ∈ {'sec','min','hour'}` (D-02).
 *
 * On any malformed input — `undefined`, wrong shape, non-positive `N`,
 * unknown window unit — the parser returns `defaults` and emits a
 * `console.warn`. It NEVER throws: a malformed env var must not crash
 * the server.
 *
 * The function is intentionally pure (it does not read `process.env`);
 * 02-03 owns the env-var lookup and passes the value here.
 */
export function parseLimitSpec(
  spec: string | undefined,
  defaults: { limit: number; windowMs: number },
): { limit: number; windowMs: number } {
  if (spec === undefined) return defaults;
  const m = /^(-?\d+)\/(sec|min|hour)$/.exec(spec.trim());
  if (!m) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shared-brainstorm] ignoring malformed rate-limit spec ${JSON.stringify(spec)}; ` +
        `expected form 'N/window' where window ∈ {sec, min, hour}. Using defaults.`,
    );
    return defaults;
  }
  const limit = Number(m[1]);
  if (!Number.isFinite(limit) || limit <= 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[shared-brainstorm] ignoring non-positive rate-limit ${JSON.stringify(spec)}; ` +
        `limit must be > 0. Using defaults.`,
    );
    return defaults;
  }
  const unit = m[2]!;
  const windowMs = unit === 'sec' ? 1_000 : unit === 'min' ? 60_000 : 3_600_000;
  return { limit, windowMs };
}

/**
 * Periodic janitor that drops keys whose timestamps are all older than
 * the window. Runs every 60s; `setInterval().unref()` prevents the timer
 * from keeping the event loop alive past `stopSession`.
 *
 * 02-03 must call the returned `stop()` from `RunningServer.close()`.
 */
export function startEvictor(
  store: Map<string, number[]>,
  windowMs: number,
  clock: Clock,
): { stop(): void } {
  const handle = setInterval(() => {
    const cutoff = clock.now().getTime() - windowMs;
    for (const [key, hits] of store) {
      const kept = hits.filter((t) => t > cutoff);
      if (kept.length === 0) store.delete(key);
      else if (kept.length !== hits.length) store.set(key, kept);
    }
  }, 60_000);
  handle.unref();
  return {
    stop() {
      clearInterval(handle);
    },
  };
}
