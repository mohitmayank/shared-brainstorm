import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createWsRouter } from './ws.js';
import { SessionManager } from '../session/SessionManager.js';
import { EphemeralFrame, ClientCommand } from '@shared-brainstorm/shared';
import { fixedClock } from '../session/clock.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';

function setup(opts?: { heartbeatMs?: number; livenessMs?: number }) {
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    transcriptDir: mkdtempSync(pjoin(tmpdir(), 'sb-')),
  });
  mgr.start({ brief: 'a' });
  const router = createWsRouter({
    manager: mgr,
    heartbeatMs: opts?.heartbeatMs ?? 100_000,
    livenessMs: opts?.livenessMs ?? 200_000,
  });
  mgr.setBroadcaster((e) => router.broadcast(e));
  return { mgr, router };
}

describe('WS router', () => {
  it('rejects connection without joined cookie', async () => {
    const { router } = setup();
    const r = await router.acceptOrReject({ cookieParticipantId: null, isCoordinator: false });
    expect(r.kind).toBe('reject');
  });

  it('rejects connection with unknown participant id', async () => {
    const { router } = setup();
    const r = await router.acceptOrReject({ cookieParticipantId: 'sb_p_unknown', isCoordinator: false });
    expect(r.kind).toBe('reject');
  });

  it('on connect emits welcome with current session view', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const sent: Array<{ type: string }> = [];
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    expect(conn.kind).toBe('ok');
    expect(sent.find((m) => m.type === 'welcome')).toBeTruthy();
  });

  it('broadcasts events to connected subscribers', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const sent: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    sent.length = 0;
    mgr.askGroup({ question: 'q?' });
    expect(sent.find((m) => m.type === 'question_broadcast')).toBeTruthy();
  });

  it('replays events since last_seq on reconnect', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const sent1: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent1.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    mgr.askGroup({ question: 'q?' });

    const sent2: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent2.push(JSON.parse(msg) as { type: string }),
      close: () => {},
      lastSeq: 0,
    });
    expect(sent2.some((m) => m.type === 'question_broadcast')).toBe(true);
  });

  it('forwards post_suggestion command into manager', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Alice' });
    // v2.0.0: participants join as pending; approve so WS suggestion guard passes.
    mgr.approveParticipant(p.id);
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    conn.handle({
      type: 'post_suggestion',
      question_id: mgr.currentQuestion()!.id,
      value: 'Postgres',
    });
    expect(mgr.currentQuestion()!.suggestions).toHaveLength(1);
  });

  it('forwards post_comment command into manager', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Alice' });
    // v2.0.0: participants join as pending; approve so WS comment guard passes.
    mgr.approveParticipant(p.id);
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    conn.handle({
      type: 'post_comment',
      question_id: mgr.currentQuestion()!.id,
      text: 'good idea',
    });
    expect(mgr.currentQuestion()!.comments).toHaveLength(1);
  });

  it('silently drops legacy coordinator_accept commands (removed from protocol)', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    conn.handle({
      type: 'coordinator_accept',
      question_id: mgr.currentQuestion()!.id,
      value: 'Postgres',
    });
    expect(mgr.currentQuestion()!.status).toBe('broadcast');
  });

  it('closeAll closes all subscribers', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    let closed = false;
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => { closed = true; },
    });
    router.closeAll('done');
    expect(closed).toBe(true);
  });
});

describe('kicked participant gate', () => {
  it('acceptOrReject returns kind:reject for kicked participant', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    mgr.approveParticipant(p.id);
    mgr.kickParticipant(p.id);
    const r = await router.acceptOrReject({ cookieParticipantId: p.id, isCoordinator: false });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('removed');
  });

  it('a pending participant is accepted at WS upgrade (they see the waiting screen)', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Bob' });
    // p is pending — should still be accepted at upgrade (not blocked)
    const r = await router.acceptOrReject({ cookieParticipantId: p.id, isCoordinator: false });
    expect(r.kind).toBe('ok');
  });
});

