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

// Phase 6 (BATCH-01): additive batch schemas. AskGroupInput and AskGroupOutput
// are byte-identical to today for the single-question path.

/** Alias for the existing AskGroupInput — single-question path back-compat. */
export const AskGroupSingleInput = AskGroupInput;
export type AskGroupSingleInput = AskGroupInput;

/** Maximum number of questions allowed in a single batch call (T-06-01 DoS cap). */
export const MAX_BATCH_QUESTIONS = 10;

/** One item within a batch askGroup call — same fields as AskGroupInput. */
export const AskGroupBatchItem = z.object({
  question: z.string().min(1),
  options: z.array(AskGroupOption).min(1).optional(),
  recommendation: z.string().optional(),
});
export type AskGroupBatchItem = z.infer<typeof AskGroupBatchItem>;

/** Batch input schema — min(1) allows single-item batch; max(MAX_BATCH_QUESTIONS) enforces DoS cap. */
export const AskGroupBatchInput = z.object({
  questions: z.array(AskGroupBatchItem).min(1).max(MAX_BATCH_QUESTIONS),
});
export type AskGroupBatchInput = z.infer<typeof AskGroupBatchInput>;

/**
 * Union of batch and single inputs. Batch MUST be listed first so
 * {questions:[...]} hits AskGroupBatchInput before AskGroupSingleInput
 * (which would otherwise succeed via field absence — Zod union picks first match).
 */
export const AskGroupUnionInput = z.union([AskGroupBatchInput, AskGroupSingleInput]);
export type AskGroupUnionInput = z.infer<typeof AskGroupUnionInput>;

/** One element of the batch output tickets array. */
export const AskGroupBatchOutputItem = z.object({
  question_id: z.string(),
  ticket_id: z.string(),
});
export type AskGroupBatchOutputItem = z.infer<typeof AskGroupBatchOutputItem>;

/** Batch output — mirrors the tickets array in submission order. */
export const AskGroupBatchOutput = z.object({
  tickets: z.array(AskGroupBatchOutputItem),
});
export type AskGroupBatchOutput = z.infer<typeof AskGroupBatchOutput>;

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

/** Phase 7 (CHATAI-01): MCP wire shape for a single clarification (ask + optional AI answer). */
export const ClarificationEntry = z.object({
  participant_name: z.string(),
  clarification_id: z.string(),
  text: z.string(),
  answer: z.string().optional(),
  asked_at: z.string(),
  answered_at: z.string().optional(),
});
export type ClarificationEntry = z.infer<typeof ClarificationEntry>;

/** Phase 7 (CHATAI-01): input for the answerClarification MCP tool. */
export const AnswerClarificationInput = z.object({
  ticket_id: z.string(),
  clarification_id: z.string(),
  text: z.string().min(1).max(4000),
});
export type AnswerClarificationInput = z.infer<typeof AnswerClarificationInput>;

export const AnswerClarificationOutput = z.object({ ok: z.literal(true) });
export type AnswerClarificationOutput = z.infer<typeof AnswerClarificationOutput>;

// Phase 9 (SYNC-01): resolution is present only when resolved:true — optional for backwards-compat.
export const AwaitAnswerResolution = z.object({
  value: z.string(),
  source: z.enum(['suggestion', 'synthesis', 'override']),
  picked_by: z.string(),
});
export type AwaitAnswerResolution = z.infer<typeof AwaitAnswerResolution>;

export const AwaitAnswerOutput = z.object({
  suggestions: z.array(SuggestionEntry),
  comments: z.array(CommentEntry),
  clarifications: z.array(ClarificationEntry), // Phase 7 (CHATAI-01): additive
  resolved: z.boolean(),
  resolution: AwaitAnswerResolution.optional(), // Phase 9 (SYNC-01): only present when resolved:true
});
export type AwaitAnswerOutput = z.infer<typeof AwaitAnswerOutput>;

// Phase 9 (WR-02): shared wire contract for the 409 "already_resolved" body
// returned by POST /api/coordinator/answer (D-08). Schema-first per the
// codebase convention ("all wire schemas are Zod") — both the server (which
// builds the body) and the web client (which narrows the caught body) parse
// against this instead of using raw objects / `as` casts, so any shape drift
// surfaces deterministically. `resolution` is optional: an older server, or a
// teardown race where the terminal resolution is no longer readable, omits it.
export const CoordinatorAnswerErrorBody = z.object({
  error: z.literal('already_resolved'),
  resolution: AwaitAnswerResolution.optional(),
});
export type CoordinatorAnswerErrorBody = z.infer<typeof CoordinatorAnswerErrorBody>;

export const RecordAnswerInput = z.object({
  ticket_id: z.string(),
  value: z.string().min(1).max(2000),
  source: z.enum(['suggestion', 'synthesis', 'override']),
});
export type RecordAnswerInput = z.infer<typeof RecordAnswerInput>;

// Phase 9 (SYNC-02): widened from z.literal(true) to discriminated union — additive backwards-compat.
// ok:true path is unchanged; ok:false path surfaces when the agent loses a race to a web pick.
export const RecordAnswerOutput = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.literal('already_resolved'),
    resolution: AwaitAnswerResolution, // reuse D-01 shape for consistency
  }),
]);
export type RecordAnswerOutput = z.infer<typeof RecordAnswerOutput>;

export const StopSessionOutput = z.object({
  ok: z.literal(true),
  transcript_path: z.string(),
});
export type StopSessionOutput = z.infer<typeof StopSessionOutput>;
