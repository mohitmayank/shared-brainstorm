import { useReducer, useCallback, useEffect, useRef, useState } from 'react';
import { reduce, initialState } from './state.js';
import type { PresenceExpireAction } from './state.js';
import {
  getName,
  setName,
  getLastSeq,
  setLastSeq,
  getTheme,
  setTheme,
  type Theme,
} from './lib/storage.js';
import { join, postCoordinatorJoin } from './lib/api.js';
import { connectWs } from './lib/ws.js';
import type { WsHandle, CloseInfo } from './lib/ws.js';
import { nextBackoffMs, type BackoffOpts } from './lib/backoff.js';
import { planPresenceTimer, type PresenceTimerPlan } from './lib/presenceTimers.js';
import type { AnyFrame } from '@shared-brainstorm/shared';
import { Join } from './pages/Join.js';
import { Session } from './pages/Session.js';
import { Coordinator } from './pages/Coordinator.js';
import { TunnelBanner } from './components/TunnelBanner.js';
import { TransportFailedBanner } from './components/TransportFailedBanner.js';

/**
 * COORD-01: parse `?role=coordinator&token=X` once at module evaluation so the
 * mount-time effect can branch into the coordinator-join flow (validate the
 * token, then open the WS) instead of the participant resume flow. Returns the
 * token only when the role is explicitly `coordinator` and a non-empty token is
 * present — otherwise the app behaves exactly as the participant build does.
 */
function readCoordinatorToken(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get('role') !== 'coordinator') return null;
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

/** Local finite-state for the coordinator-join handshake (UI-SPEC States). */
type CoordinatorStatus = 'validating' | 'invalid' | 'ok';

