import { z } from 'zod';

const ParticipantSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  joined_at: z.string(),
  status: z.enum(['pending', 'approved', 'kicked']),
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

/** Phase 7 (CHATAI-01): wire schema for a Clarification (ask + optional AI answer). */
const ClarificationSchema = z.object({
  id: z.string(),
  participant_id: z.string(),
  text: z.string(),
  answer: z.string().optional(),
  asked_at: z.string(),
  answered_at: z.string().optional(),
});

/** Phase 7 (CHAT-01): wire schema for a ChatEntry. */
const ChatEntrySchema = z.object({
  id: z.string(),
  actor_kind: z.enum(['participant', 'coordinator']),
  actor_id: z.string().optional(),
  display_name: z.string(),
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
  clarifications: z.array(ClarificationSchema),
  resolution: ResolutionSchema.nullable(),
});

const SessionViewSchema = z.object({
  session_id: z.string(),
  brief: z.string(),
  participants: z.array(ParticipantSchema),
  decisions: z.array(
    z.object({ question: z.string(), answer: z.string(), question_id: z.string() }),
  ),
  questions: z.array(QuestionSchema), // Phase 6 (BATCH-02): all open questions (required, not optional)
  current_question: QuestionSchema.nullable(), // retained back-compat = questions[0] ?? null
  locked: z.boolean(),
  session_status: z.enum(['waiting', 'question_open', 'choosing', 'done']),
  chat: z.array(ChatEntrySchema), // Phase 7 (CHAT-01): durable session-level chat
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
  /** Phase 7 (CHATAI-01): fires when a participant asks a clarification OR when the AI answers. */
  Envelope('clarification_added', z.object({
    question_id: z.string(),
    clarification: ClarificationSchema,
  })),
  /** Phase 7 (CHAT-01): fires when a participant or coordinator posts a chat message. */
  Envelope('chat_added', z.object({
    entry: ChatEntrySchema,
  })),
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
  Envelope(
    'participant_status_changed',
    z.object({
      participant_id: z.string(),
      status: z.enum(['pending', 'approved', 'kicked']),
    }),
  ),
  Envelope('room_locked', z.object({ locked: z.boolean() })),
  Envelope(
    'session_status_changed',
    z.object({ status: z.enum(['waiting', 'question_open', 'choosing', 'done']) }),
  ),
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
  z.object({
    type: z.literal('presence'),
    payload: z.object({
      actor_kind: z.enum(['participant', 'coordinator']),
      actor_id: z.string().optional(),
      activity: z.enum(['typing', 'picking', 'idle']),
    }),
  }),
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
  /** Phase 7 (CHATAI-01): approved participants ask a clarification on a specific question. */
  z.object({
    type: z.literal('post_clarification'),
    question_id: z.string(),
    text: z.string().min(1).max(4000),
  }),
  /** Phase 7 (CHAT-01): approved participants OR coordinator post to the session chat. */
  z.object({
    type: z.literal('post_chat'),
    text: z.string().min(1).max(4000),
  }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('typing'),
    question_id: z.string(),
    state: z.enum(['start', 'stop']),
  }),
  z.object({
    type: z.literal('picking'),
    ticket_id: z.string(),
    state: z.enum(['start', 'stop']),
  }),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;
