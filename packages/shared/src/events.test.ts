import { describe, expect, it } from 'vitest';
import { ServerEvent, ClientCommand, EphemeralFrame, AnyFrame } from './events.js';

const sessionShape = {
  session_id: 'sb_s_a',
  brief: 'x',
  participants: [],
  decisions: [],
  questions: [], // Phase 6 (BATCH-02): required field
  current_question: null,
  locked: false,
  session_status: 'waiting' as const,
  chat: [], // CHATAI-01: required field
};
const youShape = { id: 'sb_p_x', display_name: 'Alice', joined_at: 'x', status: 'pending' as const };

describe('WS events', () => {
  it('parses welcome event', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false },
    });
    expect(ok.success).toBe(true);
  });

  it('parses question_broadcast event', () => {
    const ok = ServerEvent.safeParse({
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      type: 'question_broadcast',
      payload: {
        question: {
          id: 'sb_q_x',
          ticket_id: 'sb_t_x',
          asked_at: 'x',
          text: 'q?',
          status: 'broadcast',
          suggestions: [],
          comments: [],
          clarifications: [], // CHATAI-01: required field
          resolution: null,
        },
      },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects unknown event type', () => {
    const bad = ServerEvent.safeParse({ seq: 0, ts: 'x', type: 'nope', payload: {} });
    expect(bad.success).toBe(false);
  });

  it('rejects legacy question_preview event', () => {
    const bad = ServerEvent.safeParse({
      seq: 0,
      ts: 'x',
      type: 'question_preview',
      payload: { question: {} },
    });
    expect(bad.success).toBe(false);
  });

  it('parses post_suggestion command', () => {
    const ok = ClientCommand.safeParse({
      type: 'post_suggestion',
      question_id: 'sb_q_x',
      value: 'Postgres',
      rationale: 'existing infra',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects post_suggestion with empty value', () => {
    const bad = ClientCommand.safeParse({
      type: 'post_suggestion',
      question_id: 'sb_q_x',
      value: '',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects coordinator_accept command (removed)', () => {
    const bad = ClientCommand.safeParse({
      type: 'coordinator_accept',
      question_id: 'sb_q_x',
      value: 'A',
    });
    expect(bad.success).toBe(false);
  });
});

describe('welcome — is_coordinator', () => {
  it('parses a participant welcome (you present, is_coordinator:false)', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false },
    });
    expect(ok.success).toBe(true);
  });

  it('parses a coordinator welcome (you omitted, is_coordinator:true)', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a welcome missing is_coordinator (field is required)', () => {
    const bad = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, you: youShape },
    });
    expect(bad.success).toBe(false);
  });

  it('parses an EphemeralFrame coordinator welcome (you omitted, is_coordinator:true)', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an EphemeralFrame welcome missing is_coordinator', () => {
    const bad = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, you: youShape },
    });
    expect(bad.success).toBe(false);
  });

  it('does not carry a coordinator_token in the welcome payload (no such field)', () => {
    const parsed = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, coordinator_token: 'leak' },
    });
    // Zod strips unknown keys by default; assert the field never survives parse.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.payload as Record<string, unknown>).coordinator_token).toBeUndefined();
    }
  });
});