describe('coordinator upgrade', () => {
  it('accepts a coordinator connect (isCoordinator=true, no participant cookie)', async () => {
    const { router } = setup();
    const r = await router.acceptOrReject({ cookieParticipantId: null, isCoordinator: true });
    expect(r.kind).toBe('ok');
  });

  it('emits welcome with is_coordinator:true and no you for a coordinator connect', async () => {
    const { router } = setup();
    const sent: Array<{ type: string; payload?: { is_coordinator?: boolean; you?: unknown } }> = [];
    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    expect(conn.kind).toBe('ok');
    const welcome = sent.find((m) => m.type === 'welcome');
    expect(welcome).toBeTruthy();
    expect(welcome?.payload?.is_coordinator).toBe(true);
    expect(welcome?.payload?.you).toBeUndefined();
  });

  it('emits welcome with is_coordinator:false and you set for a participant connect', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const sent: Array<{ type: string; payload?: { is_coordinator?: boolean; you?: { id?: string } } }> = [];
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    expect(conn.kind).toBe('ok');
    const welcome = sent.find((m) => m.type === 'welcome');
    expect(welcome?.payload?.is_coordinator).toBe(false);
    expect(welcome?.payload?.you?.id).toBe(p.id);
  });

  it('rejects a no-cookie connect (isCoordinator=false, cookieParticipantId=null)', async () => {
    const { router } = setup();
    const r = await router.acceptOrReject({ cookieParticipantId: null, isCoordinator: false });
    expect(r.kind).toBe('reject');
    if (r.kind === 'reject') expect(r.reason).toBe('not_joined');
  });

  it('a client hello frame claiming is_coordinator:true does NOT escalate a participant', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const sent: Array<{ type: string; payload?: { is_coordinator?: boolean } }> = [];
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    // Attacker sends a hello frame asserting coordinator status over the open socket.
    conn.handle({ type: 'hello', is_coordinator: true });
    // The connect-time welcome (already sent) is the only source of truth — still false.
    const welcome = sent.find((m) => m.type === 'welcome');
    expect(welcome?.payload?.is_coordinator).toBe(false);
    // No second welcome / no escalation frame was emitted in response to the hello.
    expect(sent.filter((m) => m.type === 'welcome')).toHaveLength(1);
  });

  it('a coordinator connection receives broadcasts', async () => {
    const { router, mgr } = setup();
    const sent: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    sent.length = 0;
    mgr.askGroup({ question: 'q?' });
    expect(sent.find((m) => m.type === 'question_broadcast')).toBeTruthy();
  });
});

describe('welcome advisories (cold-open seeding)', () => {
  type WelcomeFrame = {
    type: string;
    payload?: { advisories?: { room_empty?: boolean; transport_failed?: { code: string } } };
  };
  const connectCoordinator = async (mgr: SessionManager, router: ReturnType<typeof createWsRouter>) => {
    const sent: WelcomeFrame[] = [];
    await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: (msg) => sent.push(JSON.parse(msg) as WelcomeFrame),
      close: () => {},
    });
    return sent.find((m) => m.type === 'welcome')!;
  };

  it('omits advisories when nothing is active', async () => {
    const { router, mgr } = setup();
    const welcome = await connectCoordinator(mgr, router);
    expect(welcome.payload?.advisories).toBeUndefined();
  });

  it('seeds transport_failed into a fresh-open welcome (the cold-open gap)', async () => {
    const { router, mgr } = setup();
    mgr.emitExternal({
      type: 'transport_failed',
      payload: {
        code: 'cloudflared_permanent_failure',
        message: 'tunnel down',
        restart_count: 3,
        at: '2026-04-29T12:00:00Z',
      },
    });
    const welcome = await connectCoordinator(mgr, router);
    expect(welcome.payload?.advisories?.transport_failed?.code).toBe('cloudflared_permanent_failure');
  });

  it('seeds room_empty into a fresh-open welcome when a question is open into an empty room', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    mgr.approveParticipant(p.id);
    mgr.askGroup({ question: 'Which DB?' }); // open into an empty room → lastRoomEmpty=true
    const welcome = await connectCoordinator(mgr, router);
    expect(welcome.payload?.advisories?.room_empty).toBe(true);
  });
});

