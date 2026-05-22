import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { createHash, timingSafeEqual } from 'node:crypto';
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

const CoordinatorAnswerBody = z.object({
  ticket_id: z.string(),
  value: z.string().min(1).max(2000),
  source: z.enum(['suggestion', 'synthesis', 'override']),
});

// Coordinator-as-planner: the coordinator contributes their own answer as a
// suggestion in the pool (not an immediate finalize). No `source` — it lands as
// a regular suggestion and is picked later via the existing answer route.
const CoordinatorSuggestionBody = z.object({
  ticket_id: z.string(),
  value: z.string().min(1).max(2000),
  rationale: z.string().max(2000).optional(),
});

const ApproveBody = z.object({ participant_id: z.string() });
const KickBody = z.object({ participant_id: z.string() });
const LockBody = z.object({ locked: z.boolean() });

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

/**
 * CR-01: constant-time coordinator-token comparison with no length oracle.
 * Both the supplied and expected tokens are hashed to a fixed 32-byte SHA-256
 * digest before `timingSafeEqual`, so the compare always runs over equal-length
 * buffers and the supplied-token length can never short-circuit the check (the
 * pre-`timingSafeEqual` length branch previously leaked the secret's length).
 */
function tokenMatches(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
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
    // Phase 4: check lock state before adding participant
    if (manager.sessionView().locked) return c.json({ error: 'session_locked' }, 423);
    let p: Participant;
    try {
      p = manager.addParticipant({ display_name: parsed.data.display_name });
    } catch (e) {
      if (isCapError(e)) return c.json({ error: 'cap_exceeded', limit: e.limit }, 409);
      throw e;
    }
    setParticipantCookie(c, p.id, { secure: resolveSecure() });
    return c.json({ id: p.id, display_name: p.display_name, status: p.status });
  });

  const requireParticipant: MiddlewareHandler<AppEnv> = async (c, next) => {
    const id = readParticipantCookie(c);
    if (!id) return c.json({ error: 'not_joined' }, 401);
    const v = manager.sessionView();
    const p = v.participants.find((x) => x.id === id);
    if (!p) return c.json({ error: 'not_joined' }, 401);
    // Phase 4: kicked participants cannot post; pending participants cannot post
    if (p.status === 'kicked') return c.json({ error: 'removed' }, 403);
    if (p.status === 'pending') return c.json({ error: 'not_approved' }, 403);
    c.set('participant', p);
    await next();
  };

  /**
   * Gates the coordinator-only routes (mounted on `POST /api/coordinator/answer`
   * below). Compares the `sb_c` cookie against the active session's coordinator
   * token via `tokenMatches`, which hashes both sides to a fixed-width digest
   * before `node:crypto.timingSafeEqual` so the compare is always constant-time
   * over equal-length buffers and leaks no length oracle (cross-cutting concern
   * 3 / CR-01).
   */
  const requireCoordinator: MiddlewareHandler<AppEnv> = async (c, next) => {
    const cookie = readCoordinatorCookie(c);
    if (!cookie) return c.json({ error: 'not_coordinator' }, 401);
    let expected: string;
    try {
      expected = manager.coordinatorToken();
    } catch {
      // WR-01: the session is no longer active (mcpState.manager = null after
      // stopSession). Return 404 `session_ended` to match the sibling
      // `/api/coordinator/join` and `/api/coordinator/answer` endpoints, so the
      // web client's `status === 404` "Session ended" branch is deterministic
      // regardless of whether the torn-down condition is observed in this
      // middleware or in the handler's `sessionView()` read. 401
      // `not_coordinator` is reserved strictly for a present-but-wrong/absent
      // cookie against a *live* session.
      return c.json({ error: 'session_ended' }, 404);
    }
    if (!tokenMatches(cookie, expected)) {
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
    if (!tokenMatches(supplied, expected)) {
      return c.json({ error: 'not_coordinator' }, 401);
    }
    setCoordinatorCookie(c, supplied, { secure: resolveSecure() });
    return c.json({ ok: true });
  });

  // COORD-03 backend: the coordinator picks the final answer from the browser.
  // Gated by `requireCoordinator` (sb_c cookie). NOT rate-limited — privileged
  // endpoint (RESEARCH §"Rate limiting"). Reuses the already-public
  // `SessionManager.recordAnswer` 1:1 — the exact code path the MCP
  // `recordAnswer` tool uses — so the AI host's `awaitAnswer` long-poll unblocks
  // through the same TicketStore wakeup as the CLI (COORD-04, no regression).
  // The `source: 'override'` value is trusted initiator input and is NOT
  // redacted (CONTEXT §Specifics).
  app.post('/api/coordinator/answer', requireCoordinator, async (c) => {
    const parsed = CoordinatorAnswerBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    // Phase 6: look up in questions[] by ticket_id (supports N concurrent open questions)
    let cq: ReturnType<typeof manager.sessionView>['questions'][number] | undefined;
    try {
      cq = manager.sessionView().questions.find((q) => q.ticket_id === parsed.data.ticket_id);
    } catch {
      // Session torn down between the cookie gate and this read.
      return c.json({ error: 'session_ended' }, 404);
    }
    if (!cq) {
      // WR-02: distinguish "ticket already resolved" (409) from "ticket never existed" (404).
      // After recordAnswer(), the question is deleted from open_questions (sessionView().questions
      // is open-only), so a second pick for a resolved ticket short-circuits here. Check
      // terminalQuestions via isTerminalTicket() so the coordinator sees the correct 409
      // "already_resolved" error rather than a confusing 404 "ticket_not_found".
      try {
        if (manager.isTerminalTicket(parsed.data.ticket_id)) {
          return c.json({ error: 'already_resolved' }, 409);
        }
      } catch {
        return c.json({ error: 'session_ended' }, 404);
      }
      return c.json({ error: 'ticket_not_found' }, 404);
    }
    try {
      manager.recordAnswer({
        question_id: cq.id as QuestionId,
        value: parsed.data.value,
        source: parsed.data.source,
      });
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      // Double-resolve race (Pitfall 4): a second pick for an already-resolved
      // question maps to 409, never a 500. This branch covers the same-tick race
      // where the question is still in open_questions but its status was mutated
      // externally (e.g. direct test manipulation). In normal flow, isTerminalTicket
      // above handles the post-delete path.
      if (
        msg.includes('no matching') ||
        msg.includes('not broadcast') ||
        msg.includes('not open') ||
        msg.includes('no open question')
      ) {
        return c.json({ error: 'already_resolved' }, 409);
      }
      throw e;
    }
  });

  // Coordinator-as-planner: the coordinator seeds the suggestion pool with their
  // own answer. Gated by `requireCoordinator` (sb_c cookie), NOT rate-limited
  // (privileged, same posture as /api/coordinator/answer). Reuses the same
  // ticket_id→question lookup and 404/409/session_ended handling, but calls
  // `postCoordinatorSuggestion` instead of `recordAnswer` — the question stays
  // open; the coordinator picks the final answer later via /api/coordinator/answer.
  app.post('/api/coordinator/suggestion', requireCoordinator, async (c) => {
    const parsed = CoordinatorSuggestionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    let cq: ReturnType<typeof manager.sessionView>['questions'][number] | undefined;
    try {
      cq = manager.sessionView().questions.find((q) => q.ticket_id === parsed.data.ticket_id);
    } catch {
      return c.json({ error: 'session_ended' }, 404);
    }
    if (!cq) {
      try {
        if (manager.isTerminalTicket(parsed.data.ticket_id)) {
          return c.json({ error: 'already_resolved' }, 409);
        }
      } catch {
        return c.json({ error: 'session_ended' }, 404);
      }
      return c.json({ error: 'ticket_not_found' }, 404);
    }
    manager.postCoordinatorSuggestion({
      question_id: cq.id as QuestionId,
      value: parsed.data.value,
      ...(parsed.data.rationale !== undefined ? { rationale: parsed.data.rationale } : {}),
    });
    return c.json({ ok: true });
  });

  // Phase 4: coordinator approve/kick/lock endpoints
  app.post('/api/coordinator/approve', requireCoordinator, async (c) => {
    const parsed = ApproveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    try {
      manager.approveParticipant(parsed.data.participant_id as ParticipantId);
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('unknown id')) return c.json({ error: 'not_found' }, 404);
      throw e;
    }
  });

  app.post('/api/coordinator/kick', requireCoordinator, async (c) => {
    const parsed = KickBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    try {
      manager.kickParticipant(parsed.data.participant_id as ParticipantId);
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('unknown id')) return c.json({ error: 'not_found' }, 404);
      throw e;
    }
  });

  app.post('/api/coordinator/lock', requireCoordinator, async (c) => {
    const parsed = LockBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    try {
      manager.setLocked(parsed.data.locked);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'session_ended' }, 404);
    }
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
