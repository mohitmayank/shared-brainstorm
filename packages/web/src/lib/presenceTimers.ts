// Phase 5 (PRES-02) — pure decision logic for presence-expiry timer management.
//
// The participant client schedules client-side TTL sweeps for ephemeral presence:
// a 'typing'/'picking' entry expires after 4s; a derived 'submitted' entry (from a
// durable suggestion_added/updated event) lasts 6s. Crucially, a participant's
// 'typing' presence key and their 'submitted' key COLLIDE (both are the participant
// id), and a typing-stop ('idle') frame is emitted on submit — which can arrive
// either before OR after the suggestion_added event.
//
// The defect this guards against (recurred repeatedly): an idle frame arriving AFTER
// suggestion_added must NOT cancel the live 6s 'submitted' timer, or the
// "X submitted a suggestion" line is stranded on screen forever. Because the WS
// onEvent handler in App.tsx is a `useCallback([])` closure, it cannot read current
// reducer state — so the last activity per key is tracked in a ref and fed here.
//
// This module is pure and exhaustively unit-tested (presenceTimers.test.ts) so the
// timer policy has an automated regression guard independent of the React harness.

export type PresenceActivity = 'typing' | 'picking' | 'submitted';

export const TYPING_TTL_MS = 4000;
export const SUBMITTED_TTL_MS = 6000;

/** An incoming timer-relevant event, normalized from a WS frame. */
export type PresenceTimerInput =
  | { kind: 'presence'; key: string; activity: 'typing' | 'picking' | 'idle' }
  | { kind: 'submitted'; key: string };

/** What the caller (App.tsx) must do to its timer + activity refs. */
export interface PresenceTimerPlan {
  /** clearTimeout the existing handle for this key (replace or cancel). */
  clearTimerKey: string | null;
  /** Install a fresh timer for this key with this TTL. */
  setTimer: { key: string; ttlMs: number } | null;
  /** Write this activity into the per-key activity ref. */
  setActivity: { key: string; activity: PresenceActivity } | null;
  /** Delete this key from the per-key activity ref. */
  deleteActivity: string | null;
}

const NOOP: PresenceTimerPlan = {
  clearTimerKey: null,
  setTimer: null,
  setActivity: null,
  deleteActivity: null,
};

/**
 * Decide the timer/activity-ref mutations for one incoming presence-relevant event,
 * given the activity currently recorded for the same key (undefined if none).
 */
export function planPresenceTimer(
  input: PresenceTimerInput,
  recordedActivity: PresenceActivity | undefined,
): PresenceTimerPlan {
  if (input.kind === 'submitted') {
    // Derived from a durable suggestion event: replace any in-flight typing timer
    // with a 6s 'submitted' timer and mark the key sticky.
    return {
      clearTimerKey: input.key,
      setTimer: { key: input.key, ttlMs: SUBMITTED_TTL_MS },
      setActivity: { key: input.key, activity: 'submitted' },
      deleteActivity: null,
    };
  }

  if (input.activity !== 'idle') {
    // Active typing/picking: (re)arm a 4s timer and record the activity.
    return {
      clearTimerKey: input.key,
      setTimer: { key: input.key, ttlMs: TYPING_TTL_MS },
      setActivity: { key: input.key, activity: input.activity },
      deleteActivity: null,
    };
  }

  // Idle (typing/picking stopped). Skip entirely when the key is a sticky
  // 'submitted' entry — otherwise we would cancel the live 6s timer (frame
  // Ordering B) and strand the submitted line forever.
  if (recordedActivity === 'submitted') {
    return NOOP;
  }

  // A real typing/picking stop: cancel the residual 4s timer and forget the key.
  return {
    clearTimerKey: input.key,
    setTimer: null,
    setActivity: null,
    deleteActivity: input.key,
  };
}