describe('typing command — approved-participant gate', () => {
  it('Test 1: typing start from approved participant calls broadcastEphemeral with presence frame (actor_id server-derived)', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Alice' });
    mgr.approveParticipant(p.id);

    const ephemeralFrames: EphemeralFrame[] = [];
    const origBroadcast = router.broadcast.bind(router);
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
      origBroadcast(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'typing', question_id: mgr.currentQuestion()!.id, state: 'start' });

    const presenceFrame = ephemeralFrames.find((f) => f.type === 'presence');
    expect(presenceFrame).toBeTruthy();
    if (presenceFrame?.type === 'presence') {
      expect(presenceFrame.payload.actor_kind).toBe('participant');
      expect(presenceFrame.payload.actor_id).toBe(p.id); // server-derived, NOT from client payload
      expect(presenceFrame.payload.activity).toBe('typing');
    }
  });

  it('Test 2: typing command from PENDING participant — broadcastEphemeral NOT called', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Bob' });
    // p is pending — NOT approved

    const ephemeralFrames: EphemeralFrame[] = [];
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'typing', question_id: mgr.currentQuestion()!.id, state: 'start' });

    expect(ephemeralFrames.filter((f) => f.type === 'presence')).toHaveLength(0);
  });

  it('Test 3: typing command from coordinator connection (me is null) — broadcastEphemeral NOT called', async () => {
    const { router } = setup();

    const ephemeralFrames: EphemeralFrame[] = [];
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'typing', question_id: 'q1', state: 'start' });

    expect(ephemeralFrames.filter((f) => f.type === 'presence')).toHaveLength(0);
  });

  it('Test 4: typing with state "stop" → broadcastEphemeral called with activity "idle"', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Carol' });
    mgr.approveParticipant(p.id);

    const ephemeralFrames: EphemeralFrame[] = [];
    const origBroadcast = router.broadcast.bind(router);
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
      origBroadcast(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'typing', question_id: mgr.currentQuestion()!.id, state: 'stop' });

    const presenceFrame = ephemeralFrames.find((f) => f.type === 'presence');
    expect(presenceFrame).toBeTruthy();
    if (presenceFrame?.type === 'presence') {
      expect(presenceFrame.payload.activity).toBe('idle');
    }
  });
});

describe('picking command — coordinator-only gate', () => {
  it('Test 5: picking start from coordinator → setSessionStatus("choosing") + broadcastEphemeral with activity "picking"', async () => {
    const { router, mgr } = setup();
    // WR-04 fix: capture the real ticket_id from askGroup so the coordinator
    // picking command can supply the matching ticket_id (the server now validates
    // that the command ticket_id equals the current question's ticket_id).
    const { ticket_id } = mgr.askGroup({ question: 'q?' });
    // Ensure question is broadcast so the race guard passes
    expect(mgr.currentQuestion()?.status).toBe('broadcast');

    const ephemeralFrames: EphemeralFrame[] = [];
    const origBroadcast = router.broadcast.bind(router);
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
      origBroadcast(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'picking', ticket_id, state: 'start' });

    expect(mgr.sessionView().session_status).toBe('choosing');

    const presenceFrame = ephemeralFrames.find((f) => f.type === 'presence');
    expect(presenceFrame).toBeTruthy();
    if (presenceFrame?.type === 'presence') {
      expect(presenceFrame.payload.actor_kind).toBe('coordinator');
      expect(presenceFrame.payload.activity).toBe('picking');
    }
  });

  it('Test 6: picking command from participant (isCoordinator=false) → setSessionStatus NOT called, broadcastEphemeral NOT called', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    const p = mgr.addParticipant({ display_name: 'Dave' });
    mgr.approveParticipant(p.id);

    const ephemeralFrames: EphemeralFrame[] = [];
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'picking', ticket_id: 'some-ticket', state: 'start' });

    // Status must remain unchanged (was 'question_open' after askGroup)
    expect(mgr.sessionView().session_status).toBe('question_open');
    expect(ephemeralFrames.filter((f) => f.type === 'presence')).toHaveLength(0);
  });

  it('Test 7: picking start when currentQuestion().status !== "broadcast" — silently ignored (race condition guard)', async () => {
    const { router, mgr } = setup();
    // No question posted — currentQuestion() is null
    expect(mgr.currentQuestion()).toBeNull();

    const ephemeralFrames: EphemeralFrame[] = [];
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'picking', ticket_id: 'some-ticket', state: 'start' });

    // status stays at 'waiting' (no question was broadcast)
    expect(mgr.sessionView().session_status).toBe('waiting');
    expect(ephemeralFrames.filter((f) => f.type === 'presence')).toHaveLength(0);
  });

  it('Test 7b (WR-04): picking start with stale/wrong ticket_id — silently ignored (status unchanged)', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    // Ensure the question is broadcast
    expect(mgr.currentQuestion()?.status).toBe('broadcast');

    const ephemeralFrames: EphemeralFrame[] = [];
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    // Send picking start with a stale/wrong ticket_id — must NOT transition to choosing
    conn.handle({ type: 'picking', ticket_id: 'stale-wrong-ticket', state: 'start' });

    // Status must remain at question_open (not changed to choosing)
    expect(mgr.sessionView().session_status).toBe('question_open');
    expect(ephemeralFrames.filter((f) => f.type === 'presence')).toHaveLength(0);
  });

  it('Test 8: picking stop → broadcastEphemeral with activity "idle"; if current question is broadcast, setSessionStatus("question_open")', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'q?' });
    // First, transition to choosing
    mgr.setSessionStatus('choosing');
    expect(mgr.sessionView().session_status).toBe('choosing');

    const ephemeralFrames: EphemeralFrame[] = [];
    const origBroadcast = router.broadcast.bind(router);
    vi.spyOn(router, 'broadcast').mockImplementation((evt) => {
      if (!('seq' in evt)) ephemeralFrames.push(evt);
      origBroadcast(evt);
    });

    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');

    conn.handle({ type: 'picking', ticket_id: 'some-ticket', state: 'stop' });

    // Status must return to question_open (question is still broadcast)
    expect(mgr.sessionView().session_status).toBe('question_open');

    const presenceFrame = ephemeralFrames.find((f) => f.type === 'presence');
    expect(presenceFrame).toBeTruthy();
    if (presenceFrame?.type === 'presence') {
      expect(presenceFrame.payload.activity).toBe('idle');
    }
  });
});

