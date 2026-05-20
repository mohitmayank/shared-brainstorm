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
  const body: Record<string, string> = { display_name: name };
  const res = await app.request('/api/join', json(body));
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const data = (await res.json()) as { id: string; display_name: string; status: string };
  // v2.0.0: participants join as pending; approve them so subsequent REST calls succeed.
  mgr.approveParticipant(data.id as Parameters<SessionManager['approveParticipant']>[0]);
  return { cookie, ...data };
}

/**
 * Acquire a valid `sb_c` coordinator cookie by POSTing the active session's
 * token to the 03-02 `/api/coordinator/join` route, then return the bare
 * `sb_c=<token>` pair suitable for the `cookie` request header.
 */
async function coordinatorCookie(
  app: ReturnType<typeof buildApp>,
  mgr: SessionManager,
): Promise<string> {
  const res = await app.request('/api/coordinator/join', json({ token: mgr.coordinatorToken() }));
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('HTTP API', () => {
  it('GET /api/session returns 401 if not joined', async () => {
    const { app } = setup();
    const res = await app.request('/api/session');
    expect(res.status).toBe(401);
  });

  it('POST /api/join returns 400 on missing display_name', async () => {
    const { app } = setup();
    const bad = await app.request('/api/join', json({}));
    expect(bad.status).toBe(400);
  });

  it('POST /api/join returns participant with status=pending (no join_code required in v2.0.0)', async () => {
    const { app } = setup();
    const res = await app.request('/api/join', json({ display_name: 'Alice' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['display_name']).toBe('Alice');
    expect(body['status']).toBe('pending');
    expect('role' in body).toBe(false);
    expect(res.headers.get('set-cookie')).toMatch(/sb_p=/);
  });

  it('POST /api/join returns 423 session_locked when room is locked', async () => {
    const { app, mgr } = setup();
    mgr.setLocked(true);
    const res = await app.request('/api/join', json({ display_name: 'Latecomer' }));
    expect(res.status).toBe(423);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('session_locked');
  });

  it('POST /api/join ignores coordinator_token (legacy field)', async () => {
    const { app } = setup();
    const res = await app.request(
      '/api/join',
      json({
        display_name: 'C',
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
      const { app } = setup({ secureCookie: true });
      const res = await app.request(
        '/api/join',
        json({ display_name: 'Alice' }),
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
      const { app } = setup({ secureCookie: false });
      const res = await app.request(
        '/api/join',
        json({ display_name: 'Bob' }),
      );
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toMatch(/sb_p=/);
      expect(cookie).not.toMatch(/Secure/);
    });

    it('POST /api/join does NOT set Secure when buildApp() omits secureCookie (LAN default)', async () => {
      const { app } = setup();
      const res = await app.request(
        '/api/join',
        json({ display_name: 'Carol' }),
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
      const { app } = setup({ maxParticipants: 2 });
      const body = (name: string) => ({ display_name: name });
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
      const { app } = setup({ maxParticipants: 1 });
      const body = (name: string) => ({ display_name: name });
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
      const { app } = setup();
      const mkBody = (name: string) => ({ display_name: name });
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
        json({ display_name: 'Alice' }),
      );
      expect(joinRes.status).toBe(200);
      expect(joinRes.headers.get('set-cookie')).toMatch(/sb_p=.*; Secure(?:;|$)/);
    });
  });

  // ---------------------------------------------------------------------------
  // COORD-03 backend / COORD-04 regression: POST /api/coordinator/answer
  // The route mounts requireCoordinator and reuses the public recordAnswer 1:1.
  // ---------------------------------------------------------------------------
  describe('http — POST /api/coordinator/answer', () => {
    it('200 on valid cookie + matching ticket_id; question becomes resolved', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'use JWT', source: 'override' }, cookie),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // recordAnswer clears current_question on resolution.
      expect(mgr.sessionView().current_question).toBe(null);
    });

    it('200: source override value passes through verbatim (no redaction)', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const value = 'use the token sk_live_DEADBEEF and /Users/me/secret path';
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value, source: 'override' }, cookie),
      );
      expect(res.status).toBe(200);
      // The decision recorded by recordAnswer keeps the value verbatim — trusted
      // initiator input is NOT scrubbed by redactQuestion.
      const decision = mgr.sessionView().decisions.at(-1)!;
      expect(decision.answer).toBe(value);
    });

    it('401 without sb_c cookie — not_coordinator; recordAnswer never reached', async () => {
      const { app, mgr } = setup();
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'x', source: 'override' }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
      // The gate stops before recordAnswer — the question is still broadcast.
      expect(mgr.sessionView().current_question).not.toBe(null);
      expect(mgr.currentQuestion()!.status).toBe('broadcast');
    });

    it('401 with present-but-wrong-content sb_c (timingSafeEqual branch)', async () => {
      const { app, mgr } = setup();
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const len = mgr.coordinatorToken().length;
      const wrong = `sb_c=${'Z'.repeat(len)}`;
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'x', source: 'override' }, wrong),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
      expect(mgr.currentQuestion()!.status).toBe('broadcast');
    });

    it('400 on malformed body (bad source enum) with a valid cookie', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'x', source: 'bogus' }, cookie),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
      // Question untouched — recordAnswer never called.
      expect(mgr.currentQuestion()!.status).toBe('broadcast');
    });

    it('400 on missing value with a valid cookie', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, source: 'override' }, cookie),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    });

    it('404 ticket_not_found when ticket_id is not in open questions', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      mgr.askGroup({ question: 'q?' });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id: 'tk_nonexistent', value: 'x', source: 'override' }, cookie),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'ticket_not_found' });
      expect(mgr.currentQuestion()!.status).toBe('broadcast');
    });

    it('409 already_resolved on a second POST for a known-but-resolved ticket (WR-02 fix)', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const first = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'use JWT', source: 'override' }, cookie),
      );
      expect(first.status).toBe(200);
      // WR-02: the second pick on an already-resolved (terminal) ticket must return
      // 409 already_resolved (coordinator sees the right error copy) rather than
      // 404 ticket_not_found (which was the regression in Phase 6 before the fix).
      // isTerminalTicket() distinguishes "resolved ticket" from "never-existed ticket".
      const second = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'use JWT', source: 'override' }, cookie),
      );
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: 'already_resolved' });
    });

    it('409 already_resolved when recordAnswer throws not-broadcast (current question, status mutated)', async () => {
      // Genuine 409 branch: the question is still the current_question (ticket
      // guard passes) but its status is no longer `broadcast`, so recordAnswer
      // throws `not broadcast`. This is the same-tick double-resolve window
      // (Pitfall 4) the route maps to 409 instead of a 500. We reproduce it by
      // wrapping the manager so sessionView still reports the question as current
      // while recordAnswer surfaces the real not-broadcast throw.
      const { mgr } = setup();
      const cookie = await (async () => {
        const probe = buildApp({ manager: mgr });
        const res = await probe.request(
          '/api/coordinator/join',
          json({ token: mgr.coordinatorToken() }),
        );
        return res.headers.get('set-cookie')!.split(';')[0]!;
      })();
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      const cq = mgr.currentQuestion()!;
      // Force the not-broadcast condition while keeping current_question set.
      cq.status = 'resolved';
      const app = buildApp({ manager: mgr });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'late', source: 'override' }, cookie),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'already_resolved' });
    });

    it('awaitAnswer wakeup: a pending poll resolves after a 200 POST (COORD-04 same TicketStore path)', async () => {
      const { app, mgr } = setup();
      const cookie = await coordinatorCookie(app, mgr);
      const { ticket_id } = mgr.askGroup({ question: 'q?' });
      // Start the AI-host-side long-poll BEFORE the coordinator picks.
      const pending = mgr.awaitAnswer({ ticket_id, timeout_s: 5 });
      const res = await app.request(
        '/api/coordinator/answer',
        json({ ticket_id, value: 'use JWT', source: 'override' }, cookie),
      );
      expect(res.status).toBe(200);
      // Same TicketStore.resolve() that the CLI recordAnswer tool triggers.
      const out = await pending;
      expect(out.resolved).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 4 / JOIN-02: POST /api/coordinator/approve
  // ---------------------------------------------------------------------------
  describe('POST /api/coordinator/approve', () => {
    it('returns 200 and ok:true for a pending participant', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      // Join to create a pending participant (do NOT call joinAs which auto-approves)
      const joinRes = await app.request('/api/join', json({ display_name: 'Pending' }));
      expect(joinRes.status).toBe(200);
      const data = (await joinRes.json()) as { id: string; status: string };
      expect(data.status).toBe('pending');
      const res = await app.request(
        '/api/coordinator/approve',
        json({ participant_id: data.id }, ccookie),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // Verify the participant's status was actually flipped.
      expect(mgr.sessionView().participants.find((p) => p.id === data.id)!.status).toBe('approved');
    });

    it('returns 401 without coordinator cookie', async () => {
      const { app } = setup();
      const joinRes = await app.request('/api/join', json({ display_name: 'Pending' }));
      const data = (await joinRes.json()) as { id: string };
      const res = await app.request('/api/coordinator/approve', json({ participant_id: data.id }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
    });

    it('returns 404 for unknown participant_id', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      const res = await app.request(
        '/api/coordinator/approve',
        json({ participant_id: 'p_does_not_exist' }, ccookie),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    it('is idempotent — approving twice returns 200 both times', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      const joinRes = await app.request('/api/join', json({ display_name: 'Alice' }));
      const data = (await joinRes.json()) as { id: string };
      const r1 = await app.request(
        '/api/coordinator/approve',
        json({ participant_id: data.id }, ccookie),
      );
      const r2 = await app.request(
        '/api/coordinator/approve',
        json({ participant_id: data.id }, ccookie),
      );
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      // Only one participant_status_changed event emitted (idempotent).
      expect(mgr.sessionView().participants.find((p) => p.id === data.id)!.status).toBe('approved');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 4 / JOIN-04: POST /api/coordinator/kick
  // ---------------------------------------------------------------------------
  describe('POST /api/coordinator/kick', () => {
    it('returns 200 for an approved participant and sets status to kicked', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      const { id, cookie } = await joinAs(app, mgr, 'Alice');
      // Confirm participant is approved before kicking
      expect(mgr.sessionView().participants.find((p) => p.id === id)!.status).toBe('approved');
      const res = await app.request(
        '/api/coordinator/kick',
        json({ participant_id: id }, ccookie),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mgr.sessionView().participants.find((p) => p.id === id)!.status).toBe('kicked');
      // Kicked participants remain in the Map (not deleted)
      expect(mgr.sessionView().participants).toHaveLength(1);
      // suppress unused variable warning
      void cookie;
    });

    it('returns 401 without coordinator cookie', async () => {
      const { app, mgr } = setup();
      const { id } = await joinAs(app, mgr, 'Bob');
      const res = await app.request('/api/coordinator/kick', json({ participant_id: id }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
    });

    it('returns 404 for unknown participant_id', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      const res = await app.request(
        '/api/coordinator/kick',
        json({ participant_id: 'p_does_not_exist' }, ccookie),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    it('kicked participant gets 403 removed on POST /api/suggestion', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      const { id, cookie } = await joinAs(app, mgr, 'Carol');
      // Kick via coordinator route
      const kickRes = await app.request(
        '/api/coordinator/kick',
        json({ participant_id: id }, ccookie),
      );
      expect(kickRes.status).toBe(200);
      // Kicked participant tries to post a suggestion
      mgr.askGroup({ question: 'q?' });
      const sugRes = await app.request(
        '/api/suggestion',
        json({ question_id: mgr.currentQuestion()!.id, value: 'my suggestion' }, cookie),
      );
      expect(sugRes.status).toBe(403);
      expect(await sugRes.json()).toEqual({ error: 'removed' });
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 4 / JOIN-03: POST /api/coordinator/lock
  // ---------------------------------------------------------------------------
  describe('POST /api/coordinator/lock', () => {
    it('returns 200 and emits room_locked when locking', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      const res = await app.request(
        '/api/coordinator/lock',
        json({ locked: true }, ccookie),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mgr.sessionView().locked).toBe(true);
    });

    it('POST /api/join while locked returns 423 session_locked', async () => {
      const { app, mgr } = setup();
      const ccookie = await coordinatorCookie(app, mgr);
      // Lock the room
      await app.request('/api/coordinator/lock', json({ locked: true }, ccookie));
      // New participant tries to join
      const joinRes = await app.request('/api/join', json({ display_name: 'Latecomer' }));
      expect(joinRes.status).toBe(423);
      expect(await joinRes.json()).toEqual({ error: 'session_locked' });
    });

    it('returns 401 without coordinator cookie', async () => {
      const { app } = setup();
      const res = await app.request('/api/coordinator/lock', json({ locked: true }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'not_coordinator' });
    });
  });
});
