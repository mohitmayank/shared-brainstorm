import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './server.js';
import { SessionManager } from '../session/SessionManager.js';
import { fixedClock } from '../session/clock.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(opts: {
  maxParticipants?: number;
  maxCommentsPerQuestion?: number;
  secureCookie?: boolean;
} = {}) {
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    transcriptDir: mkdtempSync(join(tmpdir(), 'sb-')),
    ...(opts.maxParticipants !== undefined ? { maxParticipants: opts.maxParticipants } : {}),
    ...(opts.maxCommentsPerQuestion !== undefined
      ? { maxCommentsPerQuestion: opts.maxCommentsPerQuestion }
      : {}),
  });
  mgr.start({ brief: 'auth flow' });
  const app = buildApp({
    manager: mgr,
    ...(opts.secureCookie !== undefined ? { secureCookie: opts.secureCookie } : {}),
  });
  return { app, mgr };
}

function json(body: Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  return { method: 'POST' as const, body: JSON.stringify(body), headers };
}

async function joinAs(app: ReturnType<typeof buildApp>, mgr: SessionManager, name: string) {
  const body: Record<string, string> = { display_name: name, join_code: mgr.joinCode() };
  const res = await app.request('/api/join', json(body));
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const data = (await res.json()) as { id: string; display_name: string };
  return { cookie, ...data };
}