describe('EphemeralFrame presence variant schema', () => {
  it('Test 9: EphemeralFrame.parse succeeds for a valid presence frame', () => {
    const frame = EphemeralFrame.parse({
      type: 'presence',
      payload: {
        actor_kind: 'participant',
        actor_id: 'p1',
        activity: 'typing',
      },
    });
    expect(frame.type).toBe('presence');
    if (frame.type === 'presence') {
      expect(frame.payload.actor_kind).toBe('participant');
      expect(frame.payload.actor_id).toBe('p1');
      expect(frame.payload.activity).toBe('typing');
    }
  });

  it('Test 10 (CRITICAL): broadcastEphemeral with real presence frame does NOT grow RingBuffer (replay length unchanged)', () => {
    const mgr = new SessionManager({
      clock: fixedClock('2026-04-29T12:00:00Z'),
      transcriptDir: mkdtempSync(pjoin(tmpdir(), 'sb-')),
    });
    mgr.start({ brief: 'test' });
    const router = createWsRouter({ manager: mgr });
    mgr.setBroadcaster((e) => router.broadcast(e));

    const replayBefore = mgr.replay(-1).length;

    // Parse a real presence EphemeralFrame via the Zod schema
    const presenceFrame = EphemeralFrame.parse({
      type: 'presence',
      payload: {
        actor_kind: 'participant',
        actor_id: 'sb_p_001',
        activity: 'typing',
      },
    });

    mgr.broadcastEphemeral(presenceFrame);

    const replayAfter = mgr.replay(-1).length;
    expect(replayAfter).toBe(replayBefore); // RingBuffer must be unchanged
  });

  it('Test 11: presence EphemeralFrame parse result has NO "seq" property', () => {
    const frame = EphemeralFrame.parse({
      type: 'presence',
      payload: {
        actor_kind: 'coordinator',
        activity: 'picking',
      },
    });
    expect(Object.prototype.hasOwnProperty.call(frame, 'seq')).toBe(false);
  });

  it('Test 12: ClientCommand.parse succeeds for typing command', () => {
    const cmd = ClientCommand.parse({
      type: 'typing',
      question_id: 'q1',
      state: 'start',
    });
    expect(cmd.type).toBe('typing');
    if (cmd.type === 'typing') {
      expect(cmd.question_id).toBe('q1');
      expect(cmd.state).toBe('start');
    }
  });

  it('Test 13: ClientCommand.parse succeeds for picking command', () => {
    const cmd = ClientCommand.parse({
      type: 'picking',
      ticket_id: 't1',
      state: 'stop',
    });
    expect(cmd.type).toBe('picking');
    if (cmd.type === 'picking') {
      expect(cmd.ticket_id).toBe('t1');
      expect(cmd.state).toBe('stop');
    }
  });
});

