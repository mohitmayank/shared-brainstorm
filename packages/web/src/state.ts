import type { AnyFrame, ServerEvent, EphemeralFrame } from '@shared-brainstorm/shared';

// Derive session/participant types from the wire-level schemas to ensure consistency
// with what zod actually parses off the WebSocket (zod uses plain string, not branded types)
type WelcomePayload = Extract<EphemeralFrame, { type: 'welcome' }>['payload'];
type WireSession = WelcomePayload['session'];
type WireParticipant = WelcomePayload['you'];
type WireQuestion = NonNullable<WireSession['current_question']>;
type WireSuggestion = WireQuestion['suggestions'][number];
type WireComment = WireQuestion['comments'][number];

// Exported aliases for component use — avoids branded-type mismatches
export type { WireSession, WireParticipant, WireQuestion, WireSuggestion, WireComment };

export interface UiState {
  session: WireSession | null;
  me: WireParticipant | null;
  lastSeq: number;
  banner: string | null;
}

export const initialState: UiState = {
  session: null,
  me: null,
  lastSeq: -1,
  banner: null,
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

  if (type === 'welcome') {
    const p = payload<WelcomePayload>(evt);
    return {
      ...state,
      session: p.session,
      me: p.you,
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
    const p = payload<{ public_url: string }>(evt);
    return {
      ...state,
      lastSeq: seq,
      banner: `Tunnel URL changed: ${p.public_url}`,
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
      me: evt.payload.you,
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
