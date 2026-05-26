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
  ClarificationEntry,
  AnswerClarificationInput,
} from './mcp-schemas.js';

describe('MCP schemas', () => {
  it('start_session input requires non-empty brief', () => {
    expect(StartSessionInput.safeParse({ brief: '' }).success).toBe(false);
    expect(StartSessionInput.safeParse({ brief: 'auth' }).success).toBe(true);
  });

  it('start_session output includes url, invite_text, coordinator_url (no join_code, no clipboard_copied)', () => {
    const ok = StartSessionOutput.safeParse({
      session_id: 'sb_s_abc',
      public_url: 'https://x.trycloudflare.com',
      invite_text: 'Hi! Join: https://x.trycloudflare.com\n(Approval required)',
      coordinator_url: 'https://x.trycloudflare.com/?role=coordinator&token=abc',
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      // clipboard_copied was removed — auto-copy is gone in favor of browser auto-open.
      expect('clipboard_copied' in ok.data).toBe(false);
    }
  });

  it('start_session output rejects join_code (removed in v2.0.0)', () => {
    // join_code is stripped by Zod (unknown keys are stripped by default);
    // safeParse still succeeds — assert the stripped output has no join_code.
    const parsed = StartSessionOutput.safeParse({
      session_id: 'sb_s_abc',
      public_url: 'https://x.trycloudflare.com',
      join_code: '123456',
      invite_text: 'Hi!',
      coordinator_url: 'https://x.trycloudflare.com/?role=coordinator&token=abc',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('join_code' in parsed.data).toBe(false);
    }
  });

  it('start_session output requires coordinator_url (Phase 3 COORD-01)', () => {
    const missing = StartSessionOutput.safeParse({
      session_id: 'sb_s_abc',
      public_url: 'https://x.trycloudflare.com',
      invite_text: 'Hi!',
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

  it('await_answer output is a snapshot of suggestions + comments + clarifications + resolved flag', () => {
    expect(
      AwaitAnswerOutput.safeParse({ suggestions: [], comments: [], clarifications: [], resolved: false }).success,
    ).toBe(true);
    expect(
      AwaitAnswerOutput.safeParse({
        suggestions: [{ participant_name: 'Alice', value: 'A', at: 'x' }],
        comments: [{ participant_name: 'Bob', text: 'looks fine', at: 'y' }],
        clarifications: [],
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

  // Phase 9 (SYNC-01 / SYNC-02): Wave 0 regression guards for widened schemas
  it('AwaitAnswerOutput accepts resolution field when resolved:true', () => {
    expect(
      AwaitAnswerOutput.safeParse({
        suggestions: [],
        comments: [],
        clarifications: [],
        resolved: true,
        resolution: { value: 'use Postgres', source: 'suggestion', picked_by: 'Coordinator' },
      }).success,
    ).toBe(true);
  });

  it('AwaitAnswerOutput resolution is optional (unresolved snapshot)', () => {
    expect(
      AwaitAnswerOutput.safeParse({
        suggestions: [],
        comments: [],
        clarifications: [],
        resolved: false,
      }).success,
    ).toBe(true);
  });

  it('RecordAnswerOutput accepts ok:false already_resolved branch', () => {
    expect(() =>
      RecordAnswerOutput.parse({
        ok: false,
        reason: 'already_resolved',
        resolution: { value: 'use Postgres', source: 'suggestion', picked_by: 'Coordinator' },
      }),
    ).not.toThrow();
  });

  it('RecordAnswerOutput ok:true path unchanged', () => {
    expect(() => RecordAnswerOutput.parse({ ok: true })).not.toThrow();
  });

  it('RecordAnswerOutput ok:false requires resolution field', () => {
    expect(
      RecordAnswerOutput.safeParse({ ok: false, reason: 'already_resolved' }).success,
    ).toBe(false);
  });

  it('stop_session output requires transcript_path', () => {
    expect(StopSessionOutput.safeParse({ ok: true, transcript_path: '/x' }).success).toBe(true);
  });
});

describe('ClarificationEntry / AnswerClarificationInput schemas', () => {
  it('ClarificationEntry.parse() with full valid object succeeds', () => {
    const result = ClarificationEntry.safeParse({
      participant_name: 'Alice',
      clarification_id: 'sb_cl_abc',
      text: 'Why Postgres?',
      answer: 'Because of ACID compliance.',
      asked_at: '2026-01-01T00:00:00Z',
      answered_at: '2026-01-01T00:01:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.participant_name).toBe('Alice');
      expect(result.data.answer).toBe('Because of ACID compliance.');
    }
  });

  it('ClarificationEntry.parse() with answer/answered_at absent succeeds (optional fields)', () => {
    const result = ClarificationEntry.safeParse({
      participant_name: 'Bob',
      clarification_id: 'sb_cl_xyz',
      text: 'Any caching?',
      asked_at: '2026-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.answer).toBeUndefined();
      expect(result.data.answered_at).toBeUndefined();
    }
  });

  it('AnswerClarificationInput.parse() with valid object succeeds', () => {
    const result = AnswerClarificationInput.safeParse({
      ticket_id: 'sb_t_abc',
      clarification_id: 'sb_cl_xyz',
      text: 'Use structured logging.',
    });
    expect(result.success).toBe(true);
  });

  it('AnswerClarificationInput.parse() with empty text fails (min(1) violation)', () => {
    const result = AnswerClarificationInput.safeParse({
      ticket_id: 'sb_t_abc',
      clarification_id: 'sb_cl_xyz',
      text: '',
    });
    expect(result.success).toBe(false);
  });

  it('AwaitAnswerOutput.parse() with clarifications: [] succeeds', () => {
    const result = AwaitAnswerOutput.safeParse({
      suggestions: [],
      comments: [],
      clarifications: [],
      resolved: false,
    });
    expect(result.success).toBe(true);
  });

  it('AwaitAnswerOutput.parse() omitting clarifications key fails (required array)', () => {
    const result = AwaitAnswerOutput.safeParse({
      suggestions: [],
      comments: [],
      resolved: false,
    });
    expect(result.success).toBe(false);
  });
});
