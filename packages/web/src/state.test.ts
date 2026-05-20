/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { reduce, initialState } from './state.js';
import type { AnyFrame } from '@shared-brainstorm/shared';

// AnyFrame uses z.infer which produces plain `string` (not branded) for IDs

const welcomeEphemeral: AnyFrame = {
  type: 'welcome',
  payload: {
    session: {
      session_id: 'sb_s_001',
      brief: 'test session',
      participants: [
        { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z' },
      ],
      decisions: [],
      current_question: null,
    },
    you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z' },
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
    current_question: null,
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
      you: { id: 'sb_p_001', display_name: 'Alice', joined_at: '2026-01-01T00:00:00Z' },
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
      payload: { session: sessionShape, is_coordinator: true },
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
        resolution: null,
      },
    },
  };

  it('sets current_question on question_broadcast', () => {
    const next = reduce(baseState, broadcastEvt);
    expect(next.session?.current_question?.id).toBe('sb_q_001');
    expect(next.lastSeq).toBe(3);
  });

  it('marks question cancelled on question_cancelled', () => {
    const withQ = reduce(baseState, broadcastEvt);
    const cancelEvt: AnyFrame = {
      seq: 4,
      ts: '2026-01-01T00:00:04Z',
      type: 'question_cancelled',
      payload: { question_id: 'sb_q_001', reason: 'timeout' },
    };
    const next = reduce(withQ, cancelEvt);
    expect(next.session?.current_question?.status).toBe('cancelled');
  });
});
