import { describe, expect, it } from 'vitest';
import { isTruthyEnv } from './env.js';

describe('isTruthyEnv', () => {
  it('returns false for undefined', () => {
    expect(isTruthyEnv(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTruthyEnv('')).toBe(false);
  });

  it('returns true for "1"', () => {
    expect(isTruthyEnv('1')).toBe(true);
  });

  it('returns true for "true"', () => {
    expect(isTruthyEnv('true')).toBe(true);
  });

  it('returns true for "TRUE" (case-insensitive)', () => {
    expect(isTruthyEnv('TRUE')).toBe(true);
  });

  it('returns true for " yes " (trimmed, lowercased)', () => {
    expect(isTruthyEnv(' yes ')).toBe(true);
  });

  it('returns true for "on"', () => {
    expect(isTruthyEnv('on')).toBe(true);
  });

  it('returns false for "0"', () => {
    expect(isTruthyEnv('0')).toBe(false);
  });

  it('returns false for "false"', () => {
    expect(isTruthyEnv('false')).toBe(false);
  });

  it('returns false for "anything-else"', () => {
    expect(isTruthyEnv('anything-else')).toBe(false);
  });
});
