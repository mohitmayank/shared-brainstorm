import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { fixedClock } from '../../session/clock.js';
import {
  cookieKey,
  commentDefault,
  joinDefault,
  joinKey,
  parseLimitSpec,
  rateLimit,
  startEvictor,
  suggestionDefault,
} from './rateLimit.js';

/**
 * Helper: build a tiny Hono app with the supplied middleware mounted at
 * `/probe`. The route just returns `200 ok` — we only care about whether
 * the middleware lets the request through.
 */
function appWith(mw: ReturnType<typeof rateLimit>): Hono {
  const app = new Hono();
  app.use('/probe', mw);
  app.get('/probe', (c) => c.text('ok'));
  return app;
}

/** Make a request to `/probe` from a specific "IP" via cf-connecting-ip. */
async function probe(app: Hono, ip = '1.2.3.4'): Promise<Response> {
  return app.request('/probe', { headers: { 'cf-connecting-ip': ip } });
}

describe('rateLimit — sliding window behavior', () => {
  it('allows requests under the limit (5 of 5 → all 200)', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 5, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    for (let i = 0; i < 5; i++) {
      const res = await probe(app);
      expect(res.status).toBe(200);
    }
  });

  it('rejects the 6th request with status 429', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 5, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    for (let i = 0; i < 5; i++) await probe(app);
    const res = await probe(app);
    expect(res.status).toBe(429);
  });

  it('429 body is { error: "rate_limited", retry_after_ms: N } with N > 0', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    await probe(app);
    // Advance 1s — the kept timestamp is now 1s old, retry-after should be ~59s.
    clock.advance(1_000);
    const res = await probe(app);
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('rate_limited');
    expect(typeof body['retry_after_ms']).toBe('number');
    expect(body['retry_after_ms']).toBeGreaterThan(0);
    expect(body['retry_after_ms']).toBe(59_000);
  });

  it('429 sets Retry-After header to ceil(retry_after_ms / 1000)', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    await probe(app);
    clock.advance(500); // 500ms after the first hit
    const res = await probe(app);
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('retry-after');
    // retry_after_ms = 59_500 → ceil(59.5) = 60
    expect(retryAfter).toBe('60');
  });

  it('allows the same key again after the window elapses (sliding)', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    expect((await probe(app)).status).toBe(200);
    expect((await probe(app)).status).toBe(429);
    clock.advance(60_001);
    expect((await probe(app)).status).toBe(200);
  });

  it('different keys are independent', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    expect((await probe(app, '1.1.1.1')).status).toBe(200);
    // Alice is now over her quota.
    expect((await probe(app, '1.1.1.1')).status).toBe(429);
    // Bob is a different IP and is unaffected.
    expect((await probe(app, '2.2.2.2')).status).toBe(200);
  });

  it('rejected requests do NOT consume a slot (no perpetual lockout)', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const app = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    expect((await probe(app)).status).toBe(200);
    // 10 rejected attempts during the window.
    for (let i = 0; i < 10; i++) {
      clock.advance(1_000);
      expect((await probe(app)).status).toBe(429);
    }
    // Window finally elapses (relative to the ONE accepted timestamp).
    // First accepted hit was at t0; now we are at t0 + 10s. Advance past
    // the original window (60s total from t0): another 50_001ms.
    clock.advance(50_001);
    // The one accepted timestamp has now slid out → request succeeds.
    expect((await probe(app)).status).toBe(200);
  });

  it('per-call storage isolation — two factories share no state (Pitfall 1)', async () => {
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const appA = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    const appB = appWith(
      rateLimit({ limit: 1, windowMs: 60_000, clock, keyFn: joinKey }),
    );
    // Same IP, two independent middleware instances → each gets its own slot.
    expect((await probe(appA, '9.9.9.9')).status).toBe(200);
    expect((await probe(appB, '9.9.9.9')).status).toBe(200);
    // Both factories now at their quota → next attempt on each should 429.
    expect((await probe(appA, '9.9.9.9')).status).toBe(429);
    expect((await probe(appB, '9.9.9.9')).status).toBe(429);
  });
});

