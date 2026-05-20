import { z } from 'zod';

export const StartSessionInput = z.object({
  brief: z.string().min(1).max(500),
});
export type StartSessionInput = z.infer<typeof StartSessionInput>;

export const StartSessionOutput = z.object({
  session_id: z.string(),
  public_url: z.string().url(),
  invite_text: z.string(),
  clipboard_copied: z.boolean(),
  // Phase 3 (COORD-01): one-time URL the human initiator opens to drive the
  // session from a coordinator browser view. REQUIRED (additive, wire-back-compat:
  // older clients ignore unknown fields). MUST NOT be embedded in invite_text.
  coordinator_url: z.string().url(),
});
export type StartSessionOutput = z.infer<typeof StartSessionOutput>;

export const AskGroupOption = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

export const AskGroupInput = z.object({
  question: z.string().min(1),
  options: z.array(AskGroupOption).min(1).optional(),
  recommendation: z.string().optional(),
});
export type AskGroupInput = z.infer<typeof AskGroupInput>;

export const AskGroupOutput = z.object({
  ticket_id: z.string(),
});
export type AskGroupOutput = z.infer<typeof AskGroupOutput>;

export const AwaitAnswerInput = z.object({
  ticket_id: z.string(),
  timeout_s: z.number().int().min(1).max(55).default(50),
});
export type AwaitAnswerInput = z.infer<typeof AwaitAnswerInput>;

export const SuggestionEntry = z.object({
  participant_name: z.string(),
  value: z.string(),
  rationale: z.string().optional(),
  at: z.string(),
});
export type SuggestionEntry = z.infer<typeof SuggestionEntry>;

export const CommentEntry = z.object({
  participant_name: z.string(),
  text: z.string(),
  at: z.string(),
});
export type CommentEntry = z.infer<typeof CommentEntry>;

export const AwaitAnswerOutput = z.object({
  suggestions: z.array(SuggestionEntry),
  comments: z.array(CommentEntry),
  resolved: z.boolean(),
});
export type AwaitAnswerOutput = z.infer<typeof AwaitAnswerOutput>;

export const RecordAnswerInput = z.object({
  ticket_id: z.string(),
  value: z.string().min(1).max(2000),
  source: z.enum(['suggestion', 'synthesis', 'override']),
});
export type RecordAnswerInput = z.infer<typeof RecordAnswerInput>;

export const RecordAnswerOutput = z.object({
  ok: z.literal(true),
});
export type RecordAnswerOutput = z.infer<typeof RecordAnswerOutput>;

export const StopSessionOutput = z.object({
  ok: z.literal(true),
  transcript_path: z.string(),
});
export type StopSessionOutput = z.infer<typeof StopSessionOutput>;