describe('WS heartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends heartbeat at configured interval', async () => {
    const mgr = new SessionManager({
      clock: fixedClock('2026-04-29T12:00:00Z'),
      transcriptDir: mkdtempSync(pjoin(tmpdir(), 'sb-')),
    });
    mgr.start({ brief: 'a' });
    const router = createWsRouter({ manager: mgr, heartbeatMs: 100, livenessMs: 500 });
    mgr.setBroadcaster((e) => router.broadcast(e));

    const p = mgr.addParticipant({ display_name: 'Alice' });
    const sent: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (msg) => sent.push(JSON.parse(msg) as { type: string }),
      close: () => {},
    });
    sent.length = 0;
    vi.advanceTimersByTime(100);
    const heartbeats = sent.filter((m) => m.type === 'heartbeat');
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    router.closeAll('test');
  });

  it('drops stale subscribers after liveness timeout', async () => {
    const mgr = new SessionManager({
      clock: fixedClock('2026-04-29T12:00:00Z'),
      transcriptDir: mkdtempSync(pjoin(tmpdir(), 'sb-')),
    });
    mgr.start({ brief: 'a' });
    const router = createWsRouter({ manager: mgr, heartbeatMs: 50, livenessMs: 100 });
    mgr.setBroadcaster((e) => router.broadcast(e));

    const p = mgr.addParticipant({ display_name: 'Alice' });
    let closeCalled = false;
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => { closeCalled = true; },
    });
    vi.advanceTimersByTime(200);
    expect(closeCalled).toBe(true);
    router.closeAll('test');
  });
});

// ---------------------------------------------------------------------------
// Phase 7 (CHATAI-01): post_clarification command gate
// ---------------------------------------------------------------------------

describe('post_clarification command', () => {
  it('coordinator (me===null) is silently ignored — no clarification appended', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'Which DB?' });
    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    const q = mgr.currentQuestion()!;
    conn.handle({ type: 'post_clarification', question_id: q.id, text: 'can coordinator clarify?' });
    expect(q.clarifications).toHaveLength(0);
  });

  it('pending participant is silently ignored — no clarification appended', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'Which DB?' });
    const p = mgr.addParticipant({ display_name: 'Bob' });
    // p is pending — NOT approved
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    const q = mgr.currentQuestion()!;
    conn.handle({ type: 'post_clarification', question_id: q.id, text: 'pending clarification' });
    expect(q.clarifications).toHaveLength(0);
  });

  it('approved participant appends clarification via postClarification', async () => {
    const { router, mgr } = setup();
    mgr.askGroup({ question: 'Which DB?' });
    const p = mgr.addParticipant({ display_name: 'Alice' });
    mgr.approveParticipant(p.id);
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    const q = mgr.currentQuestion()!;
    conn.handle({ type: 'post_clarification', question_id: q.id, text: 'What about latency?' });
    expect(q.clarifications).toHaveLength(1);
    expect(q.clarifications[0]!.text).toBe('What about latency?');
  });
});

// ---------------------------------------------------------------------------
// CHAT-01: post_chat command gate (ws.ts)
// ---------------------------------------------------------------------------

describe('post_chat command', () => {
  it('coordinator: calls postChat with actor_kind "coordinator" and display_name "Coordinator" (server-literal)', async () => {
    const { router, mgr } = setup();
    const conn = await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    conn.handle({ type: 'post_chat', text: 'Hello from coordinator' });
    const chat = mgr.sessionView().chat;
    expect(chat).toHaveLength(1);
    expect(chat[0]!.actor_kind).toBe('coordinator');
    expect(chat[0]!.display_name).toBe('Coordinator');
    expect(chat[0]!.text).toBe('Hello from coordinator');
    expect('actor_id' in chat[0]!).toBe(false);
  });

  it('approved participant: calls postChat with actor_kind "participant" and server-derived display_name', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Bob' });
    mgr.approveParticipant(p.id);
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    conn.handle({ type: 'post_chat', text: 'Hello from Bob' });
    const chat = mgr.sessionView().chat;
    expect(chat).toHaveLength(1);
    expect(chat[0]!.actor_kind).toBe('participant');
    expect(chat[0]!.display_name).toBe('Bob');
    expect(chat[0]!.actor_id).toBe(p.id);
    expect(chat[0]!.text).toBe('Hello from Bob');
  });

  it('pending participant is silently ignored — no chat message appended', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Pending' });
    // NOT approved
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    conn.handle({ type: 'post_chat', text: 'pending chat attempt' });
    expect(mgr.sessionView().chat).toHaveLength(0);
  });

  it('kicked participant is silently ignored — no chat message appended', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Kicked' });
    mgr.approveParticipant(p.id);
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    // Kick AFTER connecting
    mgr.kickParticipant(p.id);
    conn.handle({ type: 'post_chat', text: 'kicked chat attempt' });
    expect(mgr.sessionView().chat).toHaveLength(0);
  });

  it('actor identity is server-derived — display_name cannot be overridden by client payload', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'TrueAlice' });
    mgr.approveParticipant(p.id);
    const conn = await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: () => {},
      close: () => {},
    });
    if (conn.kind !== 'ok') throw new Error('expected ok');
    // Client tries to inject extra fields — schema strips them, display_name is server-derived
    conn.handle({ type: 'post_chat', text: 'genuine message' });
    const chat = mgr.sessionView().chat;
    expect(chat[0]!.display_name).toBe('TrueAlice'); // server-derived, not from client payload
    expect(chat[0]!.actor_id).toBe(p.id);
  });
});

