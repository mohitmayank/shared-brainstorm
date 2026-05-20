import { describe, expect, it } from 'vitest';
import { ServerEvent, ClientCommand, EphemeralFrame, AnyFrame } from './events.js';

const sessionShape = {
  session_id: 'sb_s_a',
  brief: 'x',
  participants: [],
  decisions: [],
  current_question: null,
};
const youShape = { id: 'sb_p_x', display_name: 'Alice', joined_at: 'x' };

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
