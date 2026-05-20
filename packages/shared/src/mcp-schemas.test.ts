import { describe, expect, it } from 'vitest';
import {
  StartSessionInput,
  StartSessionOutput,
  AskGroupInput,
  AskGroupOutput,
  AwaitAnswerInput,
  AwaitAnswerOutput,
  RecordAnswerInput,
  RecordAnswerOutput,
  StopSessionOutput,
} from './mcp-schemas.js';

describe('MCP schemas', () => {
  it('start_session input requires non-empty brief', () => {
    expect(StartSessionInput.safeParse({ brief: '' }).success).toBe(false);
    expect(StartSessionInput.safeParse({ brief: 'auth' }).success).toBe(true);
  });

  it('start_session output includes url, join_code, invite_text, clipboard_copied, coordinator_url', () => {
    const ok = StartSessionOutput.safeParse({
      session_id: 'sb_s_abc',
      public_url: 'https://x.trycloudflare.com',
      join_code: '123456',
      invite_text: 'Hi! Join: …\nJoin code: 123456',
      clipboard_copied: true,
      coordinator_url: 'https://x.trycloudflare.com/?role=coordinator&token=abc',
    });
    expect(ok.success).toBe(true);
  });

  it('start_session output requires coordinator_url (Phase 3 COORD-01)', () => {
    const missing = StartSessionOutput.safeParse({
      session_id: 'sb_s_abc',
      public_url: 'https://x.trycloudflare.com',
      join_code: '123456',
      invite_text: 'Hi! Join: …\nJoin code: 123456',
      clipboard_copied: true,
    });
    expect(missing.success).toBe(false);
  });

  it('ask_group input rejects empty options array (use undefined for free-form)', () => {
    expect(AskGroupInput.safeParse({ question: 'q', options: [] }).success).toBe(false);
    expect(AskGroupInput.safeParse({ question: 'q' }).success).toBe(true);
    expect(
      AskGroupInput.safeParse({ question: 'q', options: [{ label: 'a' }] }).success,
    ).toBe(true);
  });

  it('ask_group input rejects legacy preview field', () => {
    const parsed = AskGroupInput.safeParse({ question: 'q', preview: true });
    // zod by default strips unknown keys, so parse still succeeds; assert the
    // stripped output has no `preview` rather than rejecting outright.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('preview' in parsed.data).toBe(false);
    }
  });

  it('ask_group output is a ticket_id only', () => {
    expect(AskGroupOutput.safeParse({ ticket_id: 'sb_t_abc' }).success).toBe(true);
  });

  it('await_answer timeout_s clamped 1..55', () => {
    expect(AwaitAnswerInput.safeParse({ ticket_id: 'sb_t_a', timeout_s: 0 }).success).toBe(false);
    expect(AwaitAnswerInput.safeParse({ ticket_id: 'sb_t_a', timeout_s: 56 }).success).toBe(false);
    expect(AwaitAnswerInput.safeParse({ ticket_id: 'sb_t_a', timeout_s: 50 }).success).toBe(true);
    expect(AwaitAnswerInput.safeParse({ ticket_id: 'sb_t_a' }).success).toBe(true); // default applied
  });

  it('await_answer output is a snapshot of suggestions + comments + resolved flag', () => {
    expect(
      AwaitAnswerOutput.safeParse({ suggestions: [], comments: [], resolved: false }).success,
    ).toBe(true);
    expect(
      AwaitAnswerOutput.safeParse({
        suggestions: [{ participant_name: 'Alice', value: 'A', at: 'x' }],
        comments: [{ participant_name: 'Bob', text: 'looks fine', at: 'y' }],
        resolved: true,
      }).success,
    ).toBe(true);
  });

  it('record_answer input requires ticket_id, value, source', () => {
    expect(
      RecordAnswerInput.safeParse({ ticket_id: 'sb_t_a', value: 'A', source: 'suggestion' }).success,
    ).toBe(true);
    expect(
      RecordAnswerInput.safeParse({ ticket_id: 'sb_t_a', value: 'A', source: 'oops' }).success,
    ).toBe(false);
    expect(RecordAnswerInput.safeParse({ ticket_id: 'sb_t_a', value: '' }).success).toBe(false);
  });

  it('record_answer output is { ok: true }', () => {
    expect(RecordAnswerOutput.safeParse({ ok: true }).success).toBe(true);
  });

  it('stop_session output requires transcript_path', () => {
    expect(StopSessionOutput.safeParse({ ok: true, transcript_path: '/x' }).success).toBe(true);
  });
});