describe('welcome — advisories (cold-open seeding)', () => {
  const advisories = {
    room_empty: true,
    transport_failed: {
      code: 'cloudflared_permanent_failure' as const,
      message: 'tunnel down',
      restart_count: 3,
      at: '2026-05-19T12:00:00.000Z',
    },
  };

  it('parses a welcome carrying advisories', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, advisories },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect((ok.data.payload as { advisories?: typeof advisories }).advisories).toEqual(advisories);
    }
  });

  it('parses an EphemeralFrame welcome carrying advisories', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, advisories },
    });
    expect(ok.success).toBe(true);
  });

  it('parses a welcome with advisories omitted (back-compat with pre-advisory servers)', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true },
    });
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.type === 'welcome') {
      expect((ok.data.payload as { advisories?: unknown }).advisories).toBeUndefined();
    }
  });

  it('parses a partial advisories object (room_empty only)', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, advisories: { room_empty: true } },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects advisories with a malformed transport_failed.code', () => {
    const bad = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: {
        session: sessionShape,
        is_coordinator: true,
        advisories: { transport_failed: { ...advisories.transport_failed, code: 'nope' } },
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe('transport_failed event', () => {
  const validPayload = {
    code: 'cloudflared_permanent_failure' as const,
    message: 'tunnel exited after 3 restart attempts',
    restart_count: 3,
    at: '2026-05-19T12:00:00.000Z',
  };

  it('parses a valid transport_failed event', () => {
    const parsed = ServerEvent.safeParse({
      seq: 5,
      ts: '2026-05-19T12:00:00.000Z',
      type: 'transport_failed',
      payload: validPayload,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe('transport_failed');
    }
  });

  it('parses transport_failed with cloudflared_version_mismatch code', () => {
    const parsed = ServerEvent.safeParse({
      seq: 6,
      ts: '2026-05-19T12:00:00.000Z',
      type: 'transport_failed',
      payload: { ...validPayload, code: 'cloudflared_version_mismatch' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects transport_failed with unknown code', () => {
    const bad = ServerEvent.safeParse({
      seq: 5,
      ts: '2026-05-19T12:00:00.000Z',
      type: 'transport_failed',
      payload: { ...validPayload, code: 'invalid' },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects transport_failed with negative restart_count', () => {
    const bad = ServerEvent.safeParse({
      seq: 5,
      ts: '2026-05-19T12:00:00.000Z',
      type: 'transport_failed',
      payload: { ...validPayload, restart_count: -1 },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects transport_failed with missing at field', () => {
    const bad = ServerEvent.safeParse({
      seq: 5,
      ts: '2026-05-19T12:00:00.000Z',
      type: 'transport_failed',
      payload: {
        code: validPayload.code,
        message: validPayload.message,
        restart_count: validPayload.restart_count,
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe('EphemeralFrame', () => {
  it('parses welcome frame without seq', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false },
    });
    expect(ok.success).toBe(true);
  });

  it('parses heartbeat frame without seq', () => {
    const ok = EphemeralFrame.safeParse({ type: 'heartbeat' });
    expect(ok.success).toBe(true);
  });
});

describe('AnyFrame', () => {
  it('accepts a ServerEvent (welcome with seq)', () => {
    const ok = AnyFrame.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an EphemeralFrame (heartbeat without seq)', () => {
    const ok = AnyFrame.safeParse({ type: 'heartbeat' });
    expect(ok.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 14 (SHARE-01): WelcomePayload optional public_url field — Wave 0 stubs
// ---------------------------------------------------------------------------
// NOTE: These tests will FAIL until Plan 14-02 adds `public_url: z.string().url().optional()`
// to the ServerEvent / EphemeralFrame welcome payload schemas. That is expected Wave 0
// behavior — they define the contract that 14-02 satisfies.

describe('WelcomePayload public_url (Phase 14 SHARE-01)', () => {
  // ServerEvent (seq-carrying durable form) cases
  it('accepts welcome event with public_url field', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, public_url: 'https://join.example/' },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect((ok.data.payload as Record<string, unknown>).public_url).toBe('https://join.example/');
    }
  });

  it('accepts welcome event without public_url field (back-compat)', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects welcome event with non-URL public_url', () => {
    const bad = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, public_url: 'not-a-url' },
    });
    expect(bad.success).toBe(false);
  });

  // EphemeralFrame (no seq) parallel cases
  it('EphemeralFrame: accepts welcome with public_url', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, public_url: 'https://join.example/' },
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect((ok.data as { payload: Record<string, unknown> }).payload.public_url).toBe(
        'https://join.example/',
      );
    }
  });

  it('EphemeralFrame: accepts welcome without public_url (back-compat)', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false },
    });
    expect(ok.success).toBe(true);
  });

  it('EphemeralFrame: rejects welcome with non-URL public_url', () => {
    const bad = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, public_url: 'not-a-url' },
    });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Planning-stream: stream_mode_changed event, planning_stream ephemeral frame,
// welcome stream seed.
// ---------------------------------------------------------------------------
describe('planning-stream wire contract', () => {
  it('parses stream_mode_changed ServerEvent for each mode', () => {
    for (const mode of ['off', 'coordinator', 'everyone'] as const) {
      const ok = ServerEvent.safeParse({
        seq: 3,
        ts: '2026-01-01T00:00:00Z',
        type: 'stream_mode_changed',
        payload: { mode },
      });
      expect(ok.success).toBe(true);
    }
  });

  it('rejects stream_mode_changed with an unknown mode', () => {
    const bad = ServerEvent.safeParse({
      seq: 3,
      ts: '2026-01-01T00:00:00Z',
      type: 'stream_mode_changed',
      payload: { mode: 'public' },
    });
    expect(bad.success).toBe(false);
  });

  it('parses a planning_stream EphemeralFrame with audience', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'planning_stream',
      payload: { text: 'considering option A', at: '2026-01-01T00:00:00Z' },
      audience: 'coordinator',
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a planning_stream frame missing audience', () => {
    const bad = EphemeralFrame.safeParse({
      type: 'planning_stream',
      payload: { text: 'x', at: '2026-01-01T00:00:00Z' },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a planning_stream frame with audience 'off'", () => {
    const bad = EphemeralFrame.safeParse({
      type: 'planning_stream',
      payload: { text: 'x', at: '2026-01-01T00:00:00Z' },
      audience: 'off',
    });
    expect(bad.success).toBe(false);
  });

  it('accepts welcome with an optional stream seed (both forms)', () => {
    const seed = { mode: 'everyone' as const, recent: [{ text: 'a', at: 'x' }] };
    const ev = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true, stream: seed },
    });
    const eph = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, you: youShape, is_coordinator: false, stream: seed },
    });
    expect(ev.success).toBe(true);
    expect(eph.success).toBe(true);
  });

  it('accepts welcome without a stream seed (back-compat)', () => {
    const ok = ServerEvent.safeParse({
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: { session: sessionShape, is_coordinator: true },
    });
    expect(ok.success).toBe(true);
  });
});