function buildWsUrl(lastSeq: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws`;
  return lastSeq >= 0 ? `${base}?last_seq=${lastSeq}` : base;
}

// not_joined comes through as a policy-violation close (code 1008). We use it
// as the signal to drop back to the Join page instead of auto-reconnecting.
const NOT_JOINED_CODE = 1008;

/**
 * CR-02: classify a 1008 close reason into one of three categories:
 *  - 'removed'   — participant was kicked; show removed screen, do NOT auto-join
 *  - 'not_joined' — cookie absent/stale; may auto-join with remembered name
 *  - 'unknown'   — fail-safe: show Join form, do NOT auto-join (ambiguous)
 *
 * Exported for unit testing — this is the sole source of truth for close-reason
 * routing. App.tsx `onClose` calls this rather than inlining the comparison so
 * the branching logic can be verified without a React rendering harness.
 */
export function classifyCloseReason(reason: string): 'removed' | 'not_joined' | 'unknown' {
  if (reason === 'removed') return 'removed';
  if (reason === 'not_joined') return 'not_joined';
  return 'unknown';
}

// Show the "Try now" inline prompt after this many consecutive WS close-without-
// welcome cycles (REL-04 / D-19). No retry cap — the loop continues at the 30s
// backoff ceiling indefinitely; the prompt is purely advisory.
const RETRY_PROMPT_THRESHOLD = 5;

/**
 * DEV-only test escape hatch — gated by `import.meta.env.DEV`; tree-shaken in
 * prod builds. When the URL contains `?fast_backoff=1` in a dev build the
 * reconnect schedule collapses to ~50–100ms per attempt so Playwright specs
 * can exercise the "5 failures then Try now" path without a 30-second wait.
 * The default (and the entire prod bundle) uses the D-18 schedule via
 * `nextBackoffMs`'s built-in defaults.
 */
function resolveBackoffOpts(): BackoffOpts | undefined {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fast_backoff') === '1') {
      return { baseMs: 50, capMs: 100 };
    }
  }
  return undefined;
}

function initialTheme(): Theme {
  const saved = getTheme();
  if (saved) return saved;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function App() {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  // Apply theme to <html data-theme=…>. CSS variables in :root[data-theme]
  // do the rest.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const [state, dispatch] = useReducer(reduce, initialState);
  const wsRef = useRef<WsHandle | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase 5 (PRES-02): per-actor presence expiry timers. Keyed by actor_id or
  // '__coordinator'. Mirrors the fallbackTimers pattern in Coordinator.tsx.
  const presenceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // WR-01 fix: track the latest activity per presence key, written synchronously in
  // the same onEvent pass. The idle branch consults this (NOT stale `state`, since
  // startWs is useCallback([])) to avoid cancelling the 6s 'submitted' timer when a
  // trailing typing-stop idle frame arrives AFTER suggestion_added (frame Ordering B).
  const presenceActivity = useRef<Map<string, 'typing' | 'picking' | 'submitted'>>(new Map());

  // Apply a pure PresenceTimerPlan (from planPresenceTimer) to the timer + activity
  // refs. All deps are stable (refs + dispatch), so this is safe to reference inside
  // the startWs useCallback([]) closure. The decision logic itself lives in the pure,
  // unit-tested lib/presenceTimers module (WR-01 regression guard).
  const applyPresenceTimerPlan = useCallback((plan: PresenceTimerPlan): void => {
    if (plan.clearTimerKey !== null) {
      const existing = presenceTimers.current.get(plan.clearTimerKey);
      if (existing !== undefined) {
        clearTimeout(existing);
        presenceTimers.current.delete(plan.clearTimerKey);
      }
    }
    if (plan.deleteActivity !== null) presenceActivity.current.delete(plan.deleteActivity);
    if (plan.setActivity !== null) {
      presenceActivity.current.set(plan.setActivity.key, plan.setActivity.activity);
    }
    if (plan.setTimer !== null) {
      const { key, ttlMs } = plan.setTimer;
      presenceTimers.current.set(
        key,
        setTimeout(() => {
          presenceTimers.current.delete(key);
          presenceActivity.current.delete(key);
          dispatch({ type: 'presence_expired', key } satisfies PresenceExpireAction);
        }, ttlMs),
      );
    }
  }, []);
  // WR-03: true while the WS socket is open. Passed to ChatPanel as `connected`
  // so the Send affordance is gated on connectivity — a message typed while
  // disconnected would otherwise be silently dropped by the optional-chaining
  // wsRef.current?.send() call. Reset to false on every onClose callback;
  // set to true on every successful `welcome` event (which only fires while
  // the socket is open and the server has accepted the handshake).
  const [wsConnected, setWsConnected] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  // True when the server returned 423 (coordinator locked the room).
  const [joinLocked, setJoinLocked] = useState(false);
  // On first mount we optimistically attempt to resume via the existing
  // participant cookie. While we wait for either welcome or a not_joined
  // close, we don't want to flash the Join form.
  const [resuming, setResuming] = useState(true);
  const [needsJoin, setNeedsJoin] = useState(false);
  // CR-02: set when the server closes with 1008 / 'removed' (kicked participant
  // reload path). The reducer's myStatus field covers the live-kick path
  // (participant_status_changed arrives before WS close), but on a page reload
  // reducer state is initialState (myStatus === null) and the WS upgrade is
  // rejected before any welcome can set it. This local flag bridges the gap:
  // the removed screen is reachable from BOTH the live-kick and the reload path.
  const [wasKicked, setWasKicked] = useState(false);

  // COORD-01: coordinator-mode is fixed at mount from the URL. When present we
  // never show the participant Join form — instead we validate the token and
  // (on success) open the WS. `coordinatorStatus` drives the Validating /
  // Token-invalid surfaces (UI-SPEC States table).
  const coordinatorTokenRef = useRef<string | null>(readCoordinatorToken());
  const coordinatorMode = coordinatorTokenRef.current !== null;
  const [coordinatorStatus, setCoordinatorStatus] = useState<CoordinatorStatus>('validating');
  const [coordinatorInvalidMsg, setCoordinatorInvalidMsg] = useState<{
    heading: string;
    body: string;
  }>({
    heading: 'Coordinator link is invalid or expired.',
    body: 'Ask the session host to share a new link.',
  });

  // REL-04 / D-19: count of consecutive close-without-welcome cycles. Drives
  // the exponential backoff schedule and the "Try now" advisory prompt after
  // 5 failures. Reset to 0 on every `welcome` event (successful WS handshake).
  const [wsRetryCount, setWsRetryCount] = useState<number>(0);
  // Mirror in a ref so the `onClose` closure (captured at WS-connect time)
  // can read the *current* count without re-creating `startWs` on every state
  // change (which would churn the mount-time `useEffect`).
  const wsRetryCountRef = useRef<number>(0);
  useEffect(() => {
    wsRetryCountRef.current = wsRetryCount;
  }, [wsRetryCount]);

  // Phase 5 (PRES-02): clear all presence expiry timers on unmount.
  useEffect(() => {
    const timers = presenceTimers.current;
    const activity = presenceActivity.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
      activity.clear();
    };
  }, []);

  // WR-02 fix: also sweep all presence timers on terminal session status ('done').
  // The App is long-lived across session_ended → 'done'; timers for participants
  // who already left (or for '__coordinator') would otherwise fire up to 6s later
  // and dispatch presence_expired against an already-closed session, momentarily
  // mutating presence after the session ended. Clear proactively when done.
  useEffect(() => {
    if (state.sessionStatus === 'done') {
      for (const h of presenceTimers.current.values()) clearTimeout(h);
      presenceTimers.current.clear();
      presenceActivity.current.clear();
    }
  }, [state.sessionStatus]);

  // Phase 5 (PRES-02): send typing activity command to server.
  const sendTyping = useCallback((questionId: string, typingState: 'start' | 'stop') => {
    wsRef.current?.send(JSON.stringify({ type: 'typing', question_id: questionId, state: typingState }));
  }, []);

  // Phase 5 (PRES-03): send picking activity command to server.
  const sendPicking = useCallback((ticketId: string, pickingState: 'start' | 'stop') => {
    wsRef.current?.send(JSON.stringify({ type: 'picking', ticket_id: ticketId, state: pickingState }));
  }, []);

  // CHATAI-01: send post_clarification WS command from participant view.
  const sendAsk = useCallback((questionId: string, text: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'post_clarification', question_id: questionId, text }));
  }, []);

  // CHAT-01: send post_chat WS command from both participant and coordinator views.
  const sendChat = useCallback((text: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'post_chat', text }));
  }, []);

  // REL-05 / D-20: tracks the URL the user last clicked dismiss on. Pitfall 3:
  // a new `tunnel_url_changed` with a *different* URL replaces
  // `state.tunnelBanner.url`, and the equality check below no longer holds,
  // so the banner naturally reappears without any reducer changes.
  const [dismissedTunnelUrl, setDismissedTunnelUrl] = useState<string | null>(null);
  const [transportFailedDismissed, setTransportFailedDismissed] = useState<boolean>(false);

  const startWsRef = useRef<(lastSeq: number) => void>(() => undefined);
  // CR-01: mirror joinLocked into a ref so the onClose closure (captured at
  // WS-connect time) can read the *current* lock state without re-creating
  // startWs on every joinLocked state change.
  const joinLockedRef = useRef<boolean>(false);
  useEffect(() => {
    joinLockedRef.current = joinLocked;
  }, [joinLocked]);
  // CR-01: ref to handleJoin so the onClose closure can trigger a fresh join
  // without depending on handleJoin in the startWs useCallback dep array.
  const handleJoinRef = useRef<(name: string) => Promise<void>>(() => Promise.resolve());
  // CR-02: mirror wasKicked into a ref so the onClose closure can check it.
  // Once the removed screen is shown we must not auto-join on subsequent
  // reconnect attempts (the 1008/'removed' gate ensures we never get a welcome,
  // but the backoff loop must also stop).
  const wasKickedRef = useRef<boolean>(false);
  useEffect(() => {
    wasKickedRef.current = wasKicked;
  }, [wasKicked]);

  const startWs = useCallback((lastSeq: number) => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (reconnectTimer.current !== null) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    const handle = connectWs({
      url: buildWsUrl(lastSeq),
      lastSeq,
      onEvent: (frame: AnyFrame) => {
        dispatch(frame);
        if ('seq' in frame) setLastSeq(frame.seq);
        if (frame.type === 'welcome') {
          // Resume succeeded (or join's first connect succeeded). The WS is
          // healthy again — reset the retry counter so the next disconnect
          // restarts the backoff schedule from attempt 0 (REL-04 / D-19).
          setResuming(false);
          setNeedsJoin(false);
          setWsRetryCount(0);
          wsRetryCountRef.current = 0;
          // WR-03: mark socket as connected so ChatPanel enables the Send affordance.
          setWsConnected(true);
        }
        // Phase 5 (PRES-02): schedule TTL sweeps for ephemeral presence frames.
        // Narrow through `as unknown` to access presence payload — AnyFrame is a
        // union of two discriminated unions, and TypeScript cannot pierce both at once.
        if (frame.type === 'presence') {
          const presenceFrame = frame as unknown as Extract<
            import('@shared-brainstorm/shared').EphemeralFrame,
            { type: 'presence' }
          >;
          const key = presenceFrame.payload.actor_id ?? '__coordinator';
          applyPresenceTimerPlan(
            planPresenceTimer(
              { kind: 'presence', key, activity: presenceFrame.payload.activity },
              presenceActivity.current.get(key),
            ),
          );
        }
        // Phase 5 (PRES-02): schedule TTL for "submitted" presence derived from durable events.
        if (frame.type === 'suggestion_added' || frame.type === 'suggestion_updated') {
          const participantId = (
            frame as unknown as { payload: { suggestion: { participant_id: string } } }
          ).payload.suggestion.participant_id;
          applyPresenceTimerPlan(
            planPresenceTimer(
              { kind: 'submitted', key: participantId },
              presenceActivity.current.get(participantId),
            ),
          );
        }
      },
      onClose: (info: CloseInfo) => {
        wsRef.current = null;
        // WR-03: socket is no longer open — disable ChatPanel Send affordance
        // immediately so any in-progress compose is not silently dropped.
        setWsConnected(false);
        if (info.code === NOT_JOINED_CODE) {
          if (coordinatorMode) {
            // UI-SPEC: a coordinator whose sb_c cookie is rejected (1008) must
            // NOT drop to the participant Join form — show the coordinator-error
            // card with coordinator-specific copy instead.
            setResuming(false);
            setCoordinatorInvalidMsg({
              heading: 'Coordinator session ended — request a new link.',
              body: 'Ask the session host to share a new link.',
            });
            setCoordinatorStatus('invalid');
            return;
          }
          // CR-02: branch on close reason to prevent kick-evasion on reload.
          // The server sends distinct reason strings for each rejection cause:
          //   'removed'   — participant was kicked; must NOT auto-rejoin
          //   'not_joined' — no valid cookie; may auto-join with remembered name
          //   (unknown/empty) — treat as terminal; do NOT auto-join (fail-safe)
          const closeClass = classifyCloseReason(info.reason);
          if (closeClass === 'removed') {
            // Kicked participant reload path: the WS upgrade is rejected before
            // any welcome arrives, so the reducer's myStatus is still null on
            // reload. Set a dedicated local flag to surface the removed screen
            // without depending on a welcome that will never arrive.
            setResuming(false);
            setWasKicked(true);
            wasKickedRef.current = true;
            return;
          }
          if (closeClass === 'unknown') {
            // Unknown/empty reason on a 1008 close — fail-safe: show the Join
            // form rather than silently re-admitting. A coordinator-kicked user
            // with a stale reason string is better served by seeing the form
            // (where they can learn they need to re-ask) than being auto-admitted.
            setResuming(false);
            setNeedsJoin(true);
            return;
          }
          // closeClass === 'not_joined': cookie was missing/stale — try the
          // remembered name first (CR-01: only auto-join when there is genuinely
          // no server-recognized identity; never re-POST if a valid sb_p cookie
          // already exists).
          const remembered = getName();
          if (remembered && !joinLockedRef.current) {
            void handleJoinRef.current(remembered);
          } else {
            setResuming(false);
            setNeedsJoin(true);
          }
          return;
        }
        // Transient close: schedule a reconnect with exponential backoff
        // (REL-04 / D-18). Read attempt count from the ref so we observe the
        // current value rather than the one captured at `startWs` time.
        const attempt = wsRetryCountRef.current;
        const delay = nextBackoffMs(attempt, resolveBackoffOpts());
        reconnectTimer.current = setTimeout(() => {
          // Increment BEFORE issuing the reconnect so a follow-up close at the
          // same level of failure sees the bumped counter. The functional
          // updater keeps the ref-mirror useEffect honest.
          setWsRetryCount((n) => n + 1);
          startWsRef.current(getLastSeq());
        }, delay);
      },
    });
    wsRef.current = handle;
    // Both deps are referentially stable — `applyPresenceTimerPlan` is a
    // useCallback([]) reading only refs, and `coordinatorMode` is fixed at mount
    // — so listing them keeps the rule honest without recreating the socket
    // closure on every render (the ref-mirror pattern is preserved).
  }, [applyPresenceTimerPlan, coordinatorMode]);

  startWsRef.current = startWs;

  const handleTryNow = useCallback(() => {
    // REL-04 / D-19: user-initiated retry. Reset the counter so the advisory
    // prompt disappears and the next backoff cycle starts from attempt 0.
    setWsRetryCount(0);
    wsRetryCountRef.current = 0;
    if (reconnectTimer.current !== null) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    startWsRef.current(getLastSeq());
  }, []);

  // On mount: either run the coordinator-join handshake (COORD-01) or the
  // participant resume flow. For a coordinator we validate the token first and
  // open the WS only on success — there is no Join form fallback. For a
  // participant we optimistically resume; a stale cookie yields a 1008 close
  // that drops to the Join form.
  useEffect(() => {
    if (coordinatorMode) {
      let cancelled = false;
      const token = coordinatorTokenRef.current!;
      // Pitfall 8: the join response sets the sb_c cookie synchronously, so we
      // open the WS immediately on success — no setTimeout between join and WS.
      postCoordinatorJoin(token)
        .then(() => {
          if (cancelled) return;
          setCoordinatorStatus('ok');
          startWs(getLastSeq());
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          const status = (e as { status?: number }).status;
          if (status === 404) {
            // Pitfall 7 / RESEARCH: distinct copy for an ended session vs a
            // genuinely bad token.
            setCoordinatorInvalidMsg({
              heading: 'Session ended.',
              body: 'Ask the session host to share a new link.',
            });
          }
          setCoordinatorStatus('invalid');
        });
      return () => {
        cancelled = true;
        if (wsRef.current) wsRef.current.close();
        if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
      };
    }
    // CR-01 fix: always attempt cookie-based resume first. If the sb_p cookie is
    // valid the WS succeeds and the welcome event lands. If the cookie is absent
    // or stale the server closes with 1008 (NOT_JOINED_CODE) and the onClose
    // handler below tries the remembered name (first-ever join). This preserves
    // the identity of an already-approved participant across page reloads —
    // unconditionally POST-ing /api/join would mint a new id and demote them back
    // to pending (JOIN-05 violation fixed here).
    startWs(getLastSeq());
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoin = useCallback(
    async (name: string) => {
      setJoinError(null);
      setJoinLocked(false);
      try {
        await join({ display_name: name });
        setName(name);
        // WR-02: a successful /api/join creates a brand-new participant identity.
        // Any previously persisted last_seq belongs to a prior session or a prior
        // identity in the same session. Reset it so the WS ?last_seq= query param
        // starts from -1 (no replay watermark) — a new participant has no prior
        // replay history and the WR-07 monotonic guard must not drop the new
        // session's low-seq events.
        setLastSeq(-1);
        setNeedsJoin(false);
        startWs(getLastSeq());
      } catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 423) {
          setJoinLocked(true);
        } else {
          setJoinError(String(e));
        }
      }
    },
    [startWs],
  );

  // CR-01: keep the handleJoinRef in sync with the latest handleJoin callback
  // so the onClose closure (captured at WS-connect time) always calls the
  // current version without startWs needing handleJoin in its dep array.
  handleJoinRef.current = handleJoin;

  // Phase 4: approved participants only. Pending participants have me set but must
  // see the waiting screen, not the session — require myStatus === 'approved'.
  const hasSession =
    state.session !== null && state.me !== null && state.myStatus === 'approved';
  // COORD-01: coordinators connect with no participant identity (me === null),
  // so the participant `hasSession` gate above can never be true for them. Branch
  // on the server-derived `isCoordinator` flag + a live session instead.
  const isCoordinatorView = state.session !== null && state.isCoordinator;

  return (
    <>
      <div className="app-header">
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? '☀ Light' : '☾ Dark'}
        </button>
      </div>
      {state.banner && (
        <div className="banner" role="status">
          {state.banner}
        </div>
      )}
      {state.tunnelBanner !== null && dismissedTunnelUrl !== state.tunnelBanner.url && (
        <TunnelBanner
          url={state.tunnelBanner.url}
          onDismiss={() => {
            // Pitfall 3 (D-20): record the dismissed URL so the banner stays
            // hidden for *this* URL only. A future `tunnel_url_changed` event
            // with a different URL updates `state.tunnelBanner.url`, breaking
            // the equality check and re-showing the banner.
            if (state.tunnelBanner !== null) {
              setDismissedTunnelUrl(state.tunnelBanner.url);
            }
          }}
        />
      )}
      {state.transportFailed !== null && !transportFailedDismissed && (
        <TransportFailedBanner
          message={state.transportFailed.message}
          restartCount={state.transportFailed.restart_count}
          onDismiss={() => setTransportFailedDismissed(true)}
        />
      )}
      {wsRetryCount >= RETRY_PROMPT_THRESHOLD && (
        <div className="reconnect-prompt" role="status">
          Having trouble reconnecting —{' '}
          <button type="button" className="reconnect-prompt-try" onClick={handleTryNow}>
            Try now
          </button>
        </div>
      )}
      {isCoordinatorView ? (
        <Coordinator
          session={state.session!}
          isCoordinator
          roomLocked={state.roomLocked}
          sessionStatus={state.sessionStatus}
          onPicking={sendPicking}
          onChat={sendChat}
          wsConnected={wsConnected}
          idleNudge={state.idleNudge}
          roomEmpty={state.roomEmpty}
          publicUrl={state.publicUrl}
        />
      ) : coordinatorMode && coordinatorStatus === 'invalid' ? (
        <div className="card coordinator-error" data-testid="coordinator-error" role="alert">
          <h1>{coordinatorInvalidMsg.heading}</h1>
          <p className="muted">{coordinatorInvalidMsg.body}</p>
        </div>
      ) : coordinatorMode ? (
        <div className="card" style={{ marginTop: '2rem' }}>
          <p className="muted">Validating coordinator link…</p>
        </div>
      ) : (state.myStatus === 'kicked' || wasKicked) ? (
        // CR-02: show removed screen for BOTH paths:
        //  1. Live kick: server broadcasts participant_status_changed{status:'kicked'} BEFORE
        //     closing the WS — reducer sets myStatus='kicked' which persists across reconnects.
        //  2. Reload after kick: WS upgrade is rejected (1008/'removed') before any welcome
        //     arrives; the reducer is at initialState (myStatus===null). The wasKicked local
        //     state flag bridges this gap so the removed screen is still shown.
        <div className="card" style={{ marginTop: '2rem' }} data-testid="join-removed" role="alert">
          <h1>You were removed from this session</h1>
          <p className="muted">
            The host has removed you from this brainstorm. You can close this tab.
          </p>
        </div>
      ) : state.myStatus === 'pending' ? (
        <div className="join-waiting card" style={{ marginTop: '2rem' }} data-testid="join-waiting">
          <h1>Waiting for approval</h1>
          <p className="muted">
            Your request to join is with the host. You'll be let in as soon as they approve — keep
            this tab open.
          </p>
          <span className="join-connected-dot" />
          <span className="muted">Connected</span>
        </div>
      ) : joinLocked ? (
        <div className="card" style={{ marginTop: '2rem' }} data-testid="join-locked">
          <div className="banner" role="status">
            <h1>This session is locked</h1>
            <p className="muted">
              The host has closed this brainstorm to new participants. Ask them to unlock it if
              you'd like to join.
            </p>
          </div>
        </div>
      ) : hasSession ? (
        <Session
          session={state.session!}
          me={state.me!}
          sessionStatus={state.sessionStatus}
          presence={state.presence}
          myStatus={state.myStatus}
          onTyping={sendTyping}
          onAsk={sendAsk}
          onChat={sendChat}
          wsConnected={wsConnected}
        />
      ) : resuming && !needsJoin ? (
        <div className="card" style={{ marginTop: '2rem' }}>
          <p className="muted">Connecting…</p>
        </div>
      ) : (
        <Join
          defaultName={getName() ?? ''}
          onSubmit={handleJoin}
          error={joinError}
        />
      )}
      <footer className="app-footer">
        Enjoying shared-brainstorm? Star, fork or contribute at{' '}
        <a
          href="https://github.com/mohitmayank/shared-brainstorm"
          target="_blank"
          rel="noreferrer noopener"
        >
          github.com/mohitmayank/shared-brainstorm
        </a>
        .
      </footer>
    </>
  );
}
