import { ClientCommand, type ServerEvent } from '@shared-brainstorm/shared';
import type { SessionManager } from '../session/SessionManager.js';

export interface WsConnectArgs {
  cookieParticipantId: string | null;
  send: (text: string) => void;
  close: (reason?: string) => void;
  lastSeq?: number;
}

interface AcceptedConn {
  kind: 'ok';
  handle: (cmd: unknown) => void;
  close: () => void;
}
interface RejectedConn {
  kind: 'reject';
  reason: string;
}

export interface WsRouter {
  acceptOrReject(args: {
    cookieParticipantId: string | null;
  }): Promise<RejectedConn | { kind: 'ok' }>;
  connect(args: WsConnectArgs): Promise<AcceptedConn | RejectedConn>;
  broadcast(event: ServerEvent): void;
  closeAll(reason: string): void;
}

interface Subscriber {
  participantId: string;
  send: (s: string) => void;
  close: (r?: string) => void;
  lastSeen: number;
}

export function createWsRouter({
  manager,
  heartbeatMs = 20_000,
  livenessMs = 60_000,
  setIntervalFn = setInterval as (cb: () => void, ms: number) => ReturnType<typeof setInterval>,
  clearIntervalFn = clearInterval as (id: ReturnType<typeof setInterval>) => void,
}: {
  manager: SessionManager;
  heartbeatMs?: number;
  livenessMs?: number;
  setIntervalFn?: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}): WsRouter {
  const subs = new Set<Subscriber>();

  const beat = setIntervalFn(() => {
    const now = Date.now();
    for (const s of subs) {
      try {
        s.send(JSON.stringify({ type: 'heartbeat' }));
      } catch {
        subs.delete(s);
      }
      if (now - s.lastSeen > livenessMs) {
        s.close('stale');
        subs.delete(s);
      }
    }
  }, heartbeatMs);

  const router: WsRouter = {
    async acceptOrReject({ cookieParticipantId }) {
      if (!cookieParticipantId) return { kind: 'reject', reason: 'not_joined' };
      const v = manager.sessionView();
      if (!v.participants.find((p) => p.id === cookieParticipantId))
        return { kind: 'reject', reason: 'not_joined' };
      return { kind: 'ok' };
    },

    async connect({ cookieParticipantId, send, close, lastSeq }) {
      const a = await router.acceptOrReject({ cookieParticipantId });
      if (a.kind === 'reject') return a;
      const v = manager.sessionView();
      const me = v.participants.find((p) => p.id === cookieParticipantId)!;
      const sub: Subscriber = {
        participantId: me.id,
        send,
        close,
        lastSeen: Date.now(),
      };
      subs.add(sub);

      send(JSON.stringify({ type: 'welcome', payload: { session: v, you: me } }));

      if (typeof lastSeq === 'number') {
        for (const e of manager.replay(lastSeq)) send(JSON.stringify(e));
      }

      const handle = (cmd: unknown): void => {
        sub.lastSeen = Date.now();
        const parsed = ClientCommand.safeParse(cmd);
        if (!parsed.success) return;
        const c = parsed.data;
        switch (c.type) {
          case 'hello':
            if (c.last_seq !== undefined) {
              for (const e of manager.replay(c.last_seq)) sub.send(JSON.stringify(e));
            }
            return;
          case 'post_suggestion': {
            const sugArgs: Parameters<typeof manager.postSuggestion>[0] = {
              participant_id: me.id as Parameters<typeof manager.postSuggestion>[0]['participant_id'],
              question_id: c.question_id as Parameters<typeof manager.postSuggestion>[0]['question_id'],
              value: c.value,
            };
            if (c.rationale !== undefined) sugArgs.rationale = c.rationale;
            manager.postSuggestion(sugArgs);
            return;
          }
          case 'post_comment':
            manager.postComment({
              participant_id: me.id as Parameters<typeof manager.postComment>[0]['participant_id'],
              question_id: c.question_id as Parameters<typeof manager.postComment>[0]['question_id'],
              text: c.text,
            });
            return;
          case 'pong':
            sub.lastSeen = Date.now();
            return;
        }
      };

      return {
        kind: 'ok' as const,
        handle,
        close: () => {
          subs.delete(sub);
        },
      };
    },

    broadcast(event) {
      const text = JSON.stringify(event);
      for (const s of subs) {
        try {
          s.send(text);
        } catch {
          subs.delete(s);
        }
      }
    },

    closeAll(reason) {
      clearIntervalFn(beat);
      for (const s of subs) s.close(reason);
      subs.clear();
    },
  };

  return router;
}
