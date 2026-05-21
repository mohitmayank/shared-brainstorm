import { randomUUID } from 'node:crypto';
import { ClientCommand, type ServerEvent, type EphemeralFrame } from '@shared-brainstorm/shared';
import type { SessionManager } from '../session/SessionManager.js';

export interface WsConnectArgs {
  cookieParticipantId: string | null;
  /**
   * Server-derived at WS upgrade time (concern #6): true when the connecting
   * browser presented a valid `sb_c` cookie matching the active session's
   * coordinator token. NEVER read from a client frame — a participant cannot
   * escalate by sending a hello/command claiming coordinator status.
   */
  isCoordinator: boolean;
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
    isCoordinator: boolean;
  }): Promise<RejectedConn | { kind: 'ok' }>;
  connect(args: WsConnectArgs): Promise<AcceptedConn | RejectedConn>;
  broadcast(event: ServerEvent | EphemeralFrame): void;
  closeAll(reason: string): void;
}

interface Subscriber {
  participantId: string;
  send: (s: string) => void;
  close: (r?: string) => void;
  lastSeen: number;
  /**
   * WR-02: true for coordinator connections (synthetic `coordinator:` id, no
   * participant identity). Used by the heartbeat revocation guard below.
   */
  isCoordinator: boolean;
  /**
   * WR-02: the `session_id` observed when this subscriber connected. Coordinator
   * subscribers are never re-validated against the live token after connect, so
   * if the session is stopped (and possibly a new one started with a new token),
   * a still-open coordinator socket from the prior session would keep receiving
   * broadcasts. The heartbeat guard drops it when this id no longer matches the
   * active session (or no session is active). `closeAll('session_ended')` still
   * handles the normal `stopSession` teardown; this guard is the belt-and-braces
   * path for a coordinator socket that outlives `closeAll` (e.g. crash/restart).
   */
  sessionId: string | null;
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

  // WR-02: best-effort liveness/identity check for the active session id so the
  // heartbeat can revoke coordinator subscribers whose session is gone. Returns
  // null when no session is active.
  const activeSessionId = (): string | null => {
    if (!manager.isActive()) return null;
    try {
      return manager.sessionView().session_id;
    } catch {
      return null;
    }
  };

