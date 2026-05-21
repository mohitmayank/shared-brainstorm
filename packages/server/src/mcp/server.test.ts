import { describe, it, expect } from 'vitest';
import { TOOLS } from './server.js';

describe('MCP tool definitions', () => {
  it('askGroup description contains the redaction best-effort warning (REL-10)', () => {
    const tool = TOOLS.find((t) => t.name === 'askGroup');
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/best-effort/i);
    expect(tool!.description).toContain('SHARED_BRAINSTORM_NO_REDACT');
  });

  it('askGroup description mentions redaction by name', () => {
    const tool = TOOLS.find((t) => t.name === 'askGroup');
    expect(tool!.description).toMatch(/redaction/i);
  });

  it('all six tools are listed (regression — includes answerClarification added in Plan 07-01)', () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      'answerClarification', // CHATAI-01: 6th tool added in Phase 7 Plan 01
      'askGroup',
      'awaitAnswer',
      'recordAnswer',
      'startSession',
      'stopSession',
    ]);
  });

  it('description length stays under the safe truncation threshold', () => {
    const tool = TOOLS.find((t) => t.name === 'askGroup');
    expect(tool!.description.length).toBeLessThan(500);
  });
});
