import type { AnyFrame, ServerEvent, EphemeralFrame } from '@shared-brainstorm/shared';

// Derive session/participant types from the wire-level schemas to ensure consistency
// with what zod actually parses off the WebSocket (zod uses plain string, not branded types)
type WelcomePayload = Extract<EphemeralFrame, { type: 'welcome' }>['payload'];
type WireSession = WelcomePayload['session'];
// `welcome.you` is now optional (coordinator connections omit it). Keep the
// exported `WireParticipant` as the non-null participant shape so components
// that already consume it are unaffected — `UiState.me` carries the nullability.
type WireParticipant = NonNullable<WelcomePayload['you']>;
type WireQuestion = NonNullable<WireSession['current_question']>;
type WireSuggestion = WireQuestion['suggestions'][number];
type WireComment = WireQuestion['comments'][number];

// Exported aliases for component use — avoids branded-type mismatches
export type { WireSession, WireParticipant, WireQuestion, WireSuggestion, WireComment };

/**
 * Snapshot of a terminal transport failure (REL-03 / D-09). Populated when the
 * server broadcasts a `transport_failed` event; mirrors the event's payload
 * shape so the renderer can show the message + code directly. Distinct from
 * the dismissable `banner` field — `transportFailed` is non-dismissable per
 * D-09 ("ask the session host to restart").
 */
export interface TransportFailedState {
  code: 'cloudflared_permanent_failure' | 'cloudflared_version_mismatch';
  message: string;
  restart_count: number;
  at: string;
}

export interface UiState {
  session: WireSession | null;
  me: WireParticipant | null;
  lastSeq: number;
  banner: string | null;
  /**
   * Set when the server emits a `transport_failed` event (REL-03). Survives
   * `welcome` (re-resume) replay because the event is ring-buffered. Cleared
   * only on `initialState` — the renderer (02-07) decides UX.
   */
  transportFailed: TransportFailedState | null;
  /**
   * Tracks the most-recent tunnel URL announced via `tunnel_url_changed`
   * (REL-05 / D-20). Reducer stays pure server-event-driven: it records the
   * latest URL only. Dismiss-ack state lives in `App.tsx` `useState` so
   * Pitfall 3 (banner reappears on a new URL even after dismiss) is enforced
   * by comparing the dismissed URL against `tunnelBanner.url` at render time.
   */
  tunnelBanner: { url: string } | null;
  /**
   * Server-derived (concern #6): set from every `welcome` frame's
   * `is_coordinator` flag, which the server fixes at WS upgrade time from the
   * `sb_c` cookie. The UI never sets this itself — it is purely a mirror of the
   * server's authority and is re-applied on reconnect (no stale carry-over).
   */
  isCoordinator: boolean;
}

export const initialState: UiState = {
  session: null,
  me: null,
  lastSeq: -1,
  banner: null,
  transportFailed: null,
  tunnelBanner: null,
  isCoordinator: false,
};

function isServerEvent(frame: AnyFrame): frame is ServerEvent {
  return 'seq' in frame;
}

function isEphemeralFrame(frame: AnyFrame): frame is EphemeralFrame {
  return !('seq' in frame);
}

function withQuestion(
  session: WireSession,
  updater: (q: WireQuestion) => WireQuestion,
): WireSession {
  if (!session.current_question) return session;
  return { ...session, current_question: updater(session.current_question) };
}

// TypeScript cannot narrow `evt.payload` via `evt.type` check when using zod's
// discriminatedUnion with a generic `Envelope` helper — the payload field appears
// as a union of all shapes. We use `unknown` casts to extract the payload safely
// after we have already narrowed on `evt.type`.
function payload<T>(evt: ServerEvent): T {
  return (evt as unknown as { payload: T }).payload;
}

