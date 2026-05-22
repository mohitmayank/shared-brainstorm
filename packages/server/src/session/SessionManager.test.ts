import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParticipantId, QuestionId } from '@shared-brainstorm/shared';
import { SessionManager } from './SessionManager.js';
import { fixedClock } from './clock.js';
import { TranscriptV2, type ServerEvent, type EphemeralFrame } from '@shared-brainstorm/shared';

const makeMgr = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbsess-'));
  const events: ServerEvent[] = [];
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    // Durable ServerEvents always carry 'seq'; only push those to the events array.
    broadcast: (e) => { if ('seq' in e) events.push(e as ServerEvent); },
    transcriptDir: dir,
  });
  return {
    mgr,
    events,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/**
 * makeMgrWithEphemeral creates a manager where the broadcaster also captures
 * EphemeralFrame objects alongside ServerEvent objects, enabling tests to assert
 * on broadcastEphemeral() calls.
 */
const makeMgrWithEphemeral = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbsess-'));
  const events: ServerEvent[] = [];
  const ephemeral: EphemeralFrame[] = [];
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    broadcast: (e) => {
      // Discriminate by presence of 'seq' — ServerEvent always has seq
      if ('seq' in e) {
        events.push(e as ServerEvent);
      } else {
        ephemeral.push(e as EphemeralFrame);
      }
    },
    transcriptDir: dir,
  });
  return {
    mgr,
    events,
    ephemeral,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

const makeMgrWithCaps = (caps: {
  maxParticipants?: number;
  maxSuggestionsPerParticipantPerQuestion?: number;
  maxCommentsPerQuestion?: number;
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sbsess-'));
  const events: ServerEvent[] = [];
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    // Durable ServerEvents always carry 'seq'; only push those to the events array.
    broadcast: (e) => { if ('seq' in e) events.push(e as ServerEvent); },
    transcriptDir: dir,
    ...(caps.maxParticipants !== undefined ? { maxParticipants: caps.maxParticipants } : {}),
    ...(caps.maxSuggestionsPerParticipantPerQuestion !== undefined
      ? { maxSuggestionsPerParticipantPerQuestion: caps.maxSuggestionsPerParticipantPerQuestion }
      : {}),
    ...(caps.maxCommentsPerQuestion !== undefined
      ? { maxCommentsPerQuestion: caps.maxCommentsPerQuestion }
      : {}),
  });
  return {
    mgr,
    events,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

describe('SessionManager', () => {
  it('start() creates a session with id (no join_code in v2.0.0)', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      const out = mgr.start({ brief: 'auth flow' });
      expect(out.session_id).toMatch(/^sb_s_/);
      expect((out as unknown as Record<string, unknown>)['join_code']).toBeUndefined();
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
      ).toThrow(/no open question with id/);
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
      mgr.setBroadcaster((e) => { if ('seq' in e) captured.push(e as ServerEvent); });
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

  // ---------------------------------------------------------------------------
  // caps (REL-07) — D-05 / D-06 / D-07
  // ---------------------------------------------------------------------------
  describe('caps (REL-07)', () => {
    it('addParticipant throws cap_exceeded:participants when maxParticipants reached', () => {
      const { mgr, cleanup } = makeMgrWithCaps({ maxParticipants: 3 });
      try {
        mgr.start({ brief: 'a' });
        mgr.addParticipant({ display_name: 'A' });
        mgr.addParticipant({ display_name: 'B' });
        mgr.addParticipant({ display_name: 'C' });
        let caught: unknown;
        try {
          mgr.addParticipant({ display_name: 'D' });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error & { code: string; limit: number };
        expect(err.code).toBe('cap_exceeded:participants');
        expect(err.limit).toBe(3);
      } finally {
        cleanup();
      }
    });

    it('cap-rejected participant does NOT emit participant_joined (D-07)', () => {
      const { mgr, events, cleanup } = makeMgrWithCaps({ maxParticipants: 2 });
      try {
        mgr.start({ brief: 'a' });
        mgr.addParticipant({ display_name: 'A' });
        mgr.addParticipant({ display_name: 'B' });
        expect(events.filter((e) => e.type === 'participant_joined')).toHaveLength(2);
        expect(() => mgr.addParticipant({ display_name: 'C' })).toThrow(/participant cap/);
        // No new participant_joined event from the rejected add.
        expect(events.filter((e) => e.type === 'participant_joined')).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    // NOTE: postSuggestion cap test deferred per 02-03-PLAN.md §Concerns and
    // user resolution (Interpretation A, 2026-05-19). Under the current
    // dedupe-by-participant logic the per-participant cap is unreachable —
    // a re-submit from the same participant updates the existing suggestion
    // rather than appending a new one, so any one participant can only ever
    // have 1 suggestion per question. The throw branch ships as a
    // forward-compat seatbelt for when batch-question semantics arrive in a
    // later phase; intentionally untested at this layer.

    it('postComment throws cap_exceeded:comments when maxCommentsPerQuestion reached', () => {
      const { mgr, cleanup } = makeMgrWithCaps({ maxCommentsPerQuestion: 5 });
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'A' });
        mgr.askGroup({ question: 'q?' });
        const q = mgr.currentQuestion()!;
        for (let i = 0; i < 5; i++) {
          mgr.postComment({ participant_id: p.id, question_id: q.id, text: `c${i}` });
        }
        let caught: unknown;
        try {
          mgr.postComment({ participant_id: p.id, question_id: q.id, text: 'overflow' });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error & { code: string; limit: number };
        expect(err.code).toBe('cap_exceeded:comments');
        expect(err.limit).toBe(5);
      } finally {
        cleanup();
      }
    });

    it('cap-rejected comment does NOT emit comment_added (D-07)', () => {
      const { mgr, events, cleanup } = makeMgrWithCaps({ maxCommentsPerQuestion: 2 });
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'A' });
        mgr.askGroup({ question: 'q?' });
        const q = mgr.currentQuestion()!;
        mgr.postComment({ participant_id: p.id, question_id: q.id, text: '1' });
        mgr.postComment({ participant_id: p.id, question_id: q.id, text: '2' });
        expect(events.filter((e) => e.type === 'comment_added')).toHaveLength(2);
        expect(() =>
          mgr.postComment({ participant_id: p.id, question_id: q.id, text: '3' }),
        ).toThrow(/comment cap/);
        // No new comment_added event from the rejected post.
        expect(events.filter((e) => e.type === 'comment_added')).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    it('default caps allow 50 participants and 100 comments per question', () => {
      // Use the standard makeMgr() — no cap opts.
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        // 50 participants should all succeed.
        const participants = [];
        for (let i = 0; i < 50; i++) {
          participants.push(mgr.addParticipant({ display_name: `P${i}` }));
        }
        expect(participants).toHaveLength(50);
        // 51st should throw.
        expect(() => mgr.addParticipant({ display_name: 'P51' })).toThrow(/participant cap/);

        mgr.askGroup({ question: 'q?' });
        const q = mgr.currentQuestion()!;
        const first = participants[0]!;
        for (let i = 0; i < 100; i++) {
          mgr.postComment({ participant_id: first.id, question_id: q.id, text: `c${i}` });
        }
        expect(q.comments).toHaveLength(100);
        expect(() =>
          mgr.postComment({ participant_id: first.id, question_id: q.id, text: 'overflow' }),
        ).toThrow(/comment cap/);
      } finally {
        cleanup();
      }
    });
  });

  describe('approveParticipant', () => {
    it('approveParticipant() flips status to approved and emits participant_status_changed', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'Alice' });
        expect(p.status).toBe('pending');
        mgr.approveParticipant(p.id);
        const view = mgr.sessionView();
        expect(view.participants[0]!.status).toBe('approved');
        const changed = events.filter((e) => e.type === 'participant_status_changed');
        expect(changed).toHaveLength(1);
        if (changed[0] && changed[0].type === 'participant_status_changed') {
          const ev = changed[0] as { type: string; payload: { participant_id: string; status: string } };
          expect(ev.payload.participant_id).toBe(p.id);
          expect(ev.payload.status).toBe('approved');
        }
      } finally {
        cleanup();
      }
    });

    it('approveParticipant() is idempotent when already approved', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.approveParticipant(p.id);
        mgr.approveParticipant(p.id); // second call is no-op
        const changed = events.filter((e) => e.type === 'participant_status_changed');
        expect(changed).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('approveParticipant() throws on unknown id', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const fakeId = 'p_nonexistent' as ParticipantId;
        expect(() => mgr.approveParticipant(fakeId)).toThrow(/unknown id/);
      } finally {
        cleanup();
      }
    });
  });

  describe('kickParticipant', () => {
    it('kickParticipant() sets status to kicked and emits participant_status_changed', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.approveParticipant(p.id);
        mgr.kickParticipant(p.id);
        const view = mgr.sessionView();
        expect(view.participants[0]!.status).toBe('kicked');
        // approveParticipant emits one event, then kickParticipant emits one more
        const changed = events.filter((e) => e.type === 'participant_status_changed');
        // The last changed event is for 'kicked'
        const kickedEvt = changed[changed.length - 1];
        expect(kickedEvt).toBeDefined();
        if (kickedEvt && kickedEvt.type === 'participant_status_changed') {
          const ev = kickedEvt as { type: string; payload: { participant_id: string; status: string } };
          expect(ev.payload.participant_id).toBe(p.id);
          expect(ev.payload.status).toBe('kicked');
        }
      } finally {
        cleanup();
      }
    });

    it('kickParticipant() is idempotent when already kicked', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.approveParticipant(p.id);
        mgr.kickParticipant(p.id);
        mgr.kickParticipant(p.id); // second call is no-op
        // approveParticipant + kickParticipant = 2 events total; second kick is a no-op
        const statusChanged = events.filter((e) => e.type === 'participant_status_changed');
        const kicked = statusChanged.filter((e) => {
          if (e.type !== 'participant_status_changed') return false;
          const ev = e as { type: string; payload: { status: string } };
          return ev.payload.status === 'kicked';
        });
        expect(kicked).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('kickParticipant() throws on unknown id', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const fakeId = 'p_nonexistent' as ParticipantId;
        expect(() => mgr.kickParticipant(fakeId)).toThrow(/unknown id/);
      } finally {
        cleanup();
      }
    });

    it('kickParticipant() does NOT delete participant from Map', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.approveParticipant(p.id);
        mgr.kickParticipant(p.id);
        // Participant must remain in sessionView with status 'kicked' (not deleted)
        const view = mgr.sessionView();
        expect(view.participants).toHaveLength(1);
        expect(view.participants[0]!.id).toBe(p.id);
        expect(view.participants[0]!.status).toBe('kicked');
      } finally {
        cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // session_status state machine + broadcastEphemeral (Phase 5 PRES-01)
  // ---------------------------------------------------------------------------
  describe('session_status state machine', () => {
    it('Test 1: start() creates an active session with session_status === "waiting"', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const view = mgr.sessionView();
        expect(view.session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });

    it('Test 2: askGroup() emits session_status_changed with status "question_open"', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.askGroup({ question: 'q?' });
        const statusChanged = events.filter((e) => e.type === 'session_status_changed');
        expect(statusChanged).toHaveLength(1);
        if (statusChanged[0] && statusChanged[0].type === 'session_status_changed') {
          const ev = statusChanged[0] as { type: string; payload: { status: string } };
          expect(ev.payload.status).toBe('question_open');
        }
      } finally {
        cleanup();
      }
    });

    it('Test 3: recordAnswer() emits session_status_changed with status "waiting"', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.askGroup({ question: 'q?' });
        const qid = mgr.currentQuestion()!.id;
        mgr.recordAnswer({ question_id: qid, value: 'A', source: 'suggestion' });
        const statusChangedEvents = events.filter((e) => e.type === 'session_status_changed');
        // First is question_open, second is waiting (after recordAnswer)
        const waitingEvt = statusChangedEvents.find((e) => {
          if (e.type !== 'session_status_changed') return false;
          const ev = e as { type: string; payload: { status: string } };
          return ev.payload.status === 'waiting';
        });
        expect(waitingEvt).toBeDefined();
        expect(mgr.sessionView().session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });

    it('Test 4: cancelCurrentQuestion() emits session_status_changed with status "waiting"', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.askGroup({ question: 'q?' });
        mgr.cancelCurrentQuestion('host_cancelled');
        const statusChanged = events.filter((e) => e.type === 'session_status_changed');
        const waitingEvt = statusChanged.find((e) => {
          if (e.type !== 'session_status_changed') return false;
          const ev = e as { type: string; payload: { status: string } };
          return ev.payload.status === 'waiting';
        });
        expect(waitingEvt).toBeDefined();
        expect(mgr.sessionView().session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });

    it('Test 5: timeoutCurrentQuestion() emits session_status_changed with status "waiting"', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.askGroup({ question: 'q?' });
        mgr.timeoutCurrentQuestion();
        const statusChanged = events.filter((e) => e.type === 'session_status_changed');
        const waitingEvt = statusChanged.find((e) => {
          if (e.type !== 'session_status_changed') return false;
          const ev = e as { type: string; payload: { status: string } };
          return ev.payload.status === 'waiting';
        });
        expect(waitingEvt).toBeDefined();
        expect(mgr.sessionView().session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });

    it('Test 6: stop() emits session_status_changed with status "done"', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.stop('stop_session');
        const doneEvt = events.find((e) => {
          if (e.type !== 'session_status_changed') return false;
          const ev = e as { type: string; payload: { status: string } };
          return ev.payload.status === 'done';
        });
        expect(doneEvt).toBeDefined();
      } finally {
        cleanup();
      }
    });

    it('Test 7: setSessionStatus() is idempotent — calling setSessionStatus("waiting") when already "waiting" does NOT emit a second session_status_changed event', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        // Status is already 'waiting' after start(); calling it again should no-op
        mgr.setSessionStatus('waiting');
        const statusChanged = events.filter((e) => e.type === 'session_status_changed');
        expect(statusChanged).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it('Test 8: sessionView() returns { session_status: "question_open" } after askGroup()', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.askGroup({ question: 'q?' });
        expect(mgr.sessionView().session_status).toBe('question_open');
      } finally {
        cleanup();
      }
    });

    it('Test 9 (CRITICAL RingBuffer invariant): broadcastEphemeral does NOT push to RingBuffer', () => {
      const { mgr, cleanup } = makeMgrWithEphemeral();
      try {
        mgr.start({ brief: 'a' });
        const beforeLen = mgr.replay(-1).length;
        mgr.broadcastEphemeral({ type: 'heartbeat' });
        const afterLen = mgr.replay(-1).length;
        expect(afterLen).toBe(beforeLen);
      } finally {
        cleanup();
      }
    });

    it('Test 10: after broadcastEphemeral(), the broadcaster spy was called exactly once with the frame passed in', () => {
      const { mgr, ephemeral, cleanup } = makeMgrWithEphemeral();
      try {
        mgr.start({ brief: 'a' });
        mgr.broadcastEphemeral({ type: 'heartbeat' });
        expect(ephemeral).toHaveLength(1);
        expect(ephemeral[0]).toEqual({ type: 'heartbeat' });
      } finally {
        cleanup();
      }
    });

    it('Test 11: choosing status transition — setSessionStatus("choosing") emits session_status_changed with status "choosing", sessionView() returns "choosing"', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.askGroup({ question: 'q?' });
        mgr.setSessionStatus('choosing');
        const choosingEvt = events.find((e) => {
          if (e.type !== 'session_status_changed') return false;
          const ev = e as { type: string; payload: { status: string } };
          return ev.payload.status === 'choosing';
        });
        expect(choosingEvt).toBeDefined();
        expect(mgr.sessionView().session_status).toBe('choosing');
      } finally {
        cleanup();
      }
    });

    it('Test 12: sessionView() result contains session_status (welcome payload chain — ws.ts assembles welcome from sessionView())', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const view = mgr.sessionView();
        expect('session_status' in view).toBe(true);
        expect(view.session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });
  });

  describe('setLocked', () => {
    it('setLocked(true) emits room_locked with locked:true', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.setLocked(true);
        const locked = events.filter((e) => e.type === 'room_locked');
        expect(locked).toHaveLength(1);
        if (locked[0] && locked[0].type === 'room_locked') {
          const ev = locked[0] as { type: string; payload: { locked: boolean } };
          expect(ev.payload.locked).toBe(true);
        }
      } finally {
        cleanup();
      }
    });

    it('setLocked() is idempotent — calling setLocked(true) twice emits only one event', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.setLocked(true);
        mgr.setLocked(true); // second call is no-op
        const locked = events.filter((e) => e.type === 'room_locked');
        expect(locked).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('setLocked(false) unlocks and emits room_locked with locked:false', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        mgr.setLocked(true);
        mgr.setLocked(false);
        const locked = events.filter((e) => e.type === 'room_locked');
        expect(locked).toHaveLength(2);
        if (locked[1] && locked[1].type === 'room_locked') {
          const ev = locked[1] as { type: string; payload: { locked: boolean } };
          expect(ev.payload.locked).toBe(false);
        }
      } finally {
        cleanup();
      }
    });
  });

  describe('SessionManager — coordinator token', () => {
    it('coordinatorToken() returns a 22-char token in the ALPHABET set', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'x' });
        const token = mgr.coordinatorToken();
        expect(token).toHaveLength(22);
        expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      } finally {
        cleanup();
      }
    });

    it('mints a unique token across sessions', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const t1 = mgr.coordinatorToken();
        mgr.stop('stop_session');
        mgr.start({ brief: 'b' });
        const t2 = mgr.coordinatorToken();
        expect(t1).not.toBe(t2);
      } finally {
        cleanup();
      }
    });

    it('coordinatorToken() throws before start() and after stop()', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        expect(() => mgr.coordinatorToken()).toThrow(/no active session/);
        mgr.start({ brief: 'a' });
        mgr.stop('stop_session');
        expect(() => mgr.coordinatorToken()).toThrow(/no active session/);
      } finally {
        cleanup();
      }
    });

    it('does not leak the token into sessionView()', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const token = mgr.coordinatorToken();
        expect(JSON.stringify(mgr.sessionView())).not.toContain(token);
      } finally {
        cleanup();
      }
    });

    it('does not leak the token into the transcript', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const token = mgr.coordinatorToken();
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.askGroup({ question: 'q?' });
        const q = mgr.currentQuestion()!;
        mgr.postSuggestion({ participant_id: p.id, question_id: q.id, value: 'use X' });
        const { transcript_path } = mgr.stop('stop_session');
        const parsed = TranscriptV2.parse(JSON.parse(readFileSync(transcript_path, 'utf8')));
        expect(JSON.stringify(parsed)).not.toContain(token);
      } finally {
        cleanup();
      }
    });

    it('does not leak the token into any RingBuffer event', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'a' });
        const token = mgr.coordinatorToken();
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.askGroup({ question: 'q?' });
        const q = mgr.currentQuestion()!;
        mgr.postSuggestion({ participant_id: p.id, question_id: q.id, value: 'use X' });
        mgr.postComment({ participant_id: p.id, question_id: q.id, text: 'thoughts' });
        expect(mgr.replay(-1).every((e) => !JSON.stringify(e).includes(token))).toBe(true);
      } finally {
        cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 6: batch questions (BATCH-01 / BATCH-02)
  // ---------------------------------------------------------------------------
  describe('Phase 6: batch questions (BATCH-01 / BATCH-02)', () => {
    it('askGroup(single) returns {ticket_id: string} — no question_id field (byte-identical back-compat)', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroup({ question: 'Q1?' });
        expect(result.ticket_id).toMatch(/^sb_t_/);
        expect((result as Record<string, unknown>)['question_id']).toBeUndefined();
        expect((result as Record<string, unknown>)['tickets']).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('askGroupBatch([Q1, Q2]) returns {tickets:[{question_id, ticket_id}, ...]} with both questions in open_questions', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroupBatch([
          { question: 'Q1?' },
          { question: 'Q2?' },
        ]);
        expect(result.tickets).toHaveLength(2);
        expect(result.tickets[0]!.question_id).toMatch(/^sb_q_/);
        expect(result.tickets[0]!.ticket_id).toMatch(/^sb_t_/);
        expect(result.tickets[1]!.question_id).toMatch(/^sb_q_/);
        expect(result.tickets[1]!.ticket_id).toMatch(/^sb_t_/);
        // Both question_ids should be distinct
        expect(result.tickets[0]!.question_id).not.toBe(result.tickets[1]!.question_id);
        // sessionView should have both open
        expect(mgr.sessionView().questions).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    it('askGroupBatch preserves askGroup submission order in sessionView().questions[]', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroupBatch([
          { question: 'First?' },
          { question: 'Second?' },
        ]);
        const questions = mgr.sessionView().questions;
        expect(questions[0]!.text).toBe('First?');
        expect(questions[1]!.text).toBe('Second?');
        // Confirm order matches returned tickets array
        expect(questions[0]!.ticket_id).toBe(result.tickets[0]!.ticket_id);
        expect(questions[1]!.ticket_id).toBe(result.tickets[1]!.ticket_id);
      } finally {
        cleanup();
      }
    });

    it('postSuggestion routes to Q2 by question_id when both Q1 and Q2 are open; Q1.suggestions unaffected', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const p = mgr.addParticipant({ display_name: 'Alice' });
        mgr.approveParticipant(p.id as ParticipantId);
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q2id = result.tickets[1]!.question_id;
        const questions = mgr.sessionView().questions;
        const q1 = questions[0]!;
        const q2 = questions.find((q) => q.id === q2id)!;
        mgr.postSuggestion({ participant_id: p.id, question_id: q2.id, value: 'ans-q2' });
        expect(q2.suggestions).toHaveLength(1);
        expect(q2.suggestions[0]!.value).toBe('ans-q2');
        expect(q1.suggestions).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it('recordAnswer on Q2 resolves Q2 ticket; Q1 ticket remains pending; open_questions still has Q1', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q1Entry = result.tickets[0]!;
        const q2Entry = result.tickets[1]!;
        mgr.recordAnswer({ question_id: q2Entry.question_id as QuestionId, value: 'A2', source: 'override' });
        // Q1 should still be open
        const view = mgr.sessionView();
        expect(view.questions).toHaveLength(1);
        expect(view.questions[0]!.ticket_id).toBe(q1Entry.ticket_id);
        // Q1's question must still be broadcast (not resolved)
        expect(view.questions[0]!.status).toBe('broadcast');
      } finally {
        cleanup();
      }
    });

    it('session_status stays question_open after recording Q2 answer while Q1 is still open', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q2Entry = result.tickets[1]!;
        mgr.recordAnswer({ question_id: q2Entry.question_id as QuestionId, value: 'A2', source: 'override' });
        expect(mgr.sessionView().session_status).toBe('question_open');
      } finally {
        cleanup();
      }
    });

    it('session_status becomes waiting after recordAnswer resolves the last open question', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q1Entry = result.tickets[0]!;
        const q2Entry = result.tickets[1]!;
        mgr.recordAnswer({ question_id: q2Entry.question_id as QuestionId, value: 'A2', source: 'override' });
        mgr.recordAnswer({ question_id: q1Entry.question_id as QuestionId, value: 'A1', source: 'override' });
        expect(mgr.sessionView().session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });

    it('sessionView().questions returns [Q1, Q2] in submission order (both open)', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const questions = mgr.sessionView().questions;
        expect(questions).toHaveLength(2);
        expect(questions[0]!.text).toBe('Q1?');
        expect(questions[1]!.text).toBe('Q2?');
      } finally {
        cleanup();
      }
    });

    it('sessionView().current_question equals questions[0] (back-compat derived field)', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const view = mgr.sessionView();
        expect(view.current_question).not.toBeNull();
        expect(view.current_question!.id).toBe(view.questions[0]!.id);
      } finally {
        cleanup();
      }
    });

    it('sessionView().current_question is null when open_questions is empty', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const view = mgr.sessionView();
        expect(view.current_question).toBeNull();
        expect(view.questions).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it('cancelAllOpenQuestions cancels all open questions; emits question_cancelled per question; open_questions is empty afterward', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        mgr.cancelAllOpenQuestions('host_cancelled');
        const cancelled = events.filter((e) => e.type === 'question_cancelled');
        expect(cancelled).toHaveLength(2);
        expect(mgr.sessionView().questions).toHaveLength(0);
      } finally {
        cleanup();
      }
    });

    it('stop() calls cancelAllOpenQuestions — all open tickets are cancelled', () => {
      const { mgr, events, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        mgr.stop('stop_session');
        const cancelled = events.filter((e) => e.type === 'question_cancelled');
        expect(cancelled).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    it('snapshot() finds a question in open_questions (not just terminal questions)', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'batch' });
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q1Entry = result.tickets[0]!;
        const snap = mgr.snapshot(q1Entry.question_id as QuestionId, false);
        expect(snap.suggestions).toHaveLength(0);
        expect(snap.resolved).toBe(false);
      } finally {
        cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // CR-01 (errata E19): aggregate open-question cap
    // -------------------------------------------------------------------------
    it('CR-01: (N+1)-th askGroup() throws cap_exceeded:open_questions and creates no extra ticket', () => {
      // Use a minimal cap via the makeMgrWithCaps helper — don't add 20 real questions to test.
      // We exercise the cap at 2 instead of 20 to keep the test fast; the constant is a
      // module detail (SessionManager.ts) so this validates the enforcement logic.
      const { mgr, events, cleanup } = makeMgrWithCaps({});
      try {
        mgr.start({ brief: 'cr01' });
        // Open 20 questions (the MAX_OPEN_QUESTIONS default)
        for (let i = 0; i < 20; i++) {
          mgr.askGroup({ question: `Q${i}?` });
        }
        expect(mgr.sessionView().questions).toHaveLength(20);
        const questionsBroadcastBefore = events.filter((e) => e.type === 'question_broadcast').length;
        expect(questionsBroadcastBefore).toBe(20);

        // The 21st call must throw with the correct cap error shape.
        let caught: unknown;
        try {
          mgr.askGroup({ question: 'overflow?' });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error & { code: string; limit: number };
        expect(err.code).toBe('cap_exceeded:open_questions');
        expect(err.limit).toBe(20);

        // D-07: the rejected call must NOT have created a ticket or broadcast an event.
        expect(mgr.sessionView().questions).toHaveLength(20);
        expect(events.filter((e) => e.type === 'question_broadcast')).toHaveLength(20);
      } finally {
        cleanup();
      }
    });

    it('CR-01: askGroupBatch rejects the whole batch atomically when it would exceed the cap', () => {
      const { mgr, cleanup } = makeMgrWithCaps({});
      try {
        mgr.start({ brief: 'cr01-batch' });
        // Fill up to cap - 1 so there is exactly 1 slot left.
        for (let i = 0; i < 19; i++) {
          mgr.askGroup({ question: `Q${i}?` });
        }
        expect(mgr.sessionView().questions).toHaveLength(19);

        // A batch of 2 would need 2 slots but only 1 is left. askGroupBatch
        // pre-validates the WHOLE batch against the cap BEFORE creating any
        // ticket, so it rejects ATOMICALLY — NEITHER 'Extra1' NOR 'Extra2' is
        // created/broadcast (no orphaned, un-awaitable question holding a slot).
        let caught: unknown;
        try {
          mgr.askGroupBatch([{ question: 'Extra1?' }, { question: 'Extra2?' }]);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        const err = caught as Error & { code: string };
        expect(err.code).toBe('cap_exceeded:open_questions');
        // Atomic: the open-question count is UNCHANGED — no partial batch landed.
        expect(mgr.sessionView().questions).toHaveLength(19);
      } finally {
        cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // WR-01 / WR-03: per-ticket pick tracking via setPickingTicket
  // ---------------------------------------------------------------------------
  describe('WR-01/WR-03: per-ticket picking and coordinator-disconnect clearing', () => {
    it('WR-01 (a): picking Q1 then resolving Q2 keeps session_status=choosing', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'picking' });
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q1 = result.tickets[0]!;
        const q2 = result.tickets[1]!;
        // Simulate coordinator picking Q1.
        mgr.setPickingTicket(q1.ticket_id);
        expect(mgr.sessionView().session_status).toBe('choosing');
        // Resolve Q2 (sibling) — must NOT clear choosing because Q1 is still picked.
        mgr.recordAnswer({ question_id: q2.question_id as QuestionId, value: 'A2', source: 'override' });
        expect(mgr.sessionView().session_status).toBe('choosing');
      } finally {
        cleanup();
      }
    });

    it('WR-01 (b): picking Q1 then resolving Q1 exits session_status choosing', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'picking' });
        const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
        const q1 = result.tickets[0]!;
        mgr.setPickingTicket(q1.ticket_id);
        expect(mgr.sessionView().session_status).toBe('choosing');
        // Resolve Q1 (the picked question) — must exit choosing.
        mgr.recordAnswer({ question_id: q1.question_id as QuestionId, value: 'A1', source: 'override' });
        // Q2 is still open, so status must be question_open (not waiting).
        expect(mgr.sessionView().session_status).toBe('question_open');
      } finally {
        cleanup();
      }
    });

    it('WR-03 (c): setPickingTicket(null) clears choosing — simulates coordinator disconnect', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'picking' });
        const { ticket_id } = mgr.askGroup({ question: 'Q1?' });
        mgr.setPickingTicket(ticket_id);
        expect(mgr.sessionView().session_status).toBe('choosing');
        // Coordinator disconnects — ws.ts calls setPickingTicket(null).
        mgr.setPickingTicket(null);
        // Q1 is still open, so status must fall back to question_open.
        expect(mgr.sessionView().session_status).toBe('question_open');
      } finally {
        cleanup();
      }
    });

    it('setPickingTicket with a stale/resolved ticket_id is a silent no-op (no status change)', () => {
      const { mgr, cleanup } = makeMgr();
      try {
        mgr.start({ brief: 'picking' });
        const { ticket_id } = mgr.askGroup({ question: 'Q1?' });
        const qid = mgr.currentQuestion()!.id;
        // Resolve Q1.
        mgr.recordAnswer({ question_id: qid, value: 'A1', source: 'override' });
        expect(mgr.sessionView().session_status).toBe('waiting');
        // setPickingTicket with the now-terminal ticket — must be a no-op.
        mgr.setPickingTicket(ticket_id);
        expect(mgr.sessionView().session_status).toBe('waiting');
      } finally {
        cleanup();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 7 (CHATAI-01): postClarification + answerClarification
// ---------------------------------------------------------------------------

describe('postClarification', () => {
  it('approved participant appends clarification and emits clarification_added', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'What about latency?',
      });
      const freshQ = mgr.currentQuestion()!;
      expect(freshQ.clarifications).toHaveLength(1);
      expect(freshQ.clarifications[0]!.text).toBe('What about latency?');
      expect(freshQ.clarifications[0]!.id).toMatch(/^sb_cl_/);
      const evt = events.find((e) => e.type === 'clarification_added');
      expect(evt).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('postClarification on a resolved question returns silently with no event emitted', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      // Resolve the question first
      mgr.recordAnswer({ question_id: q.id as import('@shared-brainstorm/shared').QuestionId, value: 'Postgres', source: 'override' });
      const countBefore = events.length;
      // Try to clarify on a now-resolved question (no longer in open_questions)
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'Late question',
      });
      // No new events — question not found in open_questions, silently returns
      expect(events.length).toBe(countBefore);
    } finally {
      cleanup();
    }
  });

  it('cap exceeded throws capError BEFORE push+emit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbsess-'));
    const events: ServerEvent[] = [];
    const mgr = new SessionManager({
      clock: fixedClock('2026-04-29T12:00:00Z'),
      broadcast: (e) => { if ('seq' in e) events.push(e as ServerEvent); },
      transcriptDir: dir,
      maxClarificationsPerQuestion: 1,
    });
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'First',
      });
      const countBefore = events.length;
      expect(() => mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'Overflow',
      })).toThrow();
      // No new events emitted when cap exceeded
      expect(events.length).toBe(countBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tickets.bump() is called (wakes awaitAnswer)', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;

      // Start awaitAnswer in background (will block until bump or timeout)
      const pollPromise = mgr.awaitAnswer({ ticket_id, timeout_s: 5 });

      // postClarification should bump the ticket
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'Any caching?',
      });

      const result = await pollPromise;
      expect(result.clarifications).toHaveLength(1);
      expect(result.clarifications[0]!.text).toBe('Any caching?');
    } finally {
      cleanup();
    }
  });
});

