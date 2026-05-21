/** @vitest-environment jsdom */
import { describe, it, beforeAll, expect, vi, afterEach } from 'vitest';
import { reduce, initialState } from './state.js';
import type { PresenceExpireAction } from './state.js';
import type { AnyFrame, EphemeralFrame } from '@shared-brainstorm/shared';

// AnyFrame uses z.infer which produces plain `string` (not branded) for IDs

const welcomeEphemeral: AnyFrame = {
  type: 'welcome',
  payload: {
    session: {
      session_id: 'sb_s_001',
      brief: 'test session',
      participants: [
        { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
      ],
      decisions: [],
      questions: [], // Phase 6 (BATCH-02)
      current_question: null,
      locked: false,
      session_status: 'waiting' as const,
      chat: [], // CHATAI-01 / CHAT-01
    },
    you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
    is_coordinator: false,
  },
};

describe('reduce — welcome (ephemeral, no seq)', () => {
  it('populates session and me from ephemeral welcome', () => {
    const next = reduce(initialState, welcomeEphemeral);
    expect(next.session).not.toBeNull();
    expect(next.session?.session_id).toBe('sb_s_001');
    expect(next.me).not.toBeNull();
    expect(next.me?.display_name).toBe('Alice');
    expect(next.lastSeq).toBe(-1); // ephemeral welcome must NOT update lastSeq
  });
});

describe('reduce — isCoordinator', () => {
  const sessionShape = {
    session_id: 'sb_s_001',
    brief: 'test session',
    participants: [],
    decisions: [],
    questions: [] as never[], // Phase 6 (BATCH-02)
    current_question: null,
    locked: false,
    session_status: 'waiting' as const,
    chat: [] as never[], // CHATAI-01 / CHAT-01
  };

  const coordinatorWelcome: AnyFrame = {
    seq: 0,
    ts: '2026-01-01T00:00:00Z',
    type: 'welcome',
    payload: { session: sessionShape, is_coordinator: true },
  };

  const participantWelcome: AnyFrame = {
    seq: 0,
    ts: '2026-01-01T00:00:00Z',
    type: 'welcome',
    payload: {
      session: sessionShape,
      you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
      is_coordinator: false,
    },
  };

  it('initialState.isCoordinator is false', () => {
    expect(initialState.isCoordinator).toBe(false);
  });

  it('sets isCoordinator true and me null for a coordinator welcome (you omitted)', () => {
    const next = reduce(initialState, coordinatorWelcome);
    expect(next.isCoordinator).toBe(true);
    expect(next.me).toBeNull();
  });

  it('sets isCoordinator false and me set for a participant welcome', () => {
    const next = reduce(initialState, participantWelcome);
    expect(next.isCoordinator).toBe(false);
    expect(next.me?.id).toBe('sb_p_001');
  });

  it('survives reconnect — a second welcome re-applies the flag with no stale carry-over', () => {
    const asCoordinator = reduce(initialState, coordinatorWelcome);
    expect(asCoordinator.isCoordinator).toBe(true);
    // A reconnect that arrives as a participant must clear the prior coordinator flag.
    const asParticipant = reduce(asCoordinator, participantWelcome);
    expect(asParticipant.isCoordinator).toBe(false);
    expect(asParticipant.me?.id).toBe('sb_p_001');
  });

  it('ephemeral coordinator welcome also sets isCoordinator true / me null', () => {
    const ephemeral: AnyFrame = {
      type: 'welcome',
      payload: { session: { ...sessionShape, locked: false }, is_coordinator: true },
    };
    const next = reduce(initialState, ephemeral);
    expect(next.isCoordinator).toBe(true);
    expect(next.me).toBeNull();
  });
});

describe('reduce — participant events', () => {
  const baseState = reduce(initialState, welcomeEphemeral);

  const joinEvt: AnyFrame = {
    seq: 1,
    ts: '2026-01-01T00:00:01Z',
    type: 'participant_joined',
    payload: {
      participant: {
        id: 'sb_p_002',
        display_name: 'Bob',
        joined_at: '2026-01-01T00:00:01Z',
        status: 'pending' as const,
      },
    },
  };

  it('adds participant on participant_joined', () => {
    const next = reduce(baseState, joinEvt);
    expect(next.session?.participants).toHaveLength(2);
    expect(next.lastSeq).toBe(1);
  });

  it('does not duplicate participant on double-join', () => {
    const s1 = reduce(baseState, joinEvt);
    const s2 = reduce(s1, joinEvt);
    expect(s2.session?.participants).toHaveLength(2);
  });

  it('removes participant on participant_left', () => {
    const withBob = reduce(baseState, joinEvt);
    const leftEvt: AnyFrame = {
      seq: 2,
      ts: '2026-01-01T00:00:02Z',
      type: 'participant_left',
      payload: { participant_id: 'sb_p_002' },
    };
    const next = reduce(withBob, leftEvt);
    expect(next.session?.participants).toHaveLength(1);
    expect(next.lastSeq).toBe(2);
  });
});

describe('reduce — seq guard (WR-07: idempotent replay)', () => {
  const baseState = reduce(initialState, welcomeEphemeral);

  const broadcastEvt: AnyFrame = {
    seq: 3,
    ts: '2026-01-01T00:00:03Z',
    type: 'question_broadcast',
    payload: {
      question: {
        id: 'sb_q_001',
        ticket_id: 'sb_t_001',
        asked_at: '2026-01-01T00:00:03Z',
        text: 'Which approach?',
        status: 'broadcast',
        suggestions: [],
        comments: [],
        clarifications: [], // CHATAI-01
        resolution: null,
      },
    },
  };

  const resolvedEvt: AnyFrame = {
    seq: 4,
    ts: '2026-01-01T00:00:04Z',
    type: 'question_resolved',
    payload: {
      question_id: 'sb_q_001',
      resolution: {
        value: 'Use approach A',
        source: 'override',
        recorded_at: '2026-01-01T00:00:04Z',
      },
    },
  };

  it('records exactly one decision when question_resolved is delivered once', () => {
    const withQ = reduce(baseState, broadcastEvt);
    const resolved = reduce(withQ, resolvedEvt);
    expect(resolved.session?.decisions).toHaveLength(1);
    expect(resolved.session?.decisions[0]?.answer).toBe('Use approach A');
    expect(resolved.lastSeq).toBe(4);
  });

  it('does NOT double-append a decision when question_resolved replays (double-delivery)', () => {
    // Simulates the WR-07 regression: a reconnecting client is seeded from the
    // `?last_seq=` query param at WS open AND replays again from the `hello`
    // frame, so the same buffered `question_resolved` (seq 4) arrives twice.
    const withQ = reduce(baseState, broadcastEvt);
    const once = reduce(withQ, resolvedEvt);
    const twice = reduce(once, resolvedEvt);
    expect(twice.session?.decisions).toHaveLength(1);
    expect(twice).toBe(once); // guard returns the same state reference unchanged
  });

  it('ignores an out-of-order event whose seq is older than the watermark', () => {
    const withQ = reduce(baseState, broadcastEvt); // lastSeq = 3
    const resolved = reduce(withQ, resolvedEvt); // lastSeq = 4
    // A stale re-delivery of the seq-3 broadcast must not clobber the resolved
    // question or rewind the watermark. Phase 6: question_resolved removes the
    // question from questions[], so current_question is null after resolution.
    const stale = reduce(resolved, broadcastEvt);
    expect(stale).toBe(resolved);
    expect(stale.lastSeq).toBe(4);
    // question was removed from questions[] on resolution (Phase 6 model)
    expect(stale.session?.current_question).toBeNull();
    expect(stale.session?.decisions).toHaveLength(1); // decision persisted
  });

  it('drops an event whose seq equals the current watermark', () => {
    const withQ = reduce(baseState, broadcastEvt); // lastSeq = 3
    const dup = reduce(withQ, broadcastEvt); // seq 3 <= lastSeq 3 → dropped
    expect(dup).toBe(withQ);
  });
});

describe('reduce — session_ended', () => {
  const baseState = reduce(initialState, welcomeEphemeral);

  it('sets banner on session_ended', () => {
    const evt: AnyFrame = {
      seq: 10,
      ts: '2026-01-01T00:00:10Z',
      type: 'session_ended',
      payload: { reason: 'stop_session' },
    };
    const next = reduce(baseState, evt);
    expect(next.banner).toContain('stop_session');
    expect(next.lastSeq).toBe(10);
  });
});

describe('reduce — tunnel_url_changed (REL-05 / D-20)', () => {
  // 02-07 locked the shape to `tunnelBanner: { url } | null` — no dismissed
  // field on the reducer. Dismiss-ack lives in `App.tsx` `useState` so the
  // banner reappears for a *new* URL even after the previous URL was
  // dismissed (Pitfall 3). Reducer tests assert only the latest-URL tracking;
  // dismiss-reappear semantics are covered by the Playwright spec.
  const baseState = reduce(initialState, welcomeEphemeral);

  const evtA: AnyFrame = {
    seq: 11,
    ts: '2026-01-01T00:00:11Z',
    type: 'tunnel_url_changed',
    payload: { public_url: 'https://A.example' },
  };

  it('sets tunnelBanner to the announced URL on first tunnel_url_changed', () => {
    const next = reduce(baseState, evtA);
    expect(next.tunnelBanner).toEqual({ url: 'https://A.example' });
    expect(next.lastSeq).toBe(11);
    // The dedicated tunnelBanner channel must not leak into the generic
    // `banner` field — the latter is reserved for session_ended UX.
    expect(next.banner).toBeNull();
  });

  it('updates tunnelBanner.url idempotently when the same URL is re-emitted', () => {
    const after1 = reduce(baseState, evtA);
    const evtASecond: AnyFrame = {
      seq: 12,
      ts: '2026-01-01T00:00:12Z',
      type: 'tunnel_url_changed',
      payload: { public_url: 'https://A.example' },
    };
    const after2 = reduce(after1, evtASecond);
    expect(after2.tunnelBanner).toEqual({ url: 'https://A.example' });
    expect(after2.lastSeq).toBe(12);
  });

  it('replaces tunnelBanner.url when a different URL is emitted', () => {
    const after1 = reduce(baseState, evtA);
    const evtB: AnyFrame = {
      seq: 13,
      ts: '2026-01-01T00:00:13Z',
      type: 'tunnel_url_changed',
      payload: { public_url: 'https://B.example' },
    };
    const after2 = reduce(after1, evtB);
    expect(after2.tunnelBanner).toEqual({ url: 'https://B.example' });
    expect(after2.lastSeq).toBe(13);
  });

  it('preserves tunnelBanner across a subsequent welcome (session-scoped, not bootstrap-cleared)', () => {
    // Late-joiner replay scenario: a `tunnel_url_changed` lands first, then
    // an ephemeral `welcome` arrives. The welcome must NOT wipe the banner
    // because the URL change is still operationally relevant.
    const afterChange = reduce(baseState, evtA);
    expect(afterChange.tunnelBanner).not.toBeNull();
    const afterWelcome = reduce(afterChange, welcomeEphemeral);
    expect(afterWelcome.tunnelBanner).toEqual({ url: 'https://A.example' });
  });

  it('initialState.tunnelBanner is null', () => {
    expect(initialState.tunnelBanner).toBeNull();
  });
});

describe('reduce — transport_failed (REL-03)', () => {
  const baseState = reduce(initialState, welcomeEphemeral);

  // Cast through `unknown` because the generic `Envelope<P>` helper in
  // packages/shared/src/events.ts erases the literal `type` discriminator at
  // declaration-generation time (z.ZodLiteral<string> instead of
  // z.ZodLiteral<'transport_failed'>), so structural assignment to AnyFrame
  // fails excess-property check despite the variant existing in the schema.
  // The reducer itself narrows correctly via the `type === 'transport_failed'`
  // string check and the payload<T>() helper.
  const transportFailedEvt: AnyFrame = {
    seq: 12,
    ts: '2026-05-19T12:00:00.000Z',
    type: 'transport_failed',
    payload: {
      code: 'cloudflared_permanent_failure',
      message: 'tunnel exited after 3 restart attempts',
      restart_count: 3,
      at: '2026-05-19T12:00:00.000Z',
    },
  } as unknown as AnyFrame;

  it('initialState.transportFailed is null', () => {
    expect(initialState.transportFailed).toBeNull();
  });

  it('sets transportFailed to the parsed payload on transport_failed', () => {
    const next = reduce(baseState, transportFailedEvt);
    expect(next.transportFailed).not.toBeNull();
    expect(next.transportFailed?.code).toBe('cloudflared_permanent_failure');
    expect(next.transportFailed?.message).toBe('tunnel exited after 3 restart attempts');
    expect(next.transportFailed?.restart_count).toBe(3);
    expect(next.transportFailed?.at).toBe('2026-05-19T12:00:00.000Z');
  });

  it('advances lastSeq on transport_failed', () => {
    const next = reduce(baseState, transportFailedEvt);
    expect(next.lastSeq).toBe(12);
  });

  it('does not touch the dismissable banner field', () => {
    const next = reduce(baseState, transportFailedEvt);
    expect(next.banner).toBeNull();
  });

  it('does not lose session/me when transport_failed lands', () => {
    const next = reduce(baseState, transportFailedEvt);
    expect(next.session).not.toBeNull();
    expect(next.me).not.toBeNull();
  });

  it('preserves transportFailed across a subsequent ephemeral welcome replay (late-joining client)', () => {
    // Late-joining client: receives ring-buffered transport_failed THEN a fresh
    // ephemeral welcome (the WS connect path). Welcome must not wipe the failure
    // state — only `initialState` should clear it.
    const afterFailure = reduce(baseState, transportFailedEvt);
    expect(afterFailure.transportFailed).not.toBeNull();
    const afterWelcome = reduce(afterFailure, welcomeEphemeral);
    expect(afterWelcome.transportFailed).not.toBeNull();
    expect(afterWelcome.transportFailed?.code).toBe('cloudflared_permanent_failure');
  });

  it('accepts cloudflared_version_mismatch code variant', () => {
    const evt: AnyFrame = {
      seq: 13,
      ts: '2026-05-19T12:01:00.000Z',
      type: 'transport_failed',
      payload: {
        code: 'cloudflared_version_mismatch',
        message: 'cloudflared version 2024.01.01 too old',
        restart_count: 0,
        at: '2026-05-19T12:01:00.000Z',
      },
    } as unknown as AnyFrame;
    const next = reduce(baseState, evt);
    expect(next.transportFailed?.code).toBe('cloudflared_version_mismatch');
  });
});

describe('reduce — question lifecycle', () => {
  const baseState = reduce(initialState, welcomeEphemeral);

  const broadcastEvt: AnyFrame = {
    seq: 3,
    ts: '2026-01-01T00:00:03Z',
    type: 'question_broadcast',
    payload: {
      question: {
        id: 'sb_q_001',
        ticket_id: 'sb_t_001',
        asked_at: '2026-01-01T00:00:03Z',
        text: 'Which approach?',
        status: 'broadcast',
        suggestions: [],
        comments: [],
        clarifications: [], // CHATAI-01
        resolution: null,
      },
    },
  };

  it('sets current_question on question_broadcast', () => {
    const next = reduce(baseState, broadcastEvt);
    expect(next.session?.current_question?.id).toBe('sb_q_001');
    expect(next.lastSeq).toBe(3);
  });

  it('removes question on question_cancelled (Phase 6: no cancelled card per UI-SPEC)', () => {
    const withQ = reduce(baseState, broadcastEvt);
    const cancelEvt: AnyFrame = {
      seq: 4,
      ts: '2026-01-01T00:00:04Z',
      type: 'question_cancelled',
      payload: { question_id: 'sb_q_001', reason: 'timeout' },
    };
    const next = reduce(withQ, cancelEvt);
    // Phase 6: cancelled question is removed from questions[] immediately
    expect(next.session?.questions).toHaveLength(0);
    expect(next.session?.current_question).toBeNull();
  });
});

describe('reduce — roomLocked from welcome (WR-01)', () => {
  // Regression: welcome handlers must project session.locked into roomLocked so
  // a reloaded coordinator/participant reflects the true lock state immediately
  // without waiting for a room_locked event that may have aged out of the ring
  // buffer.
  const sessionBase = {
    session_id: 'sb_s_001',
    brief: 'test session',
    participants: [],
    decisions: [],
    questions: [] as never[], // Phase 6 (BATCH-02)
    current_question: null,
    session_status: 'waiting' as const,
    chat: [] as never[], // CHATAI-01 / CHAT-01
  };

  it('ephemeral welcome with locked:true sets roomLocked true', () => {
    const evt: AnyFrame = {
      type: 'welcome',
      payload: {
        session: { ...sessionBase, locked: true },
        you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
        is_coordinator: false,
      },
    };
    const next = reduce(initialState, evt);
    expect(next.roomLocked).toBe(true);
  });

  it('ephemeral welcome with locked:false sets roomLocked false', () => {
    // Start with roomLocked true (from a prior room_locked event), then receive
    // a welcome with locked:false — must clear the lock flag.
    const lockedEvt: AnyFrame = {
      seq: 1,
      ts: '2026-01-01T00:00:01Z',
      type: 'room_locked',
      payload: { locked: true },
    };
    const withLock = reduce(initialState, lockedEvt);
    expect(withLock.roomLocked).toBe(true);

    const welcomeEvt: AnyFrame = {
      type: 'welcome',
      payload: {
        session: { ...sessionBase, locked: false },
        is_coordinator: true,
      },
    };
    const next = reduce(withLock, welcomeEvt);
    expect(next.roomLocked).toBe(false);
  });

  it('seq-carrying (server-event) welcome with locked:true sets roomLocked true', () => {
    const evt: AnyFrame = {
      seq: 0,
      ts: '2026-01-01T00:00:00Z',
      type: 'welcome',
      payload: {
        session: { ...sessionBase, locked: true },
        you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
        is_coordinator: false,
      },
    };
    const next = reduce(initialState, evt);
    expect(next.roomLocked).toBe(true);
  });
});

describe('reduce — participant_status_changed (Phase 4 / CR-02 regression)', () => {
  // Base state: Alice (sb_p_001) is the active user, approved.
  const baseState = reduce(initialState, welcomeEphemeral);

  it('sets myStatus to kicked when participant_status_changed targets the current user', () => {
    const kickEvt: AnyFrame = {
      seq: 5,
      ts: '2026-01-01T00:00:05Z',
      type: 'participant_status_changed',
      payload: { participant_id: 'sb_p_001', status: 'kicked' as const },
    };
    const next = reduce(baseState, kickEvt);
    expect(next.myStatus).toBe('kicked');
  });

  it('does NOT reset myStatus when a different participant is status-changed', () => {
    // Add Bob first, then kick Bob — Alice's myStatus must stay 'approved'.
    const joinEvt: AnyFrame = {
      seq: 1,
      ts: '2026-01-01T00:00:01Z',
      type: 'participant_joined',
      payload: {
        participant: {
          id: 'sb_p_002',
          display_name: 'Bob',
          joined_at: '2026-01-01T00:00:01Z',
          status: 'pending' as const,
        },
      },
    };
    const withBob = reduce(baseState, joinEvt);
    const kickBobEvt: AnyFrame = {
      seq: 5,
      ts: '2026-01-01T00:00:05Z',
      type: 'participant_status_changed',
      payload: { participant_id: 'sb_p_002', status: 'kicked' as const },
    };
    const next = reduce(withBob, kickBobEvt);
    // Alice is still approved
    expect(next.myStatus).toBe('approved');
    // Bob's roster entry is updated to kicked
    expect(next.session?.participants.find((p) => p.id === 'sb_p_002')?.status).toBe('kicked');
  });

  it('myStatus stays kicked — the reducer never clears it on its own (live-kick persistence)', () => {
    // Regression for CR-02 concern: myStatus must NOT be reset when the WS closes.
    // React state survives WS reconnect cycles within the same page load. The
    // kicked participant sees the removed screen on all subsequent reconnect attempts.
    // This test confirms no reducer branch accidentally clears myStatus after a kick.
    const kickEvt: AnyFrame = {
      seq: 5,
      ts: '2026-01-01T00:00:05Z',
      type: 'participant_status_changed',
      payload: { participant_id: 'sb_p_001', status: 'kicked' as const },
    };
    const kicked = reduce(baseState, kickEvt);
    expect(kicked.myStatus).toBe('kicked');
    // Simulate a replay of an already-seen seq (WR-07 guard drops it) — myStatus unchanged.
    const afterDrop = reduce(kicked, kickEvt);
    expect(afterDrop.myStatus).toBe('kicked');
    expect(afterDrop).toBe(kicked); // guard returns same reference
  });

  it('myStatus transitions pending → approved correctly (welcome then approve)', () => {
    // Build a state where Alice is pending (fresh join).
    const pendingWelcome: AnyFrame = {
      type: 'welcome',
      payload: {
        session: {
          session_id: 'sb_s_001',
          brief: 'test session',
          participants: [
            {
              id: 'sb_p_001',
              display_name: 'Alice',
              joined_at: '2026-01-01T00:00:00Z',
              status: 'pending' as const,
            },
          ],
          decisions: [],
          questions: [] as never[], // Phase 6 (BATCH-02)
          current_question: null,
          locked: false,
          session_status: 'waiting' as const,
          chat: [] as never[], // CHATAI-01 / CHAT-01
        },
        you: {
          id: 'sb_p_001',
          display_name: 'Alice',
          joined_at: '2026-01-01T00:00:00Z',
          status: 'pending' as const,
        },
        is_coordinator: false,
      },
    };
    const pending = reduce(initialState, pendingWelcome);
    expect(pending.myStatus).toBe('pending');

    const approveEvt: AnyFrame = {
      seq: 1,
      ts: '2026-01-01T00:00:01Z',
      type: 'participant_status_changed',
      payload: { participant_id: 'sb_p_001', status: 'approved' as const },
    };
    const approved = reduce(pending, approveEvt);
    expect(approved.myStatus).toBe('approved');
  });
});

describe('App — classifyCloseReason (CR-02 regression: kick-evasion on reload)', () => {
  // These tests verify that the close-reason routing function routes correctly:
  //  - reason 'removed' must never trigger auto-join (→ removed screen)
  //  - reason 'not_joined' must trigger auto-join with remembered name
  //  - reason unknown/empty must show Join form without auto-join (fail-safe)
  //
  // This is a pure function test — no React rendering harness required.
  // The function is exported from App.tsx as a named export.
  let classifyCloseReason: (reason: string) => 'removed' | 'not_joined' | 'unknown';

  beforeAll(async () => {
    const mod = await import('./App.js');
    classifyCloseReason = mod.classifyCloseReason;
  });

  it('classifies reason "removed" as removed (kicked participant — must NOT auto-join)', () => {
    expect(classifyCloseReason('removed')).toBe('removed');
  });

  it('classifies reason "not_joined" as not_joined (stale cookie — may auto-join)', () => {
    expect(classifyCloseReason('not_joined')).toBe('not_joined');
  });

  it('classifies empty reason string as unknown (fail-safe — must NOT auto-join)', () => {
    expect(classifyCloseReason('')).toBe('unknown');
  });

  it('classifies any other reason string as unknown (fail-safe)', () => {
    expect(classifyCloseReason('session_ended')).toBe('unknown');
    expect(classifyCloseReason('stale')).toBe('unknown');
    expect(classifyCloseReason('some_future_reason')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Phase 5 (05-02): sessionStatus + presence + PresenceExpireAction
// ---------------------------------------------------------------------------

describe('reduce — sessionStatus (Phase 5 / PRES-01)', () => {
  // Test 1: initialState.sessionStatus
  it('initialState.sessionStatus === "waiting"', () => {
    expect(initialState.sessionStatus).toBe('waiting');
  });

  // Test 2: initialState.presence
  it('initialState.presence deep-equals {}', () => {
    expect(initialState.presence).toEqual({});
  });

  // Test 3: session_status_changed sets sessionStatus + advances lastSeq
  it('session_status_changed with status "question_open" sets sessionStatus and advances lastSeq', () => {
    const baseState = reduce(initialState, welcomeEphemeral);
    const evt: AnyFrame = {
      seq: 20,
      ts: '2026-01-01T00:00:20Z',
      type: 'session_status_changed',
      payload: { status: 'question_open' as const },
    } as unknown as AnyFrame;
    const next = reduce(baseState, evt);
    expect(next.sessionStatus).toBe('question_open');
    expect(next.lastSeq).toBe(20);
  });

  // Test 4: session_status_changed does NOT clear other UiState fields
  it('session_status_changed does NOT clear other UiState fields (session, me, etc. unchanged)', () => {
    const baseState = reduce(initialState, welcomeEphemeral);
    const evt: AnyFrame = {
      seq: 21,
      ts: '2026-01-01T00:00:21Z',
      type: 'session_status_changed',
      payload: { status: 'choosing' as const },
    } as unknown as AnyFrame;
    const next = reduce(baseState, evt);
    expect(next.sessionStatus).toBe('choosing');
    // Other fields unchanged
    expect(next.session?.session_id).toBe(baseState.session?.session_id);
    expect(next.me?.id).toBe(baseState.me?.id);
    expect(next.isCoordinator).toBe(baseState.isCoordinator);
    expect(next.roomLocked).toBe(baseState.roomLocked);
  });

  // Test 5: ephemeral welcome with session.session_status='choosing' sets sessionStatus,
  // does NOT advance lastSeq
  it('ephemeral welcome with session.session_status="choosing" sets sessionStatus; does NOT advance lastSeq', () => {
    const sessionShape = {
      session_id: 'sb_s_001',
      brief: 'test session',
      participants: [],
      decisions: [],
      questions: [] as never[], // Phase 6 (BATCH-02)
      current_question: null,
      locked: false,
      session_status: 'choosing' as const,
      chat: [] as never[], // CHATAI-01 / CHAT-01
    };
    const evt: AnyFrame = {
      type: 'welcome',
      payload: {
        session: sessionShape,
        you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
        is_coordinator: false,
      },
    };
    const next = reduce(initialState, evt);
    expect(next.sessionStatus).toBe('choosing');
    expect(next.lastSeq).toBe(-1); // ephemeral — no seq advancement
  });

  // Test 5b: WR-03 — seq-carrying (durable) welcome also projects session_status
  it('WR-03: seq-carrying welcome (durable ServerEvent form) projects session_status (not stuck at prior value)', () => {
    // Start with sessionStatus='choosing' (e.g. from a prior session_status_changed)
    const chosingEvt: AnyFrame = {
      seq: 5,
      ts: '2026-01-01T00:00:05Z',
      type: 'session_status_changed',
      payload: { status: 'choosing' as const },
    } as unknown as AnyFrame;
    const withChoosing = reduce(initialState, chosingEvt);
    expect(withChoosing.sessionStatus).toBe('choosing');

    // Reconnect delivers a seq-carrying welcome with session_status='question_open'
    const durableWelcome: AnyFrame = {
      seq: 6,
      ts: '2026-01-01T00:00:06Z',
      type: 'welcome',
      payload: {
        session: {
          session_id: 'sb_s_001',
          brief: 'test session',
          participants: [],
          decisions: [],
          questions: [] as never[], // Phase 6 (BATCH-02)
          current_question: null,
          locked: false,
          session_status: 'question_open' as const,
          chat: [] as never[], // CHATAI-01 / CHAT-01
        },
        you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z', status: 'approved' as const },
        is_coordinator: false,
      },
    };
    const next = reduce(withChoosing, durableWelcome);
    // WR-03 fix: sessionStatus must be updated from the welcome payload, not stuck at 'choosing'
    expect(next.sessionStatus).toBe('question_open');
    // lastSeq advances (it is a durable/seq-carrying event)
    expect(next.lastSeq).toBe(6);
  });

  // Test 6: WR-07 guard — session_status_changed with seq <= lastSeq is dropped
  it('WR-07: session_status_changed with seq <= lastSeq is dropped (state unchanged)', () => {
    const baseState = reduce(initialState, welcomeEphemeral);
    // Advance lastSeq to 25
    const advanceEvt: AnyFrame = {
      seq: 25,
      ts: '2026-01-01T00:00:25Z',
      type: 'session_status_changed',
      payload: { status: 'question_open' as const },
    } as unknown as AnyFrame;
    const advanced = reduce(baseState, advanceEvt);
    expect(advanced.lastSeq).toBe(25);
    expect(advanced.sessionStatus).toBe('question_open');

    // Now dispatch a stale event with seq <= lastSeq (25)
    const staleEvt: AnyFrame = {
      seq: 24,
      ts: '2026-01-01T00:00:24Z',
      type: 'session_status_changed',
      payload: { status: 'done' as const },
    } as unknown as AnyFrame;
    const result = reduce(advanced, staleEvt);
    expect(result).toBe(advanced); // same reference — dropped
    expect(result.sessionStatus).toBe('question_open'); // not changed to 'done'
  });

  // Test 7: presence_expired removes key from state.presence
  it('presence_expired with key "p1" removes that key from state.presence', () => {
    // Seed state with a presence entry
    const stateWithPresence = {
      ...initialState,
      presence: { p1: { activity: 'typing', expiresAt: Date.now() + 4000 } },
    };
    const action: PresenceExpireAction = { type: 'presence_expired', key: 'p1' };
    const next = reduce(stateWithPresence, action);
    expect(next.presence).toEqual({});
  });

  // Test 7b: presence_expired on empty presence is safe no-op
  it('presence_expired on empty presence is a safe no-op', () => {
    const action: PresenceExpireAction = { type: 'presence_expired', key: 'p1' };
    const next = reduce(initialState, action);
    expect(next.presence).toEqual({});
  });

  // Test 8: reduce() accepts PresenceExpireAction without crashing
  it('reduce() accepts a PresenceExpireAction directly without crashing', () => {
    const action: PresenceExpireAction = { type: 'presence_expired', key: 'sb_p_999' };
    expect(() => reduce(initialState, action)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 5 (05-03): presence EphemeralFrame branch in applyEphemeralFrame
// ---------------------------------------------------------------------------

describe('reduce — presence EphemeralFrame branch (PRES-02)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Test 1: typing presence frame updates presence map with correct expiresAt
  it('presence frame with activity "typing" sets presence[actor_id] with correct expiresAt (dispatch time)', () => {
    vi.useFakeTimers();
    const now = Date.now();

    const presenceFrame: EphemeralFrame = {
      type: 'presence',
      payload: {
        actor_kind: 'participant',
        actor_id: 'sb_p_001',
        activity: 'typing',
      },
    };

    const next = reduce(initialState, presenceFrame);
    expect(next.presence['sb_p_001']).toBeDefined();
    expect(next.presence['sb_p_001']?.activity).toBe('typing');
    // expiresAt must be computed at dispatch time (~now + 4000ms)
    expect(next.presence['sb_p_001']?.expiresAt).toBeGreaterThanOrEqual(now + 3999);
    expect(next.presence['sb_p_001']?.expiresAt).toBeLessThanOrEqual(now + 4001);
  });

  // Test 2: presence frame with activity "idle" REMOVES the entry from presence map
  it('presence frame with activity "idle" removes the entry from presence map', () => {
    const stateWithPresence = {
      ...initialState,
      presence: { sb_p_001: { activity: 'typing', expiresAt: Date.now() + 4000 } },
    };

    const idleFrame: EphemeralFrame = {
      type: 'presence',
      payload: {
        actor_kind: 'participant',
        actor_id: 'sb_p_001',
        activity: 'idle',
      },
    };

    const next = reduce(stateWithPresence, idleFrame);
    expect(next.presence['sb_p_001']).toBeUndefined();
    expect(Object.keys(next.presence)).toHaveLength(0);
  });

  // Test 3: presence EphemeralFrame does NOT update lastSeq (ephemeral — no seq field)
  it('presence EphemeralFrame does NOT update lastSeq', () => {
    // First advance lastSeq to a known value
    const advanced = { ...initialState, lastSeq: 42 };

    const presenceFrame: EphemeralFrame = {
      type: 'presence',
      payload: {
        actor_kind: 'participant',
        actor_id: 'sb_p_001',
        activity: 'typing',
      },
    };

    const next = reduce(advanced, presenceFrame);
    expect(next.lastSeq).toBe(42); // lastSeq unchanged — ephemeral, no seq
  });

  // Test 4: expiresAt computed at dispatch time (inside reduce), not at render time
  it('expiresAt is computed at dispatch time (inside reduce function), not deferred', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const presenceFrame: EphemeralFrame = {
      type: 'presence',
      payload: {
        actor_kind: 'participant',
        actor_id: 'p_test',
        activity: 'typing',
      },
    };

    const next = reduce(initialState, presenceFrame);
    const dispatchTime = new Date('2026-01-01T00:00:00Z').getTime();
    expect(next.presence['p_test']?.expiresAt).toBe(dispatchTime + 4000);

    // Advance time — the expiresAt in state must NOT change (it was set at dispatch)
    vi.advanceTimersByTime(2000);
    expect(next.presence['p_test']?.expiresAt).toBe(dispatchTime + 4000);
  });

  // Test 5: suggestion_added sets presence[participant_id].activity === 'submitted' with 6s TTL
  it('suggestion_added sets presence[participant_id].activity "submitted" with ~6s TTL', () => {
    vi.useFakeTimers();
    const now = Date.now();
    const baseState = reduce(initialState, welcomeEphemeral);

    const suggestionEvt: AnyFrame = {
      seq: 5,
      ts: '2026-01-01T00:00:05Z',
      type: 'suggestion_added',
      payload: {
        question_id: 'sb_q_001',
        suggestion: {
          id: 'sb_sug_001',
          participant_id: 'sb_p_001',
          value: 'Use Redis',
          at: '2026-01-01T00:00:05Z',
        },
      },
    };

    const next = reduce(baseState, suggestionEvt);
    expect(next.presence['sb_p_001']).toBeDefined();
    expect(next.presence['sb_p_001']?.activity).toBe('submitted');
    // 6s TTL — expiresAt should be approximately now + 6000
    expect(next.presence['sb_p_001']?.expiresAt).toBeGreaterThanOrEqual(now + 5999);
    expect(next.presence['sb_p_001']?.expiresAt).toBeLessThanOrEqual(now + 6001);
  });

  // Test 6: suggestion_added still advances lastSeq (durable ring-buffered event — presence side-effect does NOT suppress seq update)
  it('suggestion_added advances lastSeq even with presence side-effect (both happen together)', () => {
    const baseState = reduce(initialState, welcomeEphemeral);

    const suggestionEvt: AnyFrame = {
      seq: 7,
      ts: '2026-01-01T00:00:07Z',
      type: 'suggestion_added',
      payload: {
        question_id: 'sb_q_001',
        suggestion: {
          id: 'sb_sug_002',
          participant_id: 'sb_p_001',
          value: 'Use Postgres',
          at: '2026-01-01T00:00:07Z',
        },
      },
    };

    const next = reduce(baseState, suggestionEvt);
    expect(next.lastSeq).toBe(7); // seq advances (durable event)
    expect(next.presence['sb_p_001']?.activity).toBe('submitted'); // presence side-effect
  });

  // Test 7: WR-01 regression — typing-start → submitted → typing-stop must preserve 'submitted'
  it('WR-01: typing-start → suggestion_added (submitted) → typing-stop (idle) leaves activity "submitted" (not deleted)', () => {
    // Need a base state with a session so suggestion_added can update presence
    // (the reducer's suggestion_added branch guards on state.session !== null).
    const baseState = reduce(initialState, welcomeEphemeral);

    // Step 1: participant starts typing — presence entry set to 'typing'
    const typingStartFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'participant', actor_id: 'sb_p_001', activity: 'typing' },
    };
    const afterTypingStart = reduce(baseState, typingStartFrame);
    expect(afterTypingStart.presence['sb_p_001']?.activity).toBe('typing');

    // Step 2: suggestion_added arrives — presence promoted to 'submitted' (6s TTL)
    const suggestionAddedEvt: AnyFrame = {
      seq: 10,
      ts: '2026-01-01T00:00:10Z',
      type: 'suggestion_added',
      payload: {
        question_id: 'sb_q_001',
        suggestion: {
          id: 'sb_sug_010',
          participant_id: 'sb_p_001',
          value: 'Use Postgres',
          at: '2026-01-01T00:00:10Z',
        },
      },
    };
    const afterSubmit = reduce(afterTypingStart, suggestionAddedEvt);
    expect(afterSubmit.presence['sb_p_001']?.activity).toBe('submitted');

    // Step 3: typing-stop idle frame arrives (QuestionCard sends stop on submit) —
    // must NOT delete the 'submitted' entry (WR-01 fix: idle only clears 'typing').
    const typingStopFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'participant', actor_id: 'sb_p_001', activity: 'idle' },
    };
    const afterTypingStop = reduce(afterSubmit, typingStopFrame);
    expect(afterTypingStop.presence['sb_p_001']).toBeDefined();
    expect(afterTypingStop.presence['sb_p_001']?.activity).toBe('submitted');
  });

  // Test 8: WR-01 complement — typing-start → typing-stop still removes the 'typing' entry
  it('WR-01 complement: typing-start → typing-stop (idle) still removes a typing entry (normal path unaffected)', () => {
    const typingStartFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'participant', actor_id: 'sb_p_002', activity: 'typing' },
    };
    const afterStart = reduce(initialState, typingStartFrame);
    expect(afterStart.presence['sb_p_002']?.activity).toBe('typing');

    const typingStopFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'participant', actor_id: 'sb_p_002', activity: 'idle' },
    };
    const afterStop = reduce(afterStart, typingStopFrame);
    expect(afterStop.presence['sb_p_002']).toBeUndefined();
  });

  // Test 9: picking-start → picking-stop (idle) clears the coordinator presence entry
  // Regression guard for the secondary issue in WR-01: the prior guard (`!== 'typing'`)
  // left 'picking' entries stranded because idle was a no-op for any non-'typing' entry.
  // The fix (`=== 'submitted'`) means idle clears 'typing' AND 'picking', only sparing 'submitted'.
  it('picking-start → picking-stop (idle) clears the coordinator __coordinator presence entry', () => {
    // actor_id omitted for coordinator (exactOptionalPropertyTypes: field must be absent, not undefined)
    const pickingStartFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'coordinator', activity: 'picking' },
    };
    const afterStart = reduce(initialState, pickingStartFrame);
    expect(afterStart.presence['__coordinator']?.activity).toBe('picking');

    const pickingStopFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'coordinator', activity: 'idle' },
    };
    const afterStop = reduce(afterStart, pickingStopFrame);
    expect(afterStop.presence['__coordinator']).toBeUndefined();
  });

  // Test 10: submitted → idle keeps 'submitted'; picking → idle clears 'picking' (combined guard)
  it('idle clears picking but not submitted — both guards active simultaneously', () => {
    // Seed two presence entries: one picking (coordinator) and one submitted (participant)
    const stateWith2 = {
      ...initialState,
      presence: {
        '__coordinator': { activity: 'picking', expiresAt: Date.now() + 4000 },
        'sb_p_001': { activity: 'submitted', expiresAt: Date.now() + 6000 },
      },
    };

    // Coordinator idle frame (actor_id omitted) — clears 'picking', must NOT touch 'submitted'
    const coordIdleFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'coordinator', activity: 'idle' },
    };
    const afterCoordStop = reduce(stateWith2, coordIdleFrame);
    expect(afterCoordStop.presence['__coordinator']).toBeUndefined();
    expect(afterCoordStop.presence['sb_p_001']?.activity).toBe('submitted');

    // Participant idle frame for submitted entry — must be a no-op (submitted is sticky)
    const participantIdleFrame: EphemeralFrame = {
      type: 'presence',
      payload: { actor_kind: 'participant', actor_id: 'sb_p_001', activity: 'idle' },
    };
    const afterParticipantStop = reduce(afterCoordStop, participantIdleFrame);
    expect(afterParticipantStop.presence['sb_p_001']?.activity).toBe('submitted');
    expect(Object.keys(afterParticipantStop.presence)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 (06-02): questions[] accumulation (BATCH-02)
// ---------------------------------------------------------------------------

describe('Phase 6: questions[] accumulation (BATCH-02)', () => {
  const baseState = reduce(initialState, welcomeEphemeral);

  const q1: AnyFrame = {
    seq: 10,
    ts: '2026-01-01T00:00:10Z',
    type: 'question_broadcast',
    payload: {
      question: {
        id: 'sb_q_001',
        ticket_id: 'sb_t_001',
        asked_at: '2026-01-01T00:00:10Z',
        text: 'What is Q1?',
        status: 'broadcast' as const,
        suggestions: [],
        comments: [],
        clarifications: [], // CHATAI-01
        resolution: null,
      },
    },
  };

  const q2: AnyFrame = {
    seq: 11,
    ts: '2026-01-01T00:00:11Z',
    type: 'question_broadcast',
    payload: {
      question: {
        id: 'sb_q_002',
        ticket_id: 'sb_t_002',
        asked_at: '2026-01-01T00:00:11Z',
        text: 'What is Q2?',
        status: 'broadcast' as const,
        suggestions: [],
        comments: [],
        clarifications: [], // CHATAI-01
        resolution: null,
      },
    },
  };

  it('question_broadcast adds Q1 to questions[]; questions has length 1', () => {
    const next = reduce(baseState, q1);
    expect(next.session?.questions).toHaveLength(1);
    expect(next.session?.questions[0]?.id).toBe('sb_q_001');
  });

  it('second question_broadcast for Q2 appends; questions has length 2, order [Q1, Q2]', () => {
    const withQ1 = reduce(baseState, q1);
    const withBoth = reduce(withQ1, q2);
    expect(withBoth.session?.questions).toHaveLength(2);
    expect(withBoth.session?.questions[0]?.id).toBe('sb_q_001');
    expect(withBoth.session?.questions[1]?.id).toBe('sb_q_002');
  });

  it('duplicate question_broadcast for Q1 (same id) UPDATES in place; questions still length 1 (idempotent)', () => {
    const withQ1 = reduce(baseState, q1);
    const updatedQ1: AnyFrame = {
      seq: 12,
      ts: '2026-01-01T00:00:12Z',
      type: 'question_broadcast',
      payload: {
        question: {
          id: 'sb_q_001', // same id
          ticket_id: 'sb_t_001',
          asked_at: '2026-01-01T00:00:10Z',
          text: 'What is Q1? (updated)',
          status: 'broadcast' as const,
          suggestions: [],
          comments: [],
          clarifications: [], // CHATAI-01
          resolution: null,
        },
      },
    };
    const updated = reduce(withQ1, updatedQ1);
    expect(updated.session?.questions).toHaveLength(1);
    expect(updated.session?.questions[0]?.text).toBe('What is Q1? (updated)');
  });

  it('current_question derived as questions[0] after question_broadcast for Q1 then Q2', () => {
    const withQ1 = reduce(baseState, q1);
    const withBoth = reduce(withQ1, q2);
    expect(withBoth.session?.current_question?.id).toBe('sb_q_001');
  });

  it('current_question is null when questions is empty', () => {
    expect(baseState.session?.questions).toHaveLength(0);
    expect(baseState.session?.current_question).toBeNull();
  });

  it('question_resolved for Q2 marks Q2 resolved in place (flip-then-fold); Q1 stays broadcast; decisions gains Q2', () => {
    const withBoth = reduce(reduce(baseState, q1), q2);
    const resolveQ2: AnyFrame = {
      seq: 20,
      ts: '2026-01-01T00:00:20Z',
      type: 'question_resolved',
      payload: {
        question_id: 'sb_q_002',
        resolution: { value: 'Answer for Q2', source: 'override' as const, recorded_at: '2026-01-01T00:00:20Z' },
      },
    };
    const next = reduce(withBoth, resolveQ2);
    // Phase 6 fix: the resolved question is KEPT in questions[] marked `resolved`
    // (the card flips in place to "✓ Decided" per UI-SPEC; the participant view
    // filters status==='broadcast' so it folds into decisions there, and the
    // coordinator view renders the resolved marker). It is NOT dropped from the array.
    expect(next.session?.questions).toHaveLength(2);
    const q2Entry = next.session?.questions.find((q) => q.id === 'sb_q_002');
    expect(q2Entry?.status).toBe('resolved');
    expect(q2Entry?.resolution?.value).toBe('Answer for Q2');
    // Q1 remains broadcast and is the derived current_question (first still-open).
    const q1Entry = next.session?.questions.find((q) => q.id === 'sb_q_001');
    expect(q1Entry?.status).toBe('broadcast');
    expect(next.session?.current_question?.id).toBe('sb_q_001');
    // The decision is still recorded.
    expect(next.session?.decisions).toHaveLength(1);
    expect(next.session?.decisions[0]?.answer).toBe('Answer for Q2');
    expect(next.session?.decisions[0]?.question_id).toBe('sb_q_002');
  });

  it('question_resolved for Q2 when Q2 is at index 1 — questions[0] (Q1) is unchanged', () => {
    const withBoth = reduce(reduce(baseState, q1), q2);
    const resolveQ2: AnyFrame = {
      seq: 21,
      ts: '2026-01-01T00:00:21Z',
      type: 'question_resolved',
      payload: {
        question_id: 'sb_q_002',
        resolution: { value: 'Answer for Q2', source: 'suggestion' as const, recorded_at: '2026-01-01T00:00:21Z' },
      },
    };
    const next = reduce(withBoth, resolveQ2);
    // Q1 remains at index 0, still broadcast, still submittable
    expect(next.session?.questions[0]?.id).toBe('sb_q_001');
    expect(next.session?.questions[0]?.status).toBe('broadcast');
    expect(next.session?.current_question?.id).toBe('sb_q_001');
  });

  it('question_cancelled for Q1 removes Q1 from questions[]; no entry in decisions[]', () => {
    const withQ1 = reduce(baseState, q1);
    const cancelQ1: AnyFrame = {
      seq: 22,
      ts: '2026-01-01T00:00:22Z',
      type: 'question_cancelled',
      payload: { question_id: 'sb_q_001', reason: 'timeout' },
    };
    const next = reduce(withQ1, cancelQ1);
    expect(next.session?.questions).toHaveLength(0);
    expect(next.session?.decisions).toHaveLength(0);
    expect(next.session?.current_question).toBeNull();
  });

  it('suggestion_added event with question_id=Q2.id updates Q2.suggestions; Q1.suggestions unaffected', () => {
    const withBoth = reduce(reduce(baseState, q1), q2);
    const suggestionForQ2: AnyFrame = {
      seq: 30,
      ts: '2026-01-01T00:00:30Z',
      type: 'suggestion_added',
      payload: {
        question_id: 'sb_q_002',
        suggestion: {
          id: 'sb_sug_001',
          participant_id: 'sb_p_001',
          value: 'My answer for Q2',
          at: '2026-01-01T00:00:30Z',
        },
      },
    };
    const next = reduce(withBoth, suggestionForQ2);
    const q1State = next.session?.questions.find((q) => q.id === 'sb_q_001');
    const q2State = next.session?.questions.find((q) => q.id === 'sb_q_002');
    expect(q2State?.suggestions).toHaveLength(1);
    expect(q2State?.suggestions[0]?.value).toBe('My answer for Q2');
    // Q1 is untouched
    expect(q1State?.suggestions).toHaveLength(0);
  });

  it('welcome payload with questions:[Q1,Q2] seeds state.session.questions with both', () => {
    const welcomeWithQuestions: AnyFrame = {
      type: 'welcome',
      payload: {
        session: {
          session_id: 'sb_s_001',
          brief: 'test session',
          participants: [],
          decisions: [],
          questions: [
            {
              id: 'sb_q_001',
              ticket_id: 'sb_t_001',
              asked_at: '2026-01-01T00:00:10Z',
              text: 'What is Q1?',
              status: 'broadcast' as const,
              suggestions: [],
              comments: [],
              clarifications: [], // CHATAI-01
              resolution: null,
            },
            {
              id: 'sb_q_002',
              ticket_id: 'sb_t_002',
              asked_at: '2026-01-01T00:00:11Z',
              text: 'What is Q2?',
              status: 'broadcast' as const,
              suggestions: [],
              comments: [],
              clarifications: [], // CHATAI-01
              resolution: null,
            },
          ],
          current_question: null,
          locked: false,
          session_status: 'question_open' as const,
          chat: [] as never[], // CHATAI-01 / CHAT-01
        },
        is_coordinator: false,
      },
    };
    const next = reduce(initialState, welcomeWithQuestions);
    expect(next.session?.questions).toHaveLength(2);
    expect(next.session?.questions[0]?.id).toBe('sb_q_001');
    expect(next.session?.questions[1]?.id).toBe('sb_q_002');
  });

  it('replay of question_broadcast already in welcome does NOT duplicate (seq guard + findIndex)', () => {
    // Welcome seeds Q1. A ring-buffer replay of q1's question_broadcast (seq 10)
    // must be dropped by the WR-07 seq guard (lastSeq starts at -1 for ephemeral welcome).
    // We simulate: welcome with Q1, then advance lastSeq past seq 10, then replay.
    const welcomeWithQ1: AnyFrame = {
      type: 'welcome',
      payload: {
        session: {
          session_id: 'sb_s_001',
          brief: 'test session',
          participants: [],
          decisions: [],
          questions: [
            {
              id: 'sb_q_001',
              ticket_id: 'sb_t_001',
              asked_at: '2026-01-01T00:00:10Z',
              text: 'What is Q1?',
              status: 'broadcast' as const,
              suggestions: [],
              comments: [],
              clarifications: [], // CHATAI-01
              resolution: null,
            },
          ],
          current_question: null,
          locked: false,
          session_status: 'question_open' as const,
          chat: [] as never[], // CHATAI-01 / CHAT-01
        },
        is_coordinator: false,
      },
    };
    // Ephemeral welcome seeds state with Q1 but lastSeq stays -1
    const seeded = reduce(initialState, welcomeWithQ1);
    expect(seeded.session?.questions).toHaveLength(1);
    // Replay of seq=10 question_broadcast — passes guard (seq 10 > lastSeq -1),
    // findIndex dedup updates in place instead of appending
    const replayed = reduce(seeded, q1); // q1 has seq=10
    expect(replayed.session?.questions).toHaveLength(1);
    expect(replayed.session?.questions[0]?.id).toBe('sb_q_001');
  });
});
