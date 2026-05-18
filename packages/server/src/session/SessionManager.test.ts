import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './SessionManager.js';
import { fixedClock } from './clock.js';
import { TranscriptV2, type ServerEvent } from '@shared-brainstorm/shared';

const makeMgr = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbsess-'));
  const events: ServerEvent[] = [];
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    broadcast: (e) => events.push(e),
    transcriptDir: dir,
  });
  return {
    mgr,
    events,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

describe('SessionManager', () => {
  it('start() creates a session with id and join_code', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      const out = mgr.start({ brief: 'auth flow' });
      expect(out.session_id).toMatch(/^sb_s_/);
      expect(out.join_code).toMatch(/^\d{6}$/);
    } finally {
      cleanup();
    }
  });

  it('start() while active throws', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      expect(() => mgr.start({ brief: 'b' })).toThrow(/already active/);
    } finally {
      cleanup();
    }
  });

  it('addParticipant takes display_name only — no coordinator/role logic', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      expect(p.display_name).toBe('Alice');
      expect((p as unknown as Record<string, unknown>)['role']).toBeUndefined();
      mgr.addParticipant({ display_name: 'Bob' });
      const joined = events.filter((e) => e.type === 'participant_joined');
      expect(joined).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('askGroup creates ticket and broadcasts immediately (no preview gate)', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const t = mgr.askGroup({ question: 'q?' });
      expect(t.ticket_id).toMatch(/^sb_t_/);
      expect(events.find((e) => e.type === 'question_broadcast')).toBeTruthy();
      // Sanity: the legacy preview event type should not exist anywhere.
      expect(events.find((e) => (e as { type: string }).type === 'question_preview')).toBeFalsy();
    } finally {
      cleanup();
    }
  });

  it('recordAnswer resolves ticket and emits question_resolved with source', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const t = mgr.askGroup({ question: 'q?' });
      const wait = mgr.awaitAnswer({ ticket_id: t.ticket_id, timeout_s: 5 });
      mgr.recordAnswer({
        question_id: mgr.currentQuestion()!.id,
        value: 'Postgres',
        source: 'override',
      });
      const r = await wait;
      expect(r.resolved).toBe(true);
      const resolved = events.find((e) => e.type === 'question_resolved');
      expect(resolved).toBeTruthy();
      if (resolved && resolved.type === 'question_resolved') {
        const payload = resolved.payload as {
          question_id: string;
          resolution: { value: string; source: string };
        };
        expect(payload.resolution.value).toBe('Postgres');
        expect(payload.resolution.source).toBe('override');
      }
    } finally {
      cleanup();
    }
  });

  it('recordAnswer throws if question is not broadcast', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const t = mgr.askGroup({ question: 'q?' });
      const qid = mgr.currentQuestion()!.id;
      mgr.recordAnswer({ question_id: qid, value: 'A', source: 'suggestion' });
      expect(() =>
        mgr.recordAnswer({ question_id: qid, value: 'B', source: 'suggestion' }),
      ).toThrow(/no matching current question/);
      // ticket should still be resolved from the first call
      expect(t.ticket_id).toMatch(/^sb_t_/);
    } finally {
      cleanup();
    }
  });

  it('awaitAnswer returns a snapshot of suggestions+comments with participant names', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const alice = mgr.addParticipant({ display_name: 'Alice' });
      const bob = mgr.addParticipant({ display_name: 'Bob' });
      const t = mgr.askGroup({ question: 'q?' });
      const qid = mgr.currentQuestion()!.id;
      mgr.postSuggestion({ participant_id: alice.id, question_id: qid, value: 'X', rationale: 'r' });
      mgr.postComment({ participant_id: bob.id, question_id: qid, text: 'looks fine' });

      // Short timeout — we don't expect resolution, just want the snapshot.
      const snap = await mgr.awaitAnswer({ ticket_id: t.ticket_id, timeout_s: 1 });
      expect(snap.suggestions).toEqual([
        { participant_name: 'Alice', value: 'X', rationale: 'r', at: expect.any(String) },
      ]);
      expect(snap.comments).toEqual([
        { participant_name: 'Bob', text: 'looks fine', at: expect.any(String) },
      ]);
      expect(snap.resolved).toBe(false);
      // Ticket should still be pending — poll-timeout != question-timeout.
      expect(mgr.currentQuestion()?.id).toBe(qid);
    } finally {
      cleanup();
    }
  });

  it('decisions log accumulates resolved questions', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const t1 = mgr.askGroup({ question: 'Q1?' });
      const wait1 = mgr.awaitAnswer({ ticket_id: t1.ticket_id, timeout_s: 5 });
      mgr.recordAnswer({
        question_id: mgr.currentQuestion()!.id,
        value: 'A1',
        source: 'suggestion',
      });
      await wait1;
      const t2 = mgr.askGroup({ question: 'Q2?' });
      const wait2 = mgr.awaitAnswer({ ticket_id: t2.ticket_id, timeout_s: 5 });
      mgr.recordAnswer({
        question_id: mgr.currentQuestion()!.id,
        value: 'A2',
        source: 'synthesis',
      });
      await wait2;
      const view = mgr.sessionView();
      expect(view.decisions).toEqual([
        expect.objectContaining({ question: 'Q1?', answer: 'A1' }),
        expect.objectContaining({ question: 'Q2?', answer: 'A2' }),
      ]);
    } finally {
      cleanup();
    }
  });

  it('awaitAnswer wakes early when a new suggestion arrives (long-poll)', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      const t = mgr.askGroup({ question: 'q?' });
      const qid = mgr.currentQuestion()!.id;

      // Long timeout (5s). If wake-on-activity works, this resolves in ~50ms.
      const t0 = Date.now();
      const waitP = mgr.awaitAnswer({ ticket_id: t.ticket_id, timeout_s: 5 });
      setTimeout(() => {
        mgr.postSuggestion({ participant_id: p.id, question_id: qid, value: 'X' });
      }, 50);
      const snap = await waitP;
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2000); // should be ~50ms, well under the 5s timeout
      expect(snap.suggestions).toHaveLength(1);
      expect(snap.resolved).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('awaitAnswer wakes early when a new comment arrives', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      const t = mgr.askGroup({ question: 'q?' });
      const qid = mgr.currentQuestion()!.id;

      const t0 = Date.now();
      const waitP = mgr.awaitAnswer({ ticket_id: t.ticket_id, timeout_s: 5 });
      setTimeout(() => {
        mgr.postComment({ participant_id: p.id, question_id: qid, text: 'hi' });
      }, 50);
      const snap = await waitP;
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(snap.comments).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('postSuggestion upserts: second submission from same participant replaces the first', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.askGroup({ question: 'q?' });
      const q = mgr.currentQuestion()!;
      mgr.postSuggestion({ participant_id: p.id, question_id: q.id, value: 'first', rationale: 'r1' });
      mgr.postSuggestion({ participant_id: p.id, question_id: q.id, value: 'second' });
      expect(q.suggestions).toHaveLength(1);
      expect(q.suggestions[0]!.value).toBe('second');
      // Rationale was cleared on the second submission (no rationale passed).
      expect(q.suggestions[0]!.rationale).toBeUndefined();
      expect(events.find((e) => e.type === 'suggestion_added')).toBeTruthy();
      expect(events.find((e) => e.type === 'suggestion_updated')).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('postSuggestion keeps separate slots for different participants', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const a = mgr.addParticipant({ display_name: 'Alice' });
      const b = mgr.addParticipant({ display_name: 'Bob' });
      mgr.askGroup({ question: 'q?' });
      const q = mgr.currentQuestion()!;
      mgr.postSuggestion({ participant_id: a.id, question_id: q.id, value: 'A1' });
      mgr.postSuggestion({ participant_id: b.id, question_id: q.id, value: 'B1' });
      expect(q.suggestions).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('stop() returns transcript path with ended_reason=stop_session', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'auth' });
      const out = mgr.stop('stop_session');
      expect(out.ok).toBe(true);
      expect(out.transcript_path).toMatch(/auth\.json$/);
    } finally {
      cleanup();
    }
  });

  it('replay since seq returns events after that seq', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      mgr.addParticipant({ display_name: 'A' });
      mgr.addParticipant({ display_name: 'B' });
      const all = mgr.replay(-1);
      expect(all.length).toBeGreaterThanOrEqual(2);
      const justLast = mgr.replay(all[all.length - 1]!.seq);
      expect(justLast).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('postSuggestion + postComment populate the current question', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const p = mgr.addParticipant({ display_name: 'H' });
      const t = mgr.askGroup({ question: 'q?' });
      const q = mgr.currentQuestion()!;
      mgr.postSuggestion({
        participant_id: p.id,
        question_id: q.id,
        value: 'sg',
        rationale: 'because',
      });
      mgr.postComment({ participant_id: p.id, question_id: q.id, text: 'hi' });
      expect(q.suggestions).toHaveLength(1);
      expect(q.comments).toHaveLength(1);
      expect(events.find((e) => e.type === 'suggestion_added')).toBeTruthy();
      expect(events.find((e) => e.type === 'comment_added')).toBeTruthy();
      expect(t.ticket_id).toBe(q.ticket_id);
    } finally {
      cleanup();
    }
  });

  it('cancelCurrentQuestion resolves ticket as cancelled', async () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'a' });
      const t = mgr.askGroup({ question: 'q?' });
      const wait = mgr.awaitAnswer({ ticket_id: t.ticket_id, timeout_s: 5 });
      mgr.cancelCurrentQuestion('host_cancelled');
      const snap = await wait;
      expect(snap.resolved).toBe(false); // cancelled is not "resolved"
      expect(events.find((e) => e.type === 'question_cancelled')).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('broadcast is optional in opts; setBroadcaster rebinds at runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbsess-'));
    try {
      const mgr = new SessionManager({
        clock: fixedClock('2026-04-29T12:00:00Z'),
        transcriptDir: dir,
      });
      mgr.start({ brief: 'a' });
      mgr.addParticipant({ display_name: 'Pre' });

      const captured: ServerEvent[] = [];
      mgr.setBroadcaster((e) => captured.push(e));
      mgr.addParticipant({ display_name: 'Post' });
      expect(captured.find((e) => e.type === 'participant_joined')).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() transcript includes resolved + cancelled + timeout questions with new source field', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'audit' });
      const helper = mgr.addParticipant({ display_name: 'H' });

      // 1) Resolved question.
      const t1 = mgr.askGroup({ question: 'A?' });
      const w1 = mgr.awaitAnswer({ ticket_id: t1.ticket_id, timeout_s: 5 });
      const q1 = mgr.currentQuestion()!;
      mgr.postSuggestion({
        participant_id: helper.id,
        question_id: q1.id,
        value: 'sug-1',
        rationale: 'r1',
      });
      mgr.postComment({ participant_id: helper.id, question_id: q1.id, text: 'cmt-1' });
      mgr.recordAnswer({ question_id: q1.id, value: 'A1', source: 'suggestion' });
      await w1;

      // 2) Cancelled question.
      const t2 = mgr.askGroup({ question: 'B?' });
      const w2 = mgr.awaitAnswer({ ticket_id: t2.ticket_id, timeout_s: 5 });
      const q2 = mgr.currentQuestion()!;
      mgr.postSuggestion({ participant_id: helper.id, question_id: q2.id, value: 'sug-2' });
      mgr.cancelCurrentQuestion('host_cancelled');
      await w2;

      // 3) Timed-out question (via explicit hook).
      const t3 = mgr.askGroup({ question: 'C?' });
      const q3 = mgr.currentQuestion()!;
      mgr.postComment({ participant_id: helper.id, question_id: q3.id, text: 'cmt-3' });
      const w3 = mgr.awaitAnswer({ ticket_id: t3.ticket_id, timeout_s: 1 });
      mgr.timeoutCurrentQuestion();
      const r3 = await w3;
      expect(r3.resolved).toBe(false);

      const out = mgr.stop('stop_session');
      const parsed = TranscriptV2.parse(JSON.parse(readFileSync(out.transcript_path, 'utf8')));
      expect(parsed.schema_version).toBe(2);
      expect(parsed.questions).toHaveLength(3);

      const byText = new Map(parsed.questions.map((q) => [q.text, q] as const));
      const a = byText.get('A?')!;
      const b = byText.get('B?')!;
      const c = byText.get('C?')!;

      expect(a.status).toBe('resolved');
      expect(a.suggestions).toHaveLength(1);
      expect(a.comments).toHaveLength(1);
      expect(a.resolution?.value).toBe('A1');
      expect(a.resolution?.source).toBe('suggestion');

      expect(b.status).toBe('cancelled');
      expect(b.suggestions).toHaveLength(1);
      expect(b.resolution).toBeNull();

      expect(c.status).toBe('timeout');
      expect(c.comments).toHaveLength(1);
      expect(c.resolution).toBeNull();
    } finally {
      cleanup();
    }
  });
});
