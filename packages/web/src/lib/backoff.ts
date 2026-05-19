// Source: aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
//   AWS describes "Full Jitter" + variants; D-18 of the Phase 2 context locks the
//   symmetric ±30% variant: factor ∈ [1-r, 1+r] where r=0.3 (so [0.7, 1.3]).
//
// This module is intentionally pure (no DOM, no timers, no globals besides the
// injectable `random` source). The WS reconnect loop in App.tsx (wired by 02-07)
// consumes the returned milliseconds.

/**
 * Options for {@link nextBackoffMs}. All fields are optional; defaults match D-18.
 */
export interface BackoffOpts {
  /** Base delay in ms for attempt 0. Default: 1000 (1s). */
  baseMs?: number;
  /** Maximum delay in ms after exponential growth. Default: 30_000 (30s). */
  capMs?: number;
  /**
   * Jitter ratio: factor sits in `[1 - jitterRatio, 1 + jitterRatio]`.
   * Default: 0.3 (±30%, the D-18 schedule).
   */
  jitterRatio?: number;
  /**
   * Random source returning `[0, 1)`. Default: `Math.random`.
   * Inject in tests for determinism (e.g. `() => 0.5` yields the un-jittered base).
   *
   * Note: some PRNGs occasionally return exactly 1; the formula still bounds the
   * factor by `1 + jitterRatio`, and `Math.round` keeps the result an integer.
   */
  random?: () => number;
}

/**
 * Compute milliseconds to wait before reconnect attempt `attempt` (0-indexed).
 *
 * Schedule with defaults (mid-jitter via `random = () => 0.5`):
 * - attempt 0 → 1000 ms
 * - attempt 1 → 2000 ms
 * - attempt 2 → 4000 ms
 * - attempt 3 → 8000 ms
 * - attempt 4 → 16000 ms
 * - attempt 5 → 30000 ms (capped: 1000*2^5 = 32000 → clamped to 30000)
 * - attempt ≥ 5 → 30000 ms (still capped)
 *
 * Formula (D-18): `exp = min(cap, base * 2^attempt); factor = (1 - r) + 2*r*random();
 * return round(exp * factor)`. With `r = 0.3` and `random ∈ [0, 1)` the factor
 * lies in `[0.7, 1.3]`.
 *
 * Edge cases:
 * - `attempt < 0`: clamped to 0 (defensive against callers doing subtraction).
 * - `!Number.isFinite(attempt)` (NaN, ±Infinity): returns `capMs` directly — a
 *   safe upper bound rather than `Infinity * jitter` garbage.
 *
 * @param attempt 0-indexed reconnect attempt number.
 * @param opts Optional overrides for base/cap/jitter/random.
 * @returns Integer milliseconds to wait.
 */
export function nextBackoffMs(attempt: number, opts: BackoffOpts = {}): number {
  const base = opts.baseMs ?? 1000;
  const cap = opts.capMs ?? 30_000;
  const r = opts.jitterRatio ?? 0.3;
  const rand = opts.random ?? Math.random;

  // Defensive: NaN/±Infinity attempt → return cap (never Infinity, never NaN).
  if (!Number.isFinite(attempt)) {
    return cap;
  }

  // Clamp negative attempts to 0 so callers doing arithmetic don't get fractional
  // delays via `2 ** -1 = 0.5` etc.
  const safeAttempt = attempt < 0 ? 0 : attempt;

  const exp = Math.min(cap, base * Math.pow(2, safeAttempt));
  const factor = 1 - r + 2 * r * rand(); // ∈ [1-r, 1+r] when rand ∈ [0, 1)
  return Math.round(exp * factor);
}