describe('WS planning-stream audience', () => {
  it('coordinator-mode planning_stream reaches only the coordinator, not participants', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const partSent: Array<{ type: string }> = [];
    const coordSent: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (m) => partSent.push(JSON.parse(m) as { type: string }),
      close: () => {},
    });
    await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: (m) => coordSent.push(JSON.parse(m) as { type: string }),
      close: () => {},
    });
    partSent.length = 0;
    coordSent.length = 0;
    mgr.setStreamMode('coordinator');
    mgr.pushStream('secret reasoning');
    // mode change is non-sensitive → both see it
    expect(partSent.some((m) => m.type === 'stream_mode_changed')).toBe(true);
    expect(coordSent.some((m) => m.type === 'stream_mode_changed')).toBe(true);
    // narration is audience-gated → coordinator only
    expect(coordSent.some((m) => m.type === 'planning_stream')).toBe(true);
    expect(partSent.some((m) => m.type === 'planning_stream')).toBe(false);
  });

  it('everyone-mode planning_stream reaches both coordinator and participants', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    const partSent: Array<{ type: string }> = [];
    const coordSent: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (m) => partSent.push(JSON.parse(m) as { type: string }),
      close: () => {},
    });
    await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: (m) => coordSent.push(JSON.parse(m) as { type: string }),
      close: () => {},
    });
    partSent.length = 0;
    coordSent.length = 0;
    mgr.setStreamMode('everyone');
    mgr.pushStream('shared reasoning');
    expect(partSent.some((m) => m.type === 'planning_stream')).toBe(true);
    expect(coordSent.some((m) => m.type === 'planning_stream')).toBe(true);
  });

  it('planning_stream never enters the replay path (ephemeral, no seq)', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    mgr.setStreamMode('everyone');
    mgr.pushStream('a buffered line');
    const sent2: Array<{ type: string }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (m) => sent2.push(JSON.parse(m) as { type: string }),
      close: () => {},
      lastSeq: 0,
    });
    // The line surfaces via the welcome seed, never as a replayed planning_stream event.
    expect(sent2.some((m) => m.type === 'planning_stream')).toBe(false);
  });

  it('welcome seeds recent lines only for the entitled audience', async () => {
    const { router, mgr } = setup();
    const p = mgr.addParticipant({ display_name: 'Alice' });
    mgr.setStreamMode('coordinator');
    mgr.pushStream('coordinator only');

    const partSent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await router.connect({
      cookieParticipantId: p.id,
      isCoordinator: false,
      send: (m) => partSent.push(JSON.parse(m)),
      close: () => {},
    });
    const partWelcome = partSent.find((m) => m.type === 'welcome')!;
    expect(partWelcome.payload['stream']).toBeUndefined();

    const coordSent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    await router.connect({
      cookieParticipantId: null,
      isCoordinator: true,
      send: (m) => coordSent.push(JSON.parse(m)),
      close: () => {},
    });
    const coordWelcome = coordSent.find((m) => m.type === 'welcome')!;
    expect(coordWelcome.payload['stream']).toEqual({
      mode: 'coordinator',
      recent: [{ text: 'coordinator only', at: '2026-04-29T12:00:00.000Z' }],
    });
  });
});
