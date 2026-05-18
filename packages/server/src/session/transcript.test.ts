import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTranscript } from './transcript.js';
import { TranscriptV2 } from '@shared-brainstorm/shared';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sbtrans-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeTranscript', () => {
  it('writes a parseable v1 transcript with safe filename slug', () => {
    const t: TranscriptV2 = {
      schema_version: 2,
      session_id: 'sb_s_a',
      brief: 'Auth flow / mobile + desktop!',
      started_at: '2026-04-29T12:00:00Z',
      ended_at: '2026-04-29T12:30:00Z',
      ended_reason: 'stop_session',
      participants: [],
      events: [],
      questions: [],
    };
    const p = writeTranscript(t, dir);
    expect(p).toMatch(/2026-04-29-auth-flow-mobile-desktop\.json$/);
    const parsed = TranscriptV2.parse(JSON.parse(readFileSync(p, 'utf8')));
    expect(parsed.brief).toBe('Auth flow / mobile + desktop!');
  });

  it('appends -2, -3 on filename collision', () => {
    const t: TranscriptV2 = {
      schema_version: 2,
      session_id: 'sb_s_b',
      brief: 'X',
      started_at: '2026-04-29T12:00:00Z',
      ended_at: '2026-04-29T12:30:00Z',
      ended_reason: 'stop_session',
      participants: [],
      events: [],
      questions: [],
    };
    const p1 = writeTranscript(t, dir);
    const p2 = writeTranscript(t, dir);
    expect(p1).not.toBe(p2);
    expect(p2).toMatch(/-2\.json$/);
  });

  it('creates the dir if missing', () => {
    const sub = join(dir, 'nested', 'a', 'b');
    const t: TranscriptV2 = {
      schema_version: 2,
      session_id: 'sb_s_c',
      brief: 'hello',
      started_at: '2026-04-29T12:00:00Z',
      ended_at: '2026-04-29T12:30:00Z',
      ended_reason: 'stop_session',
      participants: [],
      events: [],
      questions: [],
    };
    const p = writeTranscript(t, sub);
    expect(p.startsWith(sub)).toBe(true);
  });
});