  const beat = setIntervalFn(() => {
    const now = Date.now();
    const liveSessionId = activeSessionId();
    for (const s of subs) {
      // WR-02: revoke coordinator subscribers whose originating session is no
      // longer the active one (session ended, or a new session started with a
      // new token). Without this, a coordinator socket that outlived `closeAll`
      // would keep receiving broadcasts for a session it was never authorized
      // against.
      if (s.isCoordinator && s.sessionId !== liveSessionId) {
        s.close('session_ended');
        subs.delete(s);
        continue;
      }
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
    async acceptOrReject({ cookieParticipantId, isCoordinator }) {
      // A coordinator (valid sb_c cookie, derived server-side at upgrade) is
      // accepted without a participant cookie (Pitfall 3).
      if (isCoordinator) return { kind: 'ok' };
      if (!cookieParticipantId) return { kind: 'reject', reason: 'not_joined' };
      const v = manager.sessionView();
      const p = v.participants.find((x) => x.id === cookieParticipantId);
      if (!p) return { kind: 'reject', reason: 'not_joined' };
      // Phase 4: kicked participants cannot reconnect — they see the removed screen
      if (p.status === 'kicked') return { kind: 'reject', reason: 'removed' };
      // pending participants are accepted (they see the waiting screen, WS is live)
      return { kind: 'ok' };
    },

    async connect({ cookieParticipantId, isCoordinator, send, close, lastSeq }) {
      const a = await router.acceptOrReject({ cookieParticipantId, isCoordinator });
      if (a.kind === 'reject') return a;
      const v = manager.sessionView();
      // A coordinator has no participant identity (concern #6 / Pitfall 3): we
      // do NOT synthesize one. `you` is omitted from the welcome and the
      // subscriber is registered under a synthetic `coordinator:`-prefixed id
      // so it receives broadcasts but is never matched as a participant.
      const me = isCoordinator
        ? null
        : v.participants.find((p) => p.id === cookieParticipantId)!;
      const sub: Subscriber = {
        // WR-05: crypto-random suffix (not Math.random) so the synthetic
        // coordinator id is collision-free even across rapid reconnects within
        // the same millisecond. Guards any future logic that keys on
        // Subscriber.participantId (dedup / targeted send) from mis-routing.
        participantId: me ? me.id : `coordinator:${randomUUID()}`,
        send,
        close,
        lastSeen: Date.now(),
        isCoordinator,
        // WR-02: stamp the originating session id so the heartbeat can revoke
        // this subscriber if the session is torn down out from under it.
        sessionId: v.session_id,
      };
      subs.add(sub);

      send(
        JSON.stringify(
          me
            ? { type: 'welcome', payload: { session: v, you: me, is_coordinator: false } }
            : { type: 'welcome', payload: { session: v, is_coordinator: true } },
        ),
      );

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
            // Coordinator connections have no participant identity and cannot
            // author suggestions/comments over the WS (concern #6).
            if (!me) return;
            // Phase 4: pending participants cannot post suggestions
            const freshSug = manager.sessionView().participants.find((x) => x.id === me.id);
            if (freshSug?.status !== 'approved') return;
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
            if (!me) return;
            // Phase 4: pending participants cannot post comments
            {
              const freshCmt = manager.sessionView().participants.find((x) => x.id === me.id);
              if (freshCmt?.status !== 'approved') return;
            }
            manager.postComment({
              participant_id: me.id as Parameters<typeof manager.postComment>[0]['participant_id'],
              question_id: c.question_id as Parameters<typeof manager.postComment>[0]['question_id'],
              text: c.text,
            });
            return;
          case 'post_clarification':
            // CHATAI-01 / anti-spoof gate: coordinator has no participant identity
            // (me === null) — silently ignore so the coordinator cannot inject a
            // clarification under a fabricated participant_id.
            if (!me) return;
            {
              const freshCl = manager.sessionView().participants.find((x) => x.id === me.id);
              if (freshCl?.status !== 'approved') return;
            }
            manager.postClarification({
              participant_id: me.id as Parameters<typeof manager.postClarification>[0]['participant_id'],
              question_id: c.question_id as Parameters<typeof manager.postClarification>[0]['question_id'],
              text: c.text,
            });
            return;
          // NOTE: case 'post_chat' handler is NOT added here — ships in Plan 07-02
          // alongside SessionManager.postChat(). The wire schema is present in
          // ClientCommand (events.ts) for forward-compat, but the runtime handler
          // lives in the next plan to keep 07-01 focused on CHATAI-01.
          case 'pong':
            sub.lastSeen = Date.now();
            return;
          case 'typing': {
            // T-05-08: actor_id is server-derived from me.id (validated sb_p cookie),
            // NOT from the client command payload — prevents identity spoofing.
            if (!me) return; // coordinator has no participant identity
            const freshTyping = manager.sessionView().participants.find((x) => x.id === me.id);
            if (freshTyping?.status !== 'approved') return;
            const typingActivity = c.state === 'start' ? ('typing' as const) : ('idle' as const);
            manager.broadcastEphemeral({
              type: 'presence',
              payload: {
                actor_kind: 'participant',
                actor_id: me.id,
                activity: typingActivity,
              },
            });
            return;
          }
          case 'picking': {
            // T-05-09: only coordinators can trigger picking — gate on isCoordinator
            // flag fixed at WS upgrade time from sb_c cookie.
            if (!isCoordinator) return;
            if (c.state === 'start') {
              // WR-01 / WR-03: delegate to setPickingTicket() which validates the
              // ticket is still open before entering 'choosing'. Stale ticket_ids
              // (resolved/cancelled questions) are silently ignored by setPickingTicket,
              // which returns early without changing session_status — so we broadcast
              // picking presence ONLY when the session actually transitioned to 'choosing'
              // (T-05-10 race-condition guard: no presence broadcast for stale tickets).
              manager.setPickingTicket(c.ticket_id);
              if (manager.sessionView().session_status === 'choosing') {
                manager.broadcastEphemeral({
                  type: 'presence',
                  payload: { actor_kind: 'coordinator', activity: 'picking' },
                });
              }
            } else {
              // WR-01 / WR-03: clear the picking state; setPickingTicket(null) derives
              // the correct new status (question_open / waiting) automatically.
              manager.setPickingTicket(null);
              manager.broadcastEphemeral({
                type: 'presence',
                payload: { actor_kind: 'coordinator', activity: 'idle' },
              });
            }
            return;
          }
        }
      };

      return {
        kind: 'ok' as const,
        handle,
        close: () => {
          subs.delete(sub);
          // WR-03: coordinator disconnect clears any in-progress pick so the
          // 'choosing' caption never sticks on participant screens after the tab
          // closes or the network drops mid-pick.
          if (isCoordinator) {
            try { manager.setPickingTicket(null); } catch { /* session may be gone */ }
          }
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
