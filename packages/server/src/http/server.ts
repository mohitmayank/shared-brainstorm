import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { SessionManager } from '../session/SessionManager.js';
import type { Participant, ParticipantId, QuestionId } from '@shared-brainstorm/shared';
import {
  readCoordinatorCookie,
  readParticipantCookie,
  setCoordinatorCookie,
  setParticipantCookie,
} from './cookies.js';
import { realClock } from '../session/clock.js';
import {
  rateLimit,
  parseLimitSpec,
  joinKey,
  cookieKey,
  joinDefault,
  suggestionDefault,
  commentDefault,
} from './middleware/rateLimit.js';

type AppEnv = { Variables: { participant: Participant } };

const JoinBody = z.object({
  display_name: z.string().min(1).max(40),
  join_code: z.string().regex(/^\d{6}$/),
});

const SuggestionBody = z.object({
  question_id: z.string(),
  value: z.string().min(1).max(2000),
  rationale: z.string().max(2000).optional(),
});

const CommentBody = z.object({
  question_id: z.string(),
  text: z.string().min(1).max(4000),
});

const CoordinatorJoinBody = z.object({
  token: z.string().min(1).max(64),
});

/**
 * REL-07 / D-06: type-narrowing guard for cap errors thrown by SessionManager.
 * Cap errors carry a string `code` starting with `cap_exceeded` and a numeric
 * `limit`. Anything else bubbles to Hono's default 500 handler.
 */
function isCapError(e: unknown): e is Error & { code: string; limit: number } {
  if (!(e instanceof Error)) return false;
  const code = (e as Error & { code?: unknown }).code;
  const limit = (e as Error & { limit?: unknown }).limit;
  return typeof code === 'string' && code.startsWith('cap_exceeded') && typeof limit === 'number';
}