describe('HTTP API', () => {
  it('GET /api/session returns 401 if not joined', async () => {
    const { app } = setup();
    const res = await app.request('/api/session');
    expect(res.status).toBe(401);
  });

  it('POST /api/join requires correct join_code', async () => {
    const { app } = setup();
    const bad = await app.request('/api/join', json({ display_name: 'A', join_code: '000000' }));
    expect(bad.status).toBe(403);
  });

  it('POST /api/join with correct code returns participant (no role field)', async () => {
    const { app, mgr } = setup();
    const res = await app.request(
      '/api/join',
      json({ display_name: 'Alice', join_code: mgr.joinCode() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['display_name']).toBe('Alice');
    expect('role' in body).toBe(false);
    expect(res.headers.get('set-cookie')).toMatch(/sb_p=/);
  });

  it('POST /api/join ignores coordinator_token (legacy field)', async () => {
    const { app, mgr } = setup();
    const res = await app.request(
      '/api/join',
      json({
        display_name: 'C',
        join_code: mgr.joinCode(),
        coordinator_token: 'sbc_anything',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('role' in body).toBe(false);
  });

  it('POST /api/suggestion requires joined cookie', async () => {
    const { app } = setup();
    const r = await app.request('/api/suggestion', json({ question_id: 'x', value: 'y' }));
    expect(r.status).toBe(401);
  });

  it('POST /api/accept route is gone', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    mgr.askGroup({ question: 'q' });
    const r = await app.request(
      '/api/accept',
      json({ question_id: mgr.currentQuestion()!.id, value: 'a' }, cookie),
    );
    expect(r.status).toBe(404);
  });

  it('POST /api/preview-approve route is gone', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    const r = await app.request(
      '/api/preview-approve',
      json({ question_id: 'x' }, cookie),
    );
    expect(r.status).toBe(404);
  });

  it('POST /api/preview-default route is gone', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    const r = await app.request(
      '/api/preview-default',
      json({ preview_default: false }, cookie),
    );
    expect(r.status).toBe(404);
  });

  it('GET /api/session returns session view for joined participant', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    const r = await app.request('/api/session', { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { brief: string };
    expect(body.brief).toBe('auth flow');
  });

  // ---------------------------------------------------------------------------
  // REL-09: Secure cookie flag (D-13 / D-16)
  // ---------------------------------------------------------------------------
  describe('Secure cookie flag (REL-09)', () => {
    it('POST /api/join sets Secure on the cookie when buildApp({secureCookie:true})', async () => {
      const { app, mgr } = setup({ secureCookie: true });
      const res = await app.request(
        '/api/join',
        json({ display_name: 'Alice', join_code: mgr.joinCode() }),
      );
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toMatch(/sb_p=/);
      expect(cookie).toMatch(/; Secure(?:;|$)/);
      // D-16: other attributes unchanged.
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Max-Age=86400/);
    });

    it('POST /api/join does NOT set Secure when buildApp({secureCookie:false})', async () => {
      const { app, mgr } = setup({ secureCookie: false });
      const res = await app.request(
        '/api/join',
        json({ display_name: 'Bob', join_code: mgr.joinCode() }),
      );
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toMatch(/sb_p=/);
      expect(cookie).not.toMatch(/Secure/);
    });

    it('POST /api/join does NOT set Secure when buildApp() omits secureCookie (LAN default)', async () => {
      const { app, mgr } = setup();
      const res = await app.request(
        '/api/join',
        json({ display_name: 'Carol', join_code: mgr.joinCode() }),
      );
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toMatch(/sb_p=/);
      expect(cookie).not.toMatch(/Secure/);
    });
  });

  // ---------------------------------------------------------------------------
  // REL-07: cap → 409 mapping (D-06)
  // ---------------------------------------------------------------------------
  describe('cap → 409 mapping (REL-07 / D-06)', () => {
    it('POST /api/join returns 409 cap_exceeded when maxParticipants reached', async () => {
      const { app, mgr } = setup({ maxParticipants: 2 });
      const body = (name: string) => ({ display_name: name, join_code: mgr.joinCode() });
      const r1 = await app.request('/api/join', json(body('A')));
      const r2 = await app.request('/api/join', json(body('B')));
      const r3 = await app.request('/api/join', json(body('C')));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(409);
      const payload = (await r3.json()) as { error: string; limit: number };
      expect(payload).toEqual({ error: 'cap_exceeded', limit: 2 });
      // D-06: response body must NOT include the granular suffix
      // (`:participants` / etc.) — that stays server-side.
      expect((payload as Record<string, unknown>)['code']).toBeUndefined();
    });

    it('POST /api/comment returns 409 cap_exceeded when maxCommentsPerQuestion reached', async () => {
      const { app, mgr } = setup({ maxCommentsPerQuestion: 1 });
      const { cookie } = await joinAs(app, mgr, 'Alice');
      mgr.askGroup({ question: 'q?' });
      const qid = mgr.currentQuestion()!.id;
      const c1 = await app.request(
        '/api/comment',
        json({ question_id: qid, text: 'first' }, cookie),
      );
      const c2 = await app.request(
        '/api/comment',
        json({ question_id: qid, text: 'second' }, cookie),
      );
      expect(c1.status).toBe(200);
      expect(c2.status).toBe(409);
      const payload = (await c2.json()) as { error: string; limit: number };
      expect(payload).toEqual({ error: 'cap_exceeded', limit: 1 });
    });

    it('cap 409 and rate-limit 429 are distinct codes (sanity)', async () => {
      const { app, mgr } = setup({ maxParticipants: 1 });
      const body = (name: string) => ({ display_name: name, join_code: mgr.joinCode() });
      const r1 = await app.request('/api/join', json(body('A')));
      const r2 = await app.request('/api/join', json(body('B')));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(409);
      const payload = (await r2.json()) as { error: string };
      expect(payload.error).toBe('cap_exceeded');
      expect(payload.error).not.toBe('rate_limited');
    });
  });

  // ---------------------------------------------------------------------------
  // REL-06: rate-limit route wiring (HTTP-level)
  // Full middleware unit coverage lives in 02-01's rateLimit.test.ts.
  // Test (1) is REQUIRED — it's the only HTTP-level proof that the middleware
  // is mounted on /api/join. Tests (2)/(3) MAY be skipped if flaky.
  // ---------------------------------------------------------------------------
  describe('rate-limit wiring (REL-06)', () => {
    const ENV_KEY = 'SHARED_BRAINSTORM_RATE_LIMIT_JOIN';
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env[ENV_KEY];
      // Tighten the join window to 5/min so a 6th rapid request trips it.
      process.env[ENV_KEY] = '5/min';
    });

    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
    });

    it('POST /api/join 6× in rapid succession — 6th request is 429 with retry_after_ms', async () => {
      // Build the app AFTER setting the env var so the middleware reads it.
      const { app, mgr } = setup();
      const mkBody = (name: string) => ({ display_name: name, join_code: mgr.joinCode() });
      const statuses: number[] = [];
      let lastBody: unknown = null;
      let lastHeaders: Headers | null = null;
      for (let i = 0; i < 6; i++) {
        const r = await app.request('/api/join', json(mkBody(`U${i}`)));
        statuses.push(r.status);
        if (i === 5) {
          lastHeaders = r.headers;
          lastBody = await r.json();
        }
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      const body = lastBody as { error: string; retry_after_ms: number };
      expect(body.error).toBe('rate_limited');
      expect(body.retry_after_ms).toBeGreaterThan(0);
      expect(lastHeaders!.get('Retry-After')).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // COORD-01: POST /api/coordinator/join (cookie + token gate)
  // ---------------------------------------------------------------------------
  describe('http — POST /api/coordinator/join', () => {
    it('200 on valid token, sets sb_c cookie containing the token', async () => {
      const { app, mgr } = setup();
      const token = mgr.coordinatorToken();
      const res = await app.request('/api/coordinator/join', json({ token }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toMatch(new RegExp(`sb_c=${token}`));
    });

    it('400 on malformed JSON / missing body', async () => {
      const { app } = setup();
      const res = await app.request('/api/coordinator/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    });

    it('400 on empty token (Zod min(1))', async () => {
      const { app } = setup();
      const res = await app.request('/api/coordinator/join', json({ token: '' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    });

    it('401 on wrong-length token, sets no cookie', async () => {
      const { app } = setup();
      const res = await app.request('/api/coordinator/join', json({ token: 'aaaa' }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
      expect(res.headers.get('set-cookie')).toBe(null);
    });

    it('401 on same-length wrong-content token (exercises timingSafeEqual), sets no cookie', async () => {
      const { app, mgr } = setup();
      const len = mgr.coordinatorToken().length;
      const wrong = 'Z'.repeat(len);
      const res = await app.request('/api/coordinator/join', json({ token: wrong }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
      expect(res.headers.get('set-cookie')).toBe(null);
    });

    it('404 with session_ended when no active session', async () => {
      const { app, mgr } = setup();
      const token = mgr.coordinatorToken();
      mgr.stop('stop_session');
      const res = await app.request('/api/coordinator/join', json({ token }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'session_ended' });
    });

    it('idempotent double-join — both 200, same cookie value', async () => {
      const { app, mgr } = setup();
      const token = mgr.coordinatorToken();
      const r1 = await app.request('/api/coordinator/join', json({ token }));
      const r2 = await app.request('/api/coordinator/join', json({ token }));
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const c1 = r1.headers.get('set-cookie')!.split(';')[0];
      const c2 = r2.headers.get('set-cookie')!.split(';')[0];
      expect(c1).toBe(c2);
    });

    it('cookie posture LAN (secureCookie:false) — no Secure attribute', async () => {
      const { app, mgr } = setup({ secureCookie: false });
      const res = await app.request('/api/coordinator/join', json({ token: mgr.coordinatorToken() }));
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie')!;
      expect(cookie).toMatch(/sb_c=/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Max-Age=86400/);
      expect(cookie).not.toMatch(/Secure/);
    });

    it('cookie posture cloudflared (secureCookie:true) — Secure on both sb_c and sb_p (one thunk)', async () => {
      const { app, mgr } = setup({ secureCookie: true });
      // sb_c via coordinator join
      const coordRes = await app.request(
        '/api/coordinator/join',
        json({ token: mgr.coordinatorToken() }),
      );
      expect(coordRes.status).toBe(200);
      expect(coordRes.headers.get('set-cookie')).toMatch(/sb_c=.*; Secure(?:;|$)/);
      // sb_p via participant join — same buildApp instance, same thunk
      const joinRes = await app.request(
        '/api/join',
        json({ display_name: 'Alice', join_code: mgr.joinCode() }),
      );
      expect(joinRes.status).toBe(200);
      expect(joinRes.headers.get('set-cookie')).toMatch(/sb_p=.*; Secure(?:;|$)/);
    });
  });
});
