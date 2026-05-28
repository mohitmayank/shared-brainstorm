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
  // Coordinator-as-planner (additive, backwards-compatible): when a coordinator
  // contributes their own answer, the suggestion carries server-derived identity
  // (author_kind:'coordinator', display_name:'Coordinator') with no roster entry.
  // Absent ⇒ a normal participant suggestion. Existing v2.x frames/transcripts
  // omit both fields and stay valid.
  author_kind: z.enum(['participant', 'coordinator']).optional(),
  display_name: z.string().optional(),
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
  // Phase 9 (SYNC-01): server-derived picker identity; absent for pre-Phase-9 events.
  picked_by: z.string().optional(),
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

// Terminal transport-failure payload (REL-03 / D-09). Single source of truth
// shared by the `transport_failed` event and the `welcome.advisories` snapshot
// so the two shapes can never drift.
export const TransportFailedPayloadSchema = z.object({
  code: z.enum(['cloudflared_permanent_failure', 'cloudflared_version_mismatch']),
  message: z.string(),
  restart_count: z.number().int().nonnegative(),
  at: z.string(),
});
export type TransportFailedPayload = z.infer<typeof TransportFailedPayloadSchema>;

// Currently-active, level-triggered advisories seeded into the `welcome` frame
// so a coordinator who opens the link FRESH (no `last_seq` → no ring-buffer
// replay) still sees an already-active notice. Only advisories with a clean
// persistent level-state are carried; `room_idle_nudge` (transient, re-arms on
// activity) is intentionally excluded. Each field is optional and omitted when
// inactive, so an absent/empty `advisories` is the quiet default.
export const AdvisoriesSchema = z.object({
  room_empty: z.boolean().optional(),
  transport_failed: TransportFailedPayloadSchema.optional(),
});
export type Advisories = z.infer<typeof AdvisoriesSchema>;

// Planning-stream: coordinator-controlled audience for agent-pushed planning
// narration. `off` is the default (feature dark); `coordinator` shows narration
// only in the coordinator view; `everyone` also shows it to participants.
export const StreamMode = z.enum(['off', 'coordinator', 'everyone']);
export type StreamMode = z.infer<typeof StreamMode>;

// One narration line. `text` is already redacted server-side before broadcast/seed.
export const StreamEntrySchema = z.object({
  text: z.string(),
  at: z.string(),
});
export type StreamEntry = z.infer<typeof StreamEntrySchema>;

// Per-audience planning-stream snapshot seeded into the `welcome` frame so a
// fresh (no-replay) open shows recent narration. `recent` is only populated for
// a viewer entitled to it (everyone, or coordinator while mode≠off) — the WS
// layer computes this per connection; the line buffer never enters the
// RingBuffer/`last_seq` replay path.
export const StreamSeedSchema = z.object({
  mode: StreamMode,
  recent: z.array(StreamEntrySchema),
});
export type StreamSeed = z.infer<typeof StreamSeedSchema>;

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
      // Phase 14 (SHARE-01): participant join URL sent in welcome; absent for pre-Phase-14 servers
      public_url: z.string().url().optional(),
      // Active level-triggered advisories seeded for fresh (no-replay) opens;
      // absent for pre-advisory servers and when nothing is active.
      advisories: AdvisoriesSchema.optional(),
      // Planning-stream seed for fresh opens, audience-filtered per connection;
      // omitted when the feature is off or the viewer is not entitled.
      stream: StreamSeedSchema.optional(),
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
  Envelope('transport_failed', TransportFailedPayloadSchema),
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
  // Phase 11 (ROOM-02): server fires after idleNudgeWindowMs with no participant activity
  Envelope(
    'room_idle_nudge',
    z.object({
      question_id: z.string(),
    }),
  ),
  // Phase 11 (ROOM-03): fires on 0→N and N→0 approved-connected participant transitions
  Envelope(
    'room_empty_changed',
    z.object({
      is_empty: z.boolean(),
    }),
  ),
  // Planning-stream: coordinator changed the narration audience. The mode itself
  // is non-sensitive, so this is a normal replayable ServerEvent (enters the
  // RingBuffer); only the narration lines (`planning_stream`) are audience-gated.
  Envelope('stream_mode_changed', z.object({ mode: StreamMode })),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export const EphemeralFrame = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    payload: z.object({
      session: SessionViewSchema,
      you: ParticipantSchema.optional(),
      is_coordinator: z.boolean(),
      // Phase 14 (SHARE-01): participant join URL sent in welcome; absent for pre-Phase-14 servers
      public_url: z.string().url().optional(),
      // Active level-triggered advisories seeded for fresh (no-replay) opens.
      advisories: AdvisoriesSchema.optional(),
      // Planning-stream seed, audience-filtered per connection.
      stream: StreamSeedSchema.optional(),
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
  // Planning-stream narration line. Ephemeral (no seq, never replayed). `audience`
  // is self-describing so the WS broadcast filter stays pure: a frame reaches a
  // sub iff audience==='everyone' OR the sub is the coordinator. `off` never
  // produces a frame (pushes are dropped server-side).
  z.object({
    type: z.literal('planning_stream'),
    payload: StreamEntrySchema,
    audience: z.enum(['coordinator', 'everyone']),
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
