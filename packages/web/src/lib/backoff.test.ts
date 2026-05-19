import { describe, it, expect } from 'vitest';
import { nextBackoffMs } from './backoff.js';

describe('nextBackoffMs', () => {
  describe('mid-jitter (random = 0.5) — unjittered exponential schedule', () => {
    it('attempt 0 returns base (1000 ms)', () => {
      expect(nextBackoffMs(0, { random: () => 0.5 })).toBe(1000);
    });

    it('attempt 1 returns 2× base (2000 ms)', () => {
      expect(nextBackoffMs(1, { random: () => 0.5 })).toBe(2000);
    });

    it('attempt 2 returns 4× base (4000 ms)', () => {
      expect(nextBackoffMs(2, { random: () => 0.5 })).toBe(4000);
    });

    it('attempt 3 returns 8× base (8000 ms)', () => {
      expect(nextBackoffMs(3, { random: () => 0.5 })).toBe(8000);
    });

    it('attempt 4 returns 16× base (16000 ms)', () => {
      expect(nextBackoffMs(4, { random: () => 0.5 })).toBe(16000);
    });

    it('attempt 5 hits cap (32000 → 30000)', () => {
      expect(nextBackoffMs(5, { random: () => 0.5 })).toBe(30_000);
    });

    it('attempt 10 stays at cap (30000)', () => {
      expect(nextBackoffMs(10, { random: () => 0.5 })).toBe(30_000);
    });

    it('attempt 100 stays at cap (30000) — extreme but safe', () => {
      expect(nextBackoffMs(100, { random: () => 0.5 })).toBe(30_000);
    });
  });

  describe('jitter bounds at attempt 0', () => {
    it('random=0 yields minimum jitter (0.7 × base = 700)', () => {
      expect(nextBackoffMs(0, { random: () => 0 })).toBe(700);
    });

    it('random≈1 yields maximum jitter (~1.3 × base = 1299–1300)', () => {
      const val = nextBackoffMs(0, { random: () => 0.999 });
      expect(val).toBeGreaterThanOrEqual(1298);
      expect(val).toBeLessThanOrEqual(1300);
    });
  });

  describe('edge cases', () => {
    it('attempt = -1 clamps to 0 (returns base 1000 with mid jitter)', () => {
      expect(nextBackoffMs(-1, { random: () => 0.5 })).toBe(1000);
    });

    it('attempt = NaN returns cap (defensive fallback)', () => {
      expect(nextBackoffMs(Number.NaN, { random: () => 0.5 })).toBe(30_000);
    });

    it('attempt = Infinity returns cap (defensive fallback)', () => {
      expect(nextBackoffMs(Number.POSITIVE_INFINITY, { random: () => 0.5 })).toBe(30_000);
    });
  });

  describe('custom opts', () => {
    it('honors custom baseMs and capMs (attempt 2 with base=100, cap=1000 → 400)', () => {
      expect(
        nextBackoffMs(2, { baseMs: 100, capMs: 1_000, random: () => 0.5 }),
      ).toBe(400);
    });

    it('jitterRatio = 0 disables jitter entirely (random irrelevant)', () => {
      expect(nextBackoffMs(3, { jitterRatio: 0, random: () => 0.999 })).toBe(8000);
      expect(nextBackoffMs(3, { jitterRatio: 0, random: () => 0 })).toBe(8000);
    });
  });

  describe('default random source (Math.random)', () => {
    it('100 calls with attempt=0 all fall within [700, 1300]', () => {
      for (let i = 0; i < 100; i++) {
        const val = nextBackoffMs(0);
        expect(val).toBeGreaterThanOrEqual(700);
        expect(val).toBeLessThanOrEqual(1300);
      }
    });
  });
});
