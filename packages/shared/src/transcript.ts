import { z } from 'zod';

export const TranscriptV2 = z.object({
  schema_version: z.literal(2),
  session_id: z.string(),
  brief: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  ended_reason: z.enum(['stop_session', 'signal', 'crash', 'ai_host_disconnected']),
  participants: z.array(
    z.object({
      id: z.string(),
      display_name: z.string(),
      joined_at: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      ts: z.string(),
      type: z.string(),
      payload: z.unknown(),
    }),
  ),
  questions: z.array(
    z.object({
      id: z.string(),
      ticket_id: z.string(),
      asked_at: z.string(),
      text: z.string(),
      options: z
        .array(z.object({ label: z.string(), description: z.string().optional() }))
        .optional(),
      recommendation: z.string().optional(),
      status: z.enum(['resolved', 'cancelled', 'timeout']),
      suggestions: z.array(z.unknown()),
      comments: z.array(z.unknown()),
      clarifications: z.array(z.unknown()).optional(), // CHATAI-01: additive optional for back-compat
      resolution: z
        .object({
          value: z.string(),
          source: z.enum(['suggestion', 'synthesis', 'override']),
          recorded_at: z.string(),
        })
        .nullable(),
    }),
  ),
  // CHAT-01: session-level durable chat list. Optional for back-compat with
  // transcripts written before Phase 7 (schema_version stays 2 — additive).
  chat: z.array(z.unknown()).optional(),
});
export type TranscriptV2 = z.infer<typeof TranscriptV2>;

// Keep a non-versioned alias so callers don't have to know the current version.
export const Transcript = TranscriptV2;
export type Transcript = TranscriptV2;
