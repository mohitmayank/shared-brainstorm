import { describe, it, expect } from 'vitest';
import {
  planPresenceTimer,
  TYPING_TTL_MS,
  SUBMITTED_TTL_MS,
  type PresenceActivity,
} from './presenceTimers.js';

describe('planPresenceTimer', () => {
  it('arms a 4s timer and records activity for an active typing frame', () => {
    const plan = planPresenceTimer({ kind: 'presence', key: 'p1', activity: 'typing' }, undefined);
    expect(plan).toEqual({
      clearTimerKey: 'p1',
      setTimer: { key: 'p1', ttlMs: TYPING_TTL_MS },
      setActivity: { key: 'p1', activity: 'typing' },
      deleteActivity: null,
    });
  });

  it('arms a 4s timer and records activity for an active picking frame', () => {
    const plan = planPresenceTimer({ kind: 'presence', key: '__coordinator', activity: 'picking' }, undefined);
    expect(plan.setTimer).toEqual({ key: '__coordinator', ttlMs: TYPING_TTL_MS });
    expect(plan.setActivity).toEqual({ key: '__coordinator', activity: 'picking' });
  });

  it('arms a 6s timer and marks the key submitted for a submitted event', () => {
    const plan = planPresenceTimer({ kind: 'submitted', key: 'p1' }, 'typing');
    expect(plan).toEqual({
      clearTimerKey: 'p1',
      setTimer: { key: 'p1', ttlMs: SUBMITTED_TTL_MS },
      setActivity: { key: 'p1', activity: 'submitted' },
      deleteActivity: null,
    });
  });

  it('clears the timer and forgets the key on a plain typing-stop (idle)', () => {
    const plan = planPresenceTimer({ kind: 'presence', key: 'p1', activity: 'idle' }, 'typing');
    expect(plan).toEqual({
      clearTimerKey: 'p1',
      setTimer: null,
      setActivity: null,
      deleteActivity: 'p1',
    });
  });

  it('clears the picking timer on a picking-stop (idle) — no strand', () => {
    const plan = planPresenceTimer({ kind: 'presence', key: '__coordinator', activity: 'idle' }, 'picking');
    expect(plan.clearTimerKey).toBe('__coordinator');
    expect(plan.deleteActivity).toBe('__coordinator');
  });

  // WR-01 regression guard (frame Ordering B): suggestion_added BEFORE the trailing
  // typing-stop. The idle frame MUST NOT cancel the live 6s submitted timer.
  it('skips entirely on an idle frame when the key is a sticky submitted entry', () => {
    const plan = planPresenceTimer({ kind: 'presence', key: 'p1', activity: 'idle' }, 'submitted');
    expect(plan).toEqual({
      clearTimerKey: null,
      setTimer: null,
      setActivity: null,
      deleteActivity: null,
    });
  });

  // Full Ordering B sequence walked through the planner with a tiny activity map,
  // proving the 6s submitted timer survives the trailing idle.
  it('Ordering B: typing → submitted → idle leaves the submitted timer intact', () => {
    const activity = new Map<string, PresenceActivity>();
    const apply = (input: Parameters<typeof planPresenceTimer>[0]) => {
      const plan = planPresenceTimer(input, activity.get(keyOf(input)));
      if (plan.deleteActivity) activity.delete(plan.deleteActivity);
      if (plan.setActivity) activity.set(plan.setActivity.key, plan.setActivity.activity);
      return plan;
    };
    apply({ kind: 'presence', key: 'p1', activity: 'typing' });
    const submittedPlan = apply({ kind: 'submitted', key: 'p1' });
    expect(submittedPlan.setTimer).toEqual({ key: 'p1', ttlMs: SUBMITTED_TTL_MS });
    const idlePlan = apply({ kind: 'presence', key: 'p1', activity: 'idle' });
    // The idle frame is a no-op — the 6s timer set above is NOT cleared.
    expect(idlePlan.clearTimerKey).toBeNull();
    expect(activity.get('p1')).toBe('submitted');
  });

  // Ordering A: idle BEFORE suggestion_added — typing cleared, then submitted armed.
  it('Ordering A: typing → idle → submitted arms the 6s submitted timer', () => {
    const activity = new Map<string, PresenceActivity>();
    const apply = (input: Parameters<typeof planPresenceTimer>[0]) => {
      const plan = planPresenceTimer(input, activity.get(keyOf(input)));
      if (plan.deleteActivity) activity.delete(plan.deleteActivity);
      if (plan.setActivity) activity.set(plan.setActivity.key, plan.setActivity.activity);
      return plan;
    };
    apply({ kind: 'presence', key: 'p1', activity: 'typing' });
    const idlePlan = apply({ kind: 'presence', key: 'p1', activity: 'idle' });
    expect(idlePlan.clearTimerKey).toBe('p1');
    expect(activity.has('p1')).toBe(false);
    const submittedPlan = apply({ kind: 'submitted', key: 'p1' });
    expect(submittedPlan.setTimer).toEqual({ key: 'p1', ttlMs: SUBMITTED_TTL_MS });
  });
});

function keyOf(input: Parameters<typeof planPresenceTimer>[0]): string {
  return input.key;
}
