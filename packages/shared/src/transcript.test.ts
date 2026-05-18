import { describe, expect, it } from 'vitest';
import { TranscriptV2 } from './transcript.js';

describe('TranscriptV2', () => {
  it('round-trips a minimal transcript', () => {
    const t = {
      schema_version: 2 as const,
      session_id: 'sb_s_x',
      brief: 'x',
      started_at: 'x',
      ended_at: 'y',
      ended_reason: 'stop_session' as const,
      participants: [],
      events: [],
      questions: [],
    };
    const parsed = TranscriptV2.parse(t);
    expect(parsed.schema_version).toBe(2);
  });

  it('rejects schema_version != 2', () => {
    expect(
      TranscriptV2.safeParse({
        schema_version: 1,
        session_id: 'x',
        brief: 'x',
        started_at: 'x',
        ended_at: 'x',
        ended_reason: 'stop_session',
        participants: [],
        events: [],
        questions: [],
      }).success,
    ).toBe(false);
  });

  it('accepts a resolved question with source field', () => {
    const parsed = TranscriptV2.parse({
      schema_version: 2,
      session_id: 'sb_s_x',
      brief: 'x',
      started_at: 'x',
      ended_at: 'y',
      ended_reason: 'stop_session',
      participants: [{ id: 'sb_p_a', display_name: 'Alice', joined_at: 'x' }],
      events: [],
      questions: [
        {
          id: 'sb_q_a',
          ticket_id: 'sb_t_a',
          asked_at: 'x',
          text: 'q?',
          status: 'resolved',
          suggestions: [],
          comments: [],
          resolution: { value: 'A', source: 'override', recorded_at: 'y' },
        },
      ],
    });
    expect(parsed.questions[0]?.resolution?.source).toBe('override');
  });
});
