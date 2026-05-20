import { describe, expect, it } from 'vitest';
import {
  newSessionId,
  newTicketId,
  newQuestionId,
  newParticipantId,
  newJoinCode,
  newCoordinatorToken,
} from './ids.js';

describe('id minting', () => {
  it('mints session ids with sb_s_ prefix and 12+ chars', () => {
    const id = newSessionId();
    expect(id).toMatch(/^sb_s_[A-Za-z0-9_-]{12,}$/);
  });

  it('mints ticket ids with sb_t_ prefix', () => {
    expect(newTicketId()).toMatch(/^sb_t_[A-Za-z0-9_-]{12,}$/);
  });

  it('mints question ids with sb_q_ prefix', () => {
    expect(newQuestionId()).toMatch(/^sb_q_[A-Za-z0-9_-]{12,}$/);
  });

  it('mints participant ids with sb_p_ prefix', () => {
    expect(newParticipantId()).toMatch(/^sb_p_[A-Za-z0-9_-]{12,}$/);
  });

  it('returns unique ids across 1000 calls', () => {
    const set = new Set(Array.from({ length: 1000 }, () => newSessionId()));
    expect(set.size).toBe(1000);
  });
});

describe('newJoinCode', () => {
  it('produces exactly 6 digits, zero-padded', () => {
    for (let i = 0; i < 50; i++) {
      const code = newJoinCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(code.length).toBe(6);
    }
  });

  it('produces varying codes across calls', () => {
    const codes = new Set(Array.from({ length: 100 }, () => newJoinCode()));
    expect(codes.size).toBeGreaterThan(50);
  });
});

describe('newCoordinatorToken', () => {
  it('mints a 22-character token', () => {
    expect(newCoordinatorToken()).toHaveLength(22);
  });

  it('only contains characters from the ALPHABET set', () => {
    for (let i = 0; i < 50; i++) {
      expect(newCoordinatorToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it('produces a different token on consecutive mints', () => {
    expect(newCoordinatorToken()).not.toBe(newCoordinatorToken());
  });
});