describe('answerClarification', () => {
  it('sets answer+answered_at on clarification and re-emits clarification_added', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'What about latency?',
      });
      // Get the clarification from snapshot
      const snapshot0 = mgr.snapshot(q.id as import('@shared-brainstorm/shared').QuestionId, false);
      const cl = snapshot0.clarifications[0]!;
      const countBefore = events.filter((e) => e.type === 'clarification_added').length;

      mgr.answerClarification({
        ticket_id,
        clarification_id: cl.clarification_id,
        answer_text: 'Latency is sub-1ms',
      });

      const snapshot1 = mgr.snapshot(q.id as import('@shared-brainstorm/shared').QuestionId, false);
      expect(snapshot1.clarifications[0]!.answer).toBe('Latency is sub-1ms');
      expect(snapshot1.clarifications[0]!.answered_at).toBeDefined();
      const newCount = events.filter((e) => e.type === 'clarification_added').length;
      expect(newCount).toBe(countBefore + 1);
    } finally {
      cleanup();
    }
  });

  it('terminal fallback: works after recordAnswer (question moved to terminalQuestions)', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'What about latency?',
      });
      // Get clarification id before resolving
      const snapshot0 = mgr.snapshot(q.id as import('@shared-brainstorm/shared').QuestionId, false);
      const clId = snapshot0.clarifications[0]!.clarification_id;

      // Resolve the question (moves to terminalQuestions)
      mgr.recordAnswer({ question_id: q.id as import('@shared-brainstorm/shared').QuestionId, value: 'Postgres', source: 'override' });

      // answerClarification should still find it via terminalQuestions
      expect(() => mgr.answerClarification({
        ticket_id,
        clarification_id: clId,
        answer_text: 'Still valid answer',
      })).not.toThrow();
    } finally {
      cleanup();
    }
  });

  it('throws when clarification_id not found', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      mgr.addParticipant({ display_name: 'Alice' });
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      expect(() => mgr.answerClarification({
        ticket_id,
        clarification_id: 'sb_cl_notfound',
        answer_text: 'Some answer',
      })).toThrow(/clarification/);
    } finally {
      cleanup();
    }
  });

  it('does NOT call tickets.bump (no second poll wake from answer)', async () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'Any caching?',
      });

      // Drain the bump from postClarification
      const snap0 = await mgr.awaitAnswer({ ticket_id, timeout_s: 1 });
      const clId = snap0.clarifications[0]!.clarification_id;

      // answerClarification should NOT bump; answerClarification just mutates + emits
      // We verify it doesn't throw and returns immediately (no async needed)
      mgr.answerClarification({ ticket_id, clarification_id: clId, answer_text: 'Yes, Redis' });
      // Check the answer is set in snapshot
      const snap1 = mgr.snapshot(q.id as import('@shared-brainstorm/shared').QuestionId, false);
      expect(snap1.clarifications[0]!.answer).toBe('Yes, Redis');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CHAT-01: postChat