export function buildApp({
  manager,
  secureCookie = false,
}: {
  manager: SessionManager;
  /**
   * Whether to set the `Secure` attribute on the participant cookie. Wired by
   * `startHttpServer` from the active transport's `secureCookie` advisory
   * (REL-09 / D-13 / D-16). Accepts either a static boolean (most callers,
   * incl. unit tests) or a thunk so that `startSession` can update the value
   * AFTER `transport.start()` has resolved but BEFORE the first `/api/join`
   * request lands (see tools.ts boot-order rationale: HTTP boots before
   * transport.start() can run because the transport needs the local port).
   * Defaults to `false` so callers that haven't been updated keep LAN behavior.
   */
  secureCookie?: boolean | (() => boolean);
}): Hono<AppEnv> {
  const resolveSecure: () => boolean =
    typeof secureCookie === 'function' ? secureCookie : () => secureCookie;
  const app = new Hono<AppEnv>();

  // REL-06: rate-limit middlewares. Read env vars at build time; fall back to
  // the per-route defaults from `./middleware/rateLimit.js` if unset or
  // malformed (parseLimitSpec is total — never throws).
  //
  // Evictor not wired in this iteration — the Map lives in the middleware
  // closure for the lifetime of this app instance (one per session), and the
  // janitor in 02-01 is a 60s `.unref()` interval, so dropping it on GC is
  // fine for now. If future scope needs explicit eviction wiring, the factory
  // still exports `startEvictor` for use by `startHttpServer`.
  const joinSpec = parseLimitSpec(process.env['SHARED_BRAINSTORM_RATE_LIMIT_JOIN'], joinDefault);
  const suggestionSpec = parseLimitSpec(
    process.env['SHARED_BRAINSTORM_RATE_LIMIT_SUGGESTION'],
    suggestionDefault,
  );
  const commentSpec = parseLimitSpec(
    process.env['SHARED_BRAINSTORM_RATE_LIMIT_COMMENT'],
    commentDefault,
  );

  // D-01: /api/join uses per-IP (no cookie yet); /api/suggestion and
  // /api/comment use per-cookie (cookie always present once joined).
  const joinRateLimit = rateLimit<AppEnv>({
    limit: joinSpec.limit,
    windowMs: joinSpec.windowMs,
    keyFn: joinKey,
    clock: realClock,
  });
  const suggestionRateLimit = rateLimit<AppEnv>({
    limit: suggestionSpec.limit,
    windowMs: suggestionSpec.windowMs,
    keyFn: cookieKey,
    clock: realClock,
  });
  const commentRateLimit = rateLimit<AppEnv>({
    limit: commentSpec.limit,
    windowMs: commentSpec.windowMs,
    keyFn: cookieKey,
    clock: realClock,
  });

  app.post('/api/join', joinRateLimit, async (c) => {
    const parsed = JoinBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    if (parsed.data.join_code !== manager.joinCode())
      return c.json({ error: 'bad_join_code' }, 403);
    let p: Participant;
    try {
      p = manager.addParticipant({ display_name: parsed.data.display_name });
    } catch (e) {
      if (isCapError(e)) return c.json({ error: 'cap_exceeded', limit: e.limit }, 409);
      throw e;
    }
    setParticipantCookie(c, p.id, { secure: resolveSecure() });
    return c.json({ id: p.id, display_name: p.display_name });
  });

  const requireParticipant: MiddlewareHandler<AppEnv> = async (c, next) => {
    const id = readParticipantCookie(c);
    if (!id) return c.json({ error: 'not_joined' }, 401);
    const v = manager.sessionView();
    const p = v.participants.find((x) => x.id === id);
    if (!p) return c.json({ error: 'not_joined' }, 401);
    c.set('participant', p);
    await next();
  };

  /**
   * Gates the coordinator-only routes (the answer endpoint lands in Slice 4;
   * this middleware is declared here but NOT mounted on any route in this
   * plan). Compares the `sb_c` cookie against the active session's coordinator
   * token using `node:crypto.timingSafeEqual` behind a length pre-check so the
   * compare never throws on mismatched buffer lengths (cross-cutting concern 3).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const requireCoordinator: MiddlewareHandler<AppEnv> = async (c, next) => {
    const cookie = readCoordinatorCookie(c);
    if (!cookie) return c.json({ error: 'not_coordinator' }, 401);
    let expected: string;
    try {
      expected = manager.coordinatorToken();
    } catch {
      // The session is no longer active (mcpState.manager = null after
      // stopSession). A late coordinator request after teardown returns 401
      // with a distinct error code, not a 500.
      return c.json({ error: 'session_ended' }, 401);
    }
    if (cookie.length !== expected.length) {
      return c.json({ error: 'not_coordinator' }, 401);
    }
    if (!timingSafeEqual(Buffer.from(cookie, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return c.json({ error: 'not_coordinator' }, 401);
    }
    await next();
  };

  // Coordinator authentication. NOT rate-limited — privileged endpoint
  // (RESEARCH §"Rate limiting"). Distinct error codes let Slice 5 branch copy:
  // `session_ended` (404) vs `not_coordinator` (401). Naturally idempotent — a
  // second valid POST re-issues the same cookie value.
  app.post('/api/coordinator/join', async (c) => {
    const parsed = CoordinatorJoinBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    let expected: string;
    try {
      expected = manager.coordinatorToken();
    } catch {
      return c.json({ error: 'session_ended' }, 404);
    }
    const supplied = parsed.data.token;
    if (supplied.length !== expected.length) {
      return c.json({ error: 'not_coordinator' }, 401);
    }
    if (!timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return c.json({ error: 'not_coordinator' }, 401);
    }
    setCoordinatorCookie(c, supplied, { secure: resolveSecure() });
    return c.json({ ok: true });
  });

  app.get('/api/session', requireParticipant, (c) => c.json(manager.sessionView()));

  // D-01: rate-limit BEFORE requireParticipant so we don't pay the cookie
  // lookup cost on flooding clients.
  app.post('/api/suggestion', suggestionRateLimit, requireParticipant, async (c) => {
    const parsed = SuggestionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    const p = c.get('participant');
    const args: Parameters<typeof manager.postSuggestion>[0] = {
      participant_id: p.id as ParticipantId,
      question_id: parsed.data.question_id as QuestionId,
      value: parsed.data.value,
    };
    if (parsed.data.rationale !== undefined) args.rationale = parsed.data.rationale;
    try {
      manager.postSuggestion(args);
    } catch (e) {
      if (isCapError(e)) return c.json({ error: 'cap_exceeded', limit: e.limit }, 409);
      throw e;
    }
    return c.json({ ok: true });
  });

  app.post('/api/comment', commentRateLimit, requireParticipant, async (c) => {
    const parsed = CommentBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    const p = c.get('participant');
    try {
      manager.postComment({
        participant_id: p.id as ParticipantId,
        question_id: parsed.data.question_id as QuestionId,
        text: parsed.data.text,
      });
    } catch (e) {
      if (isCapError(e)) return c.json({ error: 'cap_exceeded', limit: e.limit }, 409);
      throw e;
    }
    return c.json({ ok: true });
  });

  return app;
}
