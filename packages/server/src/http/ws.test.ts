import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createWsRouter } from './ws.js';
import { SessionManager } from '../session/SessionManager.js';
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
