import { z } from 'zod';

const ParticipantSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  joined_at: z.string(),
});

const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});

const SuggestionSchema = z.object({
  id: z.string(),
  participant_id: z.string(),
  value: z.string(),
  rationale: z.string().optional(),
  at: z.string(),
});

const CommentSchema = z.object({
  id: z.string(),
  participant_id: z.string(),
  text: z.string(),
  at: z.string(),
});

const ResolutionSchema = z.object({
  value: z.string(),
  source: z.enum(['suggestion', 'synthesis', 'override']),
  recorded_at: z.string(),
});

const QuestionSchema = z.object({
  id: z.string(),
  ticket_id: z.string(),
  asked_at: z.string(),
  text: z.string(),
  options: z.array(QuestionOptionSchema).optional(),
  recommendation: z.string().optional(),
  status: z.enum(['broadcast', 'resolved', 'cancelled', 'timeout']),
  suggestions: z.array(SuggestionSchema),
  comments: z.array(CommentSchema),
  resolution: ResolutionSchema.nullable(),
});

const SessionViewSchema = z.object({
  session_id: z.string(),
  brief: z.string(),
  participants: z.array(ParticipantSchema),
  decisions: z.array(
    z.object({ question: z.string(), answer: z.string(), question_id: z.string() }),
  ),
  current_question: QuestionSchema.nullable(),
});

const Envelope = <P extends z.ZodTypeAny>(type: string, payload: P) =>
  z.object({
    seq: z.number().int().nonnegative(),
    ts: z.string(),
    type: z.literal(type),
    payload,
  });

export const ServerEvent = z.discriminatedUnion('type', [
  Envelope(
    'welcome',
    z.object({
      session: SessionViewSchema,
      you: ParticipantSchema.optional(),
      is_coordinator: z.boolean(),
    }),
  ),
  Envelope('participant_joined', z.object({ participant: ParticipantSchema })),
  Envelope('participant_left', z.object({ participant_id: z.string() })),
  Envelope('question_broadcast', z.object({ question: QuestionSchema })),
  Envelope('suggestion_added', z.object({ question_id: z.string(), suggestion: SuggestionSchema })),
  Envelope('suggestion_updated', z.object({ question_id: z.string(), suggestion: SuggestionSchema })),
  Envelope('comment_added', z.object({ question_id: z.string(), comment: CommentSchema })),
  Envelope(
    'question_resolved',
    z.object({
      question_id: z.string(),
      resolution: ResolutionSchema,
    }),
  ),
  Envelope('question_cancelled', z.object({ question_id: z.string(), reason: z.string() })),
  Envelope('tunnel_url_changed', z.object({ public_url: z.string().url() })),
  Envelope(
    'transport_failed',
    z.object({
      code: z.enum(['cloudflared_permanent_failure', 'cloudflared_version_mismatch']),
      message: z.string(),
      restart_count: z.number().int().nonnegative(),
      at: z.string(),
    }),
  ),
  Envelope('session_ended', z.object({ reason: z.enum(['stop_session', 'signal', 'crash', 'ai_host_disconnected']) })),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const EphemeralFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    payload: z.object({
      session: SessionViewSchema,
      you: ParticipantSchema.optional(),
      is_coordinator: z.boolean(),
    }),
  }),
  z.object({ type: z.literal('heartbeat') }),
]);
export type EphemeralFrame = z.infer<typeof EphemeralFrame>;

export const AnyFrame = z.union([ServerEvent, EphemeralFrame]);
export type AnyFrame = z.infer<typeof AnyFrame>;

export const ClientCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), last_seq: z.number().int().nonnegative().optional() }),
  z.object({
    type: z.literal('post_suggestion'),
    question_id: z.string(),
    value: z.string().min(1).max(2000),
    rationale: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal('post_comment'),
    question_id: z.string(),
    text: z.string().min(1).max(4000),
  }),
  z.object({ type: z.literal('pong') }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;
