import { randomBytes } from 'node:crypto';

export type SessionId = string & { readonly __brand: 'SessionId' };
export type TicketId = string & { readonly __brand: 'TicketId' };
export type QuestionId = string & { readonly __brand: 'QuestionId' };
export type ParticipantId = string & { readonly __brand: 'ParticipantId' };

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function mint(prefix: string, len = 16): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return `${prefix}${out}`;
}

export type ClarificationId = string & { readonly __brand: 'ClarificationId' };
export type ChatEntryId = string & { readonly __brand: 'ChatEntryId' };

export const newSessionId = (): SessionId => mint('sb_s_') as SessionId;
export const newTicketId = (): TicketId => mint('sb_t_') as TicketId;
export const newQuestionId = (): QuestionId => mint('sb_q_') as QuestionId;
export const newParticipantId = (): ParticipantId => mint('sb_p_') as ParticipantId;
export const newClarificationId = (): ClarificationId => mint('sb_cl_') as ClarificationId;
export const newChatEntryId = (): ChatEntryId => mint('sb_ch_') as ChatEntryId;

/**
 * High-entropy coordinator token. Empty prefix + length 22 yields 22 chars of
 * the 64-char ALPHABET ≈ 132 bits of entropy (log2(64) × 22), exceeding the
 * 110-bit target in CONTEXT.md. Minted once per session in SessionManager.start().
 */
export const newCoordinatorToken = (): string => mint('', 22);

