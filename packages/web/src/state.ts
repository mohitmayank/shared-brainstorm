import type { AnyFrame, ServerEvent, EphemeralFrame } from '@shared-brainstorm/shared';

// Derive session/participant types from the wire-level schemas to ensure consistency
// with what zod actually parses off the WebSocket (zod uses plain string, not branded types)
type WelcomePayload = Extract<EphemeralFrame, { type: 'welcome' }>['payload'];
type WireSession = WelcomePayload['session'];
// `welcome.you` is now optional (coordinator connections omit it). Keep the
// exported `WireParticipant` as the non-null participant shape so components
// that already consume it are unaffected — `UiState.me` carries the nullability.
type WireParticipant = NonNullable<WelcomePayload['you']>;
type WireQuestion = WireSession['questions'][number];
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
  /**
   * The current participant's approval status, derived from `welcome.you.status`
   * and `participant_status_changed` events. null before the first welcome arrives.
   * Never reset on WS close — a kicked participant must still see the removed
   * screen on subsequent reconnect attempts.
   */
  myStatus: 'pending' | 'approved' | 'kicked' | null;
  /**
   * Reflects the server's `room_locked` event. Drives the locked screen for new
   * visitors who get HTTP 423 on POST /api/join (App.tsx sets joinLocked state).
   * Already-connected browsers see the coordinator's lock toggle flip via this.
   */
  roomLocked: boolean;
  /**
   * Server-driven session lifecycle status. Seeded from welcome.session.session_status
   * and updated by session_status_changed ServerEvents. 'waiting' on initialState.
   */
  sessionStatus: 'waiting' | 'question_open' | 'choosing' | 'done';
  /**
   * Transient per-actor presence map. Keys are participant_id or '__coordinator'.
   * Entries are populated by ephemeral presence frames and expired by App.tsx timers.
   * Never persisted; never replayed on reconnect.
   */
  presence: Record<string, { activity: string; expiresAt: number }>;
}

export const initialState: UiState = {
  session: null,
  me: null,
  lastSeq: -1,
  banner: null,
  transportFailed: null,
  tunnelBanner: null,
  isCoordinator: false,
  myStatus: null,
  roomLocked: false,
  sessionStatus: 'waiting',
  presence: {},
};

function isServerEvent(frame: AnyFrame): frame is ServerEvent {
  return 'seq' in frame;
}

function isEphemeralFrame(frame: AnyFrame): frame is EphemeralFrame {
  return !('seq' in frame);
}

