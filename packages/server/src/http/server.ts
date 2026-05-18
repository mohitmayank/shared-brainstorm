import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { SessionManager } from '../session/SessionManager.js';
import type { Participant, ParticipantId, QuestionId } from '@shared-brainstorm/shared';
import { readParticipantCookie, setParticipantCookie } from './cookies.js';

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

export function buildApp({ manager }: { manager: SessionManager }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/api/join', async (c) => {
    const parsed = JoinBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    if (parsed.data.join_code !== manager.joinCode())
      return c.json({ error: 'bad_join_code' }, 403);
    const p = manager.addParticipant({ display_name: parsed.data.display_name });
    setParticipantCookie(c, p.id);
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

  app.get('/api/session', requireParticipant, (c) => c.json(manager.sessionView()));

  app.post('/api/suggestion', requireParticipant, async (c) => {
    const parsed = SuggestionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    const p = c.get('participant');
    const args: Parameters<typeof manager.postSuggestion>[0] = {
      participant_id: p.id as ParticipantId,
      question_id: parsed.data.question_id as QuestionId,
      value: parsed.data.value,
    };
    if (parsed.data.rationale !== undefined) args.rationale = parsed.data.rationale;
    manager.postSuggestion(args);
    return c.json({ ok: true });
  });

  app.post('/api/comment', requireParticipant, async (c) => {
    const parsed = CommentBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid' }, 400);
    const p = c.get('participant');
    manager.postComment({
      participant_id: p.id as ParticipantId,
      question_id: parsed.data.question_id as QuestionId,
      text: parsed.data.text,
    });
    return c.json({ ok: true });
  });

  return app;
}