function applyServerEvent(state: UiState, evt: ServerEvent): UiState {
  const seq = evt.seq;
  const type = evt.type;

  // WR-07: global monotonic seq guard. Replay can deliver the same buffered
  // event more than once — a reconnecting client is seeded from the
  // `?last_seq=` query param at WS open AND replays again from the `hello`
  // frame. Per-entity dedup (id checks) covers idempotent events, but
  // append-style events like `question_resolved` push a duplicate decision on
  // the second delivery. Dropping any event whose seq is not strictly newer
  // than the last applied seq makes replay idempotent regardless of how many
  // paths deliver it.
  //
  // `welcome` is exempt: it is the authoritative full-state resync sent on
  // every (re)connect and may carry a seq <= the client's current watermark
  // (a reconnecting client already past the snapshot seq). It must always
  // re-prime state — and it overwrites `lastSeq` to the snapshot's seq so the
  // replayed delta that follows is judged against the correct watermark.
  if (type !== 'welcome' && seq <= state.lastSeq) return state;

  if (type === 'welcome') {
    const p = payload<WelcomePayload>(evt);
    return {
      ...state,
      session: p.session,
      me: p.you ?? null,
      isCoordinator: p.is_coordinator,
      lastSeq: seq,
      banner: null,
    };
  }

  if (type === 'participant_joined') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ participant: WireParticipant }>(evt);
    const already = state.session.participants.find((x) => x.id === p.participant.id);
    if (already) return { ...state, lastSeq: seq };
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        participants: [...state.session.participants, p.participant],
      },
    };
  }

  if (type === 'participant_left') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ participant_id: string }>(evt);
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        participants: state.session.participants.filter((x) => x.id !== p.participant_id),
      },
    };
  }

  if (type === 'question_broadcast') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question: WireQuestion }>(evt);
    return {
      ...state,
      lastSeq: seq,
      session: { ...state.session, current_question: p.question },
    };
  }

  if (type === 'suggestion_added') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question_id: string; suggestion: WireSuggestion }>(evt);
    return {
      ...state,
      lastSeq: seq,
      session: withQuestion(state.session, (q) => {
        if (q.id !== p.question_id) return q;
        const already = q.suggestions.find((s) => s.id === p.suggestion.id);
        if (already) return q;
        return { ...q, suggestions: [...q.suggestions, p.suggestion] };
      }),
    };
  }

  if (type === 'suggestion_updated') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question_id: string; suggestion: WireSuggestion }>(evt);
    return {
      ...state,
      lastSeq: seq,
      session: withQuestion(state.session, (q) => {
        if (q.id !== p.question_id) return q;
        return {
          ...q,
          suggestions: q.suggestions.map((s) =>
            s.id === p.suggestion.id ? p.suggestion : s,
          ),
        };
      }),
    };
  }

  if (type === 'comment_added') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question_id: string; comment: WireComment }>(evt);
    return {
      ...state,
      lastSeq: seq,
      session: withQuestion(state.session, (q) => {
        if (q.id !== p.question_id) return q;
        const already = q.comments.find((c) => c.id === p.comment.id);
        if (already) return q;
        return { ...q, comments: [...q.comments, p.comment] };
      }),
    };
  }

  if (type === 'question_resolved') {
    if (!state.session) return { ...state, lastSeq: seq };
    type Resolution = {
      value: string;
      source: 'suggestion' | 'synthesis' | 'override';
      recorded_at: string;
    };
    const p = payload<{ question_id: string; resolution: Resolution }>(evt);
    const resolved = state.session.current_question;
    const newDecision =
      resolved !== null
        ? {
            question_id: resolved.id,
            question: resolved.text,
            answer: p.resolution.value,
          }
        : null;
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        current_question:
          resolved !== null
            ? { ...resolved, status: 'resolved' as const, resolution: p.resolution }
            : null,
        decisions:
          newDecision !== null
            ? [...state.session.decisions, newDecision]
            : state.session.decisions,
      },
    };
  }

  if (type === 'question_cancelled') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question_id: string; reason: string }>(evt);
    const current = state.session.current_question;
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        current_question:
          current?.id === p.question_id
            ? { ...current, status: 'cancelled' as const }
            : current,
      },
    };
  }

  if (type === 'tunnel_url_changed') {
    // REL-05 / D-20: drive the dedicated TunnelBanner via `tunnelBanner`,
    // not the generic `banner` field. The dismiss-ack lives in `App.tsx`
    // `useState` (Pitfall 3); the reducer only records the latest URL.
    const p = payload<{ public_url: string }>(evt);
    return {
      ...state,
      lastSeq: seq,
      tunnelBanner: { url: p.public_url },
    };
  }

  if (type === 'transport_failed') {
    const p = payload<{
      code: 'cloudflared_permanent_failure' | 'cloudflared_version_mismatch';
      message: string;
      restart_count: number;
      at: string;
    }>(evt);
    return {
      ...state,
      lastSeq: seq,
      transportFailed: {
        code: p.code,
        message: p.message,
        restart_count: p.restart_count,
        at: p.at,
      },
    };
  }

  if (type === 'session_ended') {
    const p = payload<{ reason: string }>(evt);
    return {
      ...state,
      lastSeq: seq,
      banner: `Session ended (${p.reason})`,
    };
  }

  return { ...state, lastSeq: seq };
}

function applyEphemeralFrame(state: UiState, evt: EphemeralFrame): UiState {
  if (evt.type === 'welcome') {
    return {
      ...state,
      session: evt.payload.session,
      me: evt.payload.you ?? null,
      isCoordinator: evt.payload.is_coordinator,
      banner: null,
      // NOTE: do NOT update lastSeq — ephemeral welcome has no seq
    };
  }
  // heartbeat — handled in ws.ts before reaching reducer
  return state;
}

export function reduce(state: UiState, evt: AnyFrame): UiState {
  if (isServerEvent(evt)) return applyServerEvent(state, evt);
  if (isEphemeralFrame(evt)) return applyEphemeralFrame(state, evt);
  return state;
}