function withOpenQuestion(
  session: WireSession,
  questionId: string,
  updater: (q: WireQuestion) => WireQuestion,
): WireSession {
  const idx = session.questions.findIndex((q) => q.id === questionId);
  if (idx < 0) return session;
  const newQuestions = session.questions.map((q, i) => (i === idx ? updater(q) : q));
  return {
    ...session,
    questions: newQuestions,
    current_question: newQuestions[0] ?? null, // keep derived back-compat field in sync
  };
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
  // `welcome` is exempt from the seq guard so it can always re-prime full
  // state on (re)connect. In production `welcome` never crosses the wire with
  // a `seq`: the server sends it as an ephemeral frame (ws.ts) routed through
  // `applyEphemeralFrame`, which does not touch `lastSeq`. The seq-carrying
  // `welcome` form only exists in test fixtures (the `ServerEvent` schema
  // permits it). The exemption here is therefore defensive against that
  // schema-permitted shape, and the watermark is advanced monotonically below
  // so a low-seq welcome can never weaken the guard.
  if (type !== 'welcome' && seq <= state.lastSeq) return state;

  if (type === 'welcome') {
    const p = payload<WelcomePayload>(evt);
    return {
      ...state,
      session: p.session,
      me: p.you ?? null,
      isCoordinator: p.is_coordinator,
      // Phase 4: set myStatus from welcome.you.status; do NOT clear if you is absent
      ...(p.you !== undefined ? { myStatus: p.you.status } : {}),
      // WR-01: project session.locked into roomLocked so a reloaded coordinator/
      // participant sees the correct lock state immediately without waiting for a
      // room_locked event that may have aged out of the ring buffer.
      roomLocked: p.session.locked,
      // WR-03 fix: project session_status in BOTH welcome paths (durable + ephemeral)
      // so a reconnect that replays a seq-carrying welcome (schema-permitted shape)
      // also restores the correct status. Mirrors the ephemeral handler at line ~404.
      sessionStatus: p.session.session_status,
      // Re-prime state but never move the watermark backward; Math.max keeps
      // the WR-07 guard intact against any subsequently-replayed already-
      // applied event (a backward `lastSeq` would re-open duplicate replay for
      // append-style events like `question_resolved`).
      lastSeq: Math.max(state.lastSeq, seq),
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
    const existingIndex = state.session.questions.findIndex((q) => q.id === p.question.id);
    const newQuestions =
      existingIndex >= 0
        ? state.session.questions.map((q, i) => (i === existingIndex ? p.question : q))
        : [...state.session.questions, p.question];
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        questions: newQuestions,
        current_question: newQuestions[0] ?? null, // derived back-compat
      },
    };
  }

  if (type === 'suggestion_added') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question_id: string; suggestion: WireSuggestion }>(evt);
    // Phase 5 (PRES-02): derive "submitted a suggestion" presence indicator with 6s TTL.
    // The seq update still happens (durable event) — presence side-effect does NOT suppress it.
    const participantId = p.suggestion.participant_id;
    return {
      ...state,
      lastSeq: seq,
      presence: {
        ...state.presence,
        [participantId]: { activity: 'submitted', expiresAt: Date.now() + 6000 },
      },
      session: withOpenQuestion(state.session, p.question_id, (q) => {
        const already = q.suggestions.find((s) => s.id === p.suggestion.id);
        if (already) return q;
        return { ...q, suggestions: [...q.suggestions, p.suggestion] };
      }),
    };
  }

  if (type === 'suggestion_updated') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ question_id: string; suggestion: WireSuggestion }>(evt);
    // Phase 5 (PRES-02): also update presence for "submitted" on suggestion_updated.
    const participantId = p.suggestion.participant_id;
    return {
      ...state,
      lastSeq: seq,
      presence: {
        ...state.presence,
        [participantId]: { activity: 'submitted', expiresAt: Date.now() + 6000 },
      },
      session: withOpenQuestion(state.session, p.question_id, (q) => {
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
      session: withOpenQuestion(state.session, p.question_id, (q) => {
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
    // Look up the resolved question in questions[] by question_id (Pitfall 6: don't use current_question)
    const resolved = state.session.questions.find((q) => q.id === p.question_id) ?? null;
    const newDecision =
      resolved !== null
        ? { question_id: resolved.id, question: resolved.text, answer: p.resolution.value }
        : null;
    const filteredQuestions = state.session.questions.filter((q) => q.id !== p.question_id);
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        questions: filteredQuestions,
        current_question: filteredQuestions[0] ?? null,
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
    // Remove from questions[] immediately (no "cancelled" card per UI-SPEC)
    const filteredQuestions = state.session.questions.filter((q) => q.id !== p.question_id);
    return {
      ...state,
      lastSeq: seq,
      session: {
        ...state.session,
        questions: filteredQuestions,
        current_question: filteredQuestions[0] ?? null,
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

  // Phase 4: participant_status_changed — update roster + own status
  if (type === 'participant_status_changed') {
    if (!state.session) return { ...state, lastSeq: seq };
    const p = payload<{ participant_id: string; status: 'pending' | 'approved' | 'kicked' }>(evt);
    const updatedParticipants = state.session.participants.map((x) =>
      x.id === p.participant_id ? { ...x, status: p.status } : x,
    );
    const myStatus = state.me?.id === p.participant_id ? p.status : state.myStatus;
    return {
      ...state,
      lastSeq: seq,
      myStatus,
      session: { ...state.session, participants: updatedParticipants },
    };
  }

  // Phase 4: room_locked — update lock state
  if (type === 'room_locked') {
    const p = payload<{ locked: boolean }>(evt);
    return { ...state, lastSeq: seq, roomLocked: p.locked };
  }

  // Phase 5: session_status_changed — update session lifecycle status
  if (type === 'session_status_changed') {
    const p = payload<{ status: 'waiting' | 'question_open' | 'choosing' | 'done' }>(evt);
    return { ...state, lastSeq: seq, sessionStatus: p.status };
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
      // Phase 4: set myStatus from welcome.you.status; do NOT clear if you is absent
      ...(evt.payload.you !== undefined ? { myStatus: evt.payload.you.status } : {}),
      // WR-01: project session.locked into roomLocked so a reloaded coordinator/
      // participant sees the correct lock state immediately without waiting for a
      // room_locked event that may have aged out of the ring buffer.
      roomLocked: evt.payload.session.locked,
      // Phase 5: seed sessionStatus from authoritative welcome payload so
      // reconnect/refresh restores the correct status without waiting for
      // session_status_changed events (which may have aged out of the ring buffer).
      sessionStatus: evt.payload.session.session_status,
      banner: null,
      // NOTE: do NOT update lastSeq — ephemeral welcome has no seq
    };
  }
  // Phase 5 (PRES-02): presence ephemeral frame — update the presence map.
  // CRITICAL: no lastSeq update — this is ephemeral (no seq field on the frame).
  // expiresAt computed at dispatch time (inside reducer), NOT at render time.
  if (evt.type === 'presence') {
    const { actor_kind, actor_id, activity } = evt.payload;
    const key = actor_id ?? (actor_kind === 'coordinator' ? '__coordinator' : '__unknown');
    if (activity === 'idle') {
      // WR-01 fix: protect only the derived 'submitted' entry — never wipe it on an
      // idle/stop frame. Both 'typing' AND 'picking' (coordinator) are clearable by an
      // idle frame; 'submitted' is the only sticky state and must survive the trailing
      // 'typing stop' frame that QuestionCard.tsx:59 sends immediately after submission.
      if (state.presence[key]?.activity === 'submitted') return state;
      const next = { ...state.presence };
      delete next[key];
      return { ...state, presence: next };
    }
    return {
      ...state,
      presence: {
        ...state.presence,
        [key]: { activity, expiresAt: Date.now() + 4000 },
      },
    };
  }

  // heartbeat — handled in ws.ts before reaching reducer
  return state;
}

/**
 * Synthetic UI-only action for expiring presence entries via App.tsx timers.
 * NOT part of AnyFrame or the wire schema — never sent over WebSocket.
 */
export type PresenceExpireAction = { type: 'presence_expired'; key: string };

export function reduce(state: UiState, evt: AnyFrame | PresenceExpireAction): UiState {
  if (evt.type === 'presence_expired') {
    const next = { ...state.presence };
    delete next[(evt as PresenceExpireAction).key];
    return { ...state, presence: next };
  }
  if (isServerEvent(evt as AnyFrame)) return applyServerEvent(state, evt as ServerEvent);
  if (isEphemeralFrame(evt as AnyFrame)) return applyEphemeralFrame(state, evt as EphemeralFrame);
  return state;
}
