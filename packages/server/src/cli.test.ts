import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

describe('CLI parseArgs', () => {
  it('defaults to mcp mode', () => {
    expect(parseArgs([]).mode).toBe('mcp');
  });

  it('--mcp explicit', () => {
    expect(parseArgs(['--mcp']).mode).toBe('mcp');
  });

  it('--install with host', () => {
    expect(parseArgs(['--install', 'claude-code'])).toEqual({
      mode: 'install',
      host: 'claude-code',
    });
  });

  it('--install with all valid hosts', () => {
    for (const host of ['claude-code', 'codex', 'opencode', 'gemini-cli']) {
      expect(parseArgs(['--install', host])).toEqual({ mode: 'install', host });
    }
  });

  it('--install without host throws', () => {
    expect(() => parseArgs(['--install'])).toThrow(/host/);
  });

  it('--install with unknown host throws', () => {
    expect(() => parseArgs(['--install', 'unknown'])).toThrow(/unknown host/);
  });

  it('--version', () => {
    expect(parseArgs(['--version']).mode).toBe('version');
  });

  it('-v shorthand', () => {
    expect(parseArgs(['-v']).mode).toBe('version');
  });

  it('--help', () => {
    expect(parseArgs(['--help']).mode).toBe('help');
  });

  it('-h shorthand', () => {
    expect(parseArgs(['-h']).mode).toBe('help');
  });

  it('rejects unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown/);
  });
});