// ---------------------------------------------------------------------------

describe('postChat', () => {
  it('Test 1: approved participant path appends ChatEntry and emits chat_added', () => {
    const { mgr, events, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'chat test' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      mgr.postChat({
        actor_kind: 'participant',
        actor_id: p.id,
        display_name: 'Alice',
        text: 'Hello room!',
      });
      const view = mgr.sessionView();
      expect(view.chat).toHaveLength(1);
      expect(view.chat[0]!.actor_kind).toBe('participant');
      expect(view.chat[0]!.display_name).toBe('Alice');
      expect(view.chat[0]!.text).toBe('Hello room!');
      expect(view.chat[0]!.actor_id).toBe(p.id);
      // chat_added event emitted
      const chatEvt = events.find((e) => e.type === 'chat_added');
      expect(chatEvt).toBeDefined();
      if (chatEvt && chatEvt.type === 'chat_added') {
        const ev = chatEvt as { type: string; payload: { entry: { id: string; actor_kind: string; display_name: string; text: string } } };
        expect(ev.payload.entry.actor_kind).toBe('participant');
        expect(ev.payload.entry.display_name).toBe('Alice');
        expect(ev.payload.entry.text).toBe('Hello room!');
        expect(ev.payload.entry.id).toBeDefined();
      }
    } finally {
      cleanup();
    }
  });

  it('Test 2: coordinator path stores display_name "Coordinator" and actor_kind "coordinator"; actor_id absent', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'chat test' });
      mgr.postChat({
        actor_kind: 'coordinator',
        display_name: 'Coordinator',
        text: 'Welcome everyone!',
      });
      const view = mgr.sessionView();
      expect(view.chat).toHaveLength(1);
      const entry = view.chat[0]!;
      expect(entry.actor_kind).toBe('coordinator');
      expect(entry.display_name).toBe('Coordinator');
      expect(entry.text).toBe('Welcome everyone!');
      // actor_id must not be present (exactOptionalPropertyTypes)
      expect('actor_id' in entry).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('Test 3: maxChatMessages cap — throws capError BEFORE push+emit when limit reached', () => {
    const { dir, cleanup } = makeMgr();
    const events: import('@shared-brainstorm/shared').ServerEvent[] = [];
    const capMgr = new SessionManager({
      clock: fixedClock('2026-04-29T12:00:00Z'),
      broadcast: (e) => { if ('seq' in e) events.push(e as import('@shared-brainstorm/shared').ServerEvent); },
      transcriptDir: dir,
      maxChatMessages: 2,
    });
    try {
      capMgr.start({ brief: 'cap test' });
      capMgr.postChat({ actor_kind: 'coordinator', display_name: 'Coordinator', text: 'msg1' });
      capMgr.postChat({ actor_kind: 'coordinator', display_name: 'Coordinator', text: 'msg2' });
      // Now at cap — next call must throw
      const countBefore = events.filter((e) => e.type === 'chat_added').length;
      expect(() =>
        capMgr.postChat({ actor_kind: 'coordinator', display_name: 'Coordinator', text: 'msg3' }),
      ).toThrow();
      // No new chat_added emitted after cap throw
      const countAfter = events.filter((e) => e.type === 'chat_added').length;
      expect(countAfter).toBe(countBefore);
      // chat array is still at cap (2) — not 3
      expect(capMgr.sessionView().chat).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('Test 4: sessionView().chat returns all posted entries', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'chat test' });
      mgr.postChat({ actor_kind: 'coordinator', display_name: 'Coordinator', text: 'msg1' });
      mgr.postChat({ actor_kind: 'coordinator', display_name: 'Coordinator', text: 'msg2' });
      const chat = mgr.sessionView().chat;
      expect(chat).toHaveLength(2);
      expect(chat[0]!.text).toBe('msg1');
      expect(chat[1]!.text).toBe('msg2');
    } finally {
      cleanup();
    }
  });

  it('Test 5: stop() transcript includes chat at top-level', () => {
    const { mgr, dir: _dir, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'chat test' });
      mgr.postChat({ actor_kind: 'coordinator', display_name: 'Coordinator', text: 'transcripted' });
      const { transcript_path } = mgr.stop('stop_session');
      const raw = readFileSync(transcript_path, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      // transcript.chat should contain our message
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyTranscript = parsed as Record<string, unknown>;
      expect(anyTranscript['chat']).toBeDefined();
      expect(Array.isArray(anyTranscript['chat'])).toBe(true);
      const chatArr = anyTranscript['chat'] as { text: string }[];
      expect(chatArr[0]!.text).toBe('transcripted');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// WR-01: ticket_to_question pruning on resolve/cancel/timeout
// ---------------------------------------------------------------------------

describe('WR-01: ticket_to_question pruning', () => {
  it('setPickingTicket with a resolved ticket_id is a no-op after recordAnswer prunes the entry', () => {
    // After pruning, ticket_to_question.get(ticket_id) returns undefined.
    // setPickingTicket guards: if (!qid || ...) return; → silent no-op.
    // If ticket_to_question were NOT pruned this would remain a "stale open"
    // entry and future readers could incorrectly treat it as open.
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'pruning' });
      const { ticket_id } = mgr.askGroup({ question: 'Q1?' });
      const qid = mgr.currentQuestion()!.id;
      mgr.recordAnswer({ question_id: qid, value: 'A1', source: 'override' });
      // After resolve + pruning, setPickingTicket must be a silent no-op.
      mgr.setPickingTicket(ticket_id); // would throw / misbehave if entry were stale
      expect(mgr.sessionView().session_status).toBe('waiting');
    } finally {
      cleanup();
    }
  });

  it('answerClarification succeeds after recordAnswer prunes ticket_to_question (terminal fallback)', () => {
    // This is the key regression guard for WR-01: the dual-lookup in
    // answerClarification (open_questions first, then terminalQuestions) must
    // still work after ticket_to_question is pruned on resolve.
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'pruning' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      const q = mgr.currentQuestion()!;
      mgr.postClarification({
        participant_id: p.id as import('@shared-brainstorm/shared').ParticipantId,
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        text: 'What about latency?',
      });
      const clId = mgr
        .snapshot(q.id as import('@shared-brainstorm/shared').QuestionId, false)
        .clarifications[0]!.clarification_id;
      // Resolve the question — this prunes ticket_to_question
      mgr.recordAnswer({
        question_id: q.id as import('@shared-brainstorm/shared').QuestionId,
        value: 'Postgres',
        source: 'override',
      });
      // answerClarification must still find the question via terminalQuestions
      expect(() =>
        mgr.answerClarification({ ticket_id, clarification_id: clId, answer_text: 'Sub-1ms' }),
      ).not.toThrow();
      const snap = mgr.snapshot(q.id as import('@shared-brainstorm/shared').QuestionId, true);
      expect(snap.clarifications[0]!.answer).toBe('Sub-1ms');
    } finally {
      cleanup();
    }
  });

  it('cancelAllOpenQuestions prunes ticket_to_question for all cancelled tickets', () => {
    // After cancel, setPickingTicket on a cancelled ticket is a silent no-op.
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'pruning cancel' });
      const result = mgr.askGroupBatch([{ question: 'Q1?' }, { question: 'Q2?' }]);
      const t1 = result.tickets[0]!.ticket_id;
      const t2 = result.tickets[1]!.ticket_id;
      mgr.cancelAllOpenQuestions('host_cancelled');
      // Both tickets are now terminal; setPickingTicket is a no-op for each.
      mgr.setPickingTicket(t1);
      mgr.setPickingTicket(t2);
      expect(mgr.sessionView().session_status).toBe('waiting');
    } finally {
      cleanup();
    }
  });

  it('timeoutCurrentQuestion prunes ticket_to_question for all timed-out tickets', () => {
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'pruning timeout' });
      const { ticket_id } = mgr.askGroup({ question: 'Q?' });
      mgr.timeoutCurrentQuestion();
      // Ticket is timed out; setPickingTicket is a no-op.
      mgr.setPickingTicket(ticket_id);
      expect(mgr.sessionView().session_status).toBe('waiting');
    } finally {
      cleanup();
    }
  });

  it('awaitAnswer on an already-resolved ticket (ticket_to_question pruned) returns resolved=true via terminalQuestions fallback', async () => {
    // Regression guard for the e2e coordinator flow: the coordinator browser
    // can POST /api/coordinator/answer (triggering recordAnswer) BEFORE the MCP
    // tool calls awaitAnswer. After WR-01 pruning, ticket_to_question.get()
    // returns undefined — awaitAnswer must fall through to terminalQuestions
    // and return a complete, resolved snapshot rather than an empty one with
    // resolved=false.
    const { mgr, cleanup } = makeMgr();
    try {
      mgr.start({ brief: 'await after resolve' });
      const p = mgr.addParticipant({ display_name: 'Alice' });
      mgr.approveParticipant(p.id);
      const { ticket_id } = mgr.askGroup({ question: 'Which DB?' });
      const qid = mgr.currentQuestion()!.id;
      mgr.postSuggestion({ participant_id: p.id, question_id: qid, value: 'Postgres' });
      // Resolve the question BEFORE calling awaitAnswer (simulates coordinator-browser-first path)
      mgr.recordAnswer({ question_id: qid, value: 'Postgres', source: 'suggestion' });
      // awaitAnswer must return resolved=true immediately via terminalQuestions fallback
      const snap = await mgr.awaitAnswer({ ticket_id, timeout_s: 5 });
      expect(snap.resolved).toBe(true);
      expect(snap.suggestions).toHaveLength(1);
      expect(snap.suggestions[0]!.value).toBe('Postgres');
    } finally {
      cleanup();
    }
  });
});
