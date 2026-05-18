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
      payload: { session: sessionShape, you: youShape },
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

describe('EphemeralFrame', () => {
  it('parses welcome frame without seq', () => {
    const ok = EphemeralFrame.safeParse({
      type: 'welcome',
      payload: { session: sessionShape, you: youShape },
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
      payload: { session: sessionShape, you: youShape },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an EphemeralFrame (heartbeat without seq)', () => {
    const ok = AnyFrame.safeParse({ type: 'heartbeat' });
    expect(ok.success).toBe(true);
  });
});