describe('parseLimitSpec', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('parses "30/min" → { limit: 30, windowMs: 60_000 }', () => {
    expect(parseLimitSpec('30/min', joinDefault)).toEqual({
      limit: 30,
      windowMs: 60_000,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('parses "5/sec" → { limit: 5, windowMs: 1_000 }', () => {
    expect(parseLimitSpec('5/sec', joinDefault)).toEqual({
      limit: 5,
      windowMs: 1_000,
    });
  });

  it('parses "100/hour" → { limit: 100, windowMs: 3_600_000 }', () => {
    expect(parseLimitSpec('100/hour', joinDefault)).toEqual({
      limit: 100,
      windowMs: 3_600_000,
    });
  });

  it('returns defaults on undefined input (no warning — env-var unset is expected)', () => {
    expect(parseLimitSpec(undefined, suggestionDefault)).toEqual(suggestionDefault);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns defaults on garbage input and warns', () => {
    expect(parseLimitSpec('garbage', commentDefault)).toEqual(commentDefault);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/malformed/i);
  });

  it('returns defaults when the window unit is unknown', () => {
    expect(parseLimitSpec('30/wrong-window', joinDefault)).toEqual(joinDefault);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns defaults on negative limit', () => {
    expect(parseLimitSpec('-5/min', joinDefault)).toEqual(joinDefault);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/non-positive/i);
  });

  it('returns defaults on zero limit', () => {
    expect(parseLimitSpec('0/min', joinDefault)).toEqual(joinDefault);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('joinKey', () => {
  it('prefers cf-connecting-ip when present', async () => {
    const app = new Hono();
    let observed = '';
    app.get('/k', (c) => {
      observed = joinKey(c);
      return c.text('ok');
    });
    await app.request('/k', {
      headers: {
        'cf-connecting-ip': '198.51.100.7',
        'x-forwarded-for': '203.0.113.1, 10.0.0.1',
      },
    });
    expect(observed).toBe('198.51.100.7');
  });

  it('falls back to the first x-forwarded-for entry when cf-connecting-ip is absent', async () => {
    const app = new Hono();
    let observed = '';
    app.get('/k', (c) => {
      observed = joinKey(c);
      return c.text('ok');
    });
    await app.request('/k', {
      headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.99, 192.168.1.1' },
    });
    expect(observed).toBe('203.0.113.5');
  });

  it('returns "unknown" when no IP headers are present', async () => {
    const app = new Hono();
    let observed = '';
    app.get('/k', (c) => {
      observed = joinKey(c);
      return c.text('ok');
    });
    await app.request('/k');
    expect(observed).toBe('unknown');
  });
});

describe('cookieKey', () => {
  it('reads the sb_p cookie', async () => {
    const app = new Hono();
    let observed = '';
    app.get('/k', (c) => {
      observed = cookieKey(c);
      return c.text('ok');
    });
    await app.request('/k', { headers: { cookie: 'sb_p=sb_p_abc123; other=ignored' } });
    expect(observed).toBe('sb_p_abc123');
  });

  it('returns "no-cookie" when sb_p is absent', async () => {
    const app = new Hono();
    let observed = '';
    app.get('/k', (c) => {
      observed = cookieKey(c);
      return c.text('ok');
    });
    await app.request('/k');
    expect(observed).toBe('no-cookie');
  });
});

describe('startEvictor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears keys whose timestamps are all older than the window when the interval fires', () => {
    vi.useFakeTimers();
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const store = new Map<string, number[]>();
    const now = clock.now().getTime();
    store.set('alice', [now]);
    store.set('bob', [now, now - 70_000]); // mixed: one in-window, one expired
    store.set('cleo', [now - 70_000, now - 80_000]); // all expired

    const handle = startEvictor(store, 60_000, clock);
    try {
      // Advance both the clock (so timestamps drift out of the window)
      // and the timer queue (so the setInterval callback actually runs).
      clock.advance(60_001);
      vi.advanceTimersByTime(60_000);

      // alice: her sole timestamp is now 60_001 ms old → outside window → key dropped
      expect(store.has('alice')).toBe(false);
      // bob: had a fresh-ish timestamp; after the clock advance, both are stale → key dropped
      expect(store.has('bob')).toBe(false);
      // cleo: all stale from the start → key dropped
      expect(store.has('cleo')).toBe(false);
    } finally {
      handle.stop();
    }
  });

  it('stop() clears the interval (timer count decreases)', () => {
    vi.useFakeTimers();
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const store = new Map<string, number[]>();
    const before = vi.getTimerCount();
    const handle = startEvictor(store, 60_000, clock);
    expect(vi.getTimerCount()).toBe(before + 1);
    handle.stop();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('keeps in-window timestamps and trims stale ones without dropping the key', () => {
    vi.useFakeTimers();
    const clock = fixedClock('2026-05-19T12:00:00Z');
    const store = new Map<string, number[]>();
    const now = clock.now().getTime();
    // 'mixed' has one timestamp that will still be in-window after a 10s advance
    // and one that will be expired.
    store.set('mixed', [now - 55_000, now]);

    const handle = startEvictor(store, 60_000, clock);
    try {
      clock.advance(10_000); // cutoff is now now-50_000; (-55_000) is stale, (0) is fresh
      vi.advanceTimersByTime(60_000);
      const kept = store.get('mixed');
      expect(kept).toBeDefined();
      expect(kept).toEqual([now]);
    } finally {
      handle.stop();
    }
  });
});
