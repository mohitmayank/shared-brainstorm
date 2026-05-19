import { useReducer, useCallback, useEffect, useRef, useState } from 'react';
import { reduce, initialState } from './state.js';
import {
  getName,
  setName,
  getJoinCode,
  setJoinCode,
  getLastSeq,
  setLastSeq,
  getTheme,
  setTheme,
  type Theme,
} from './lib/storage.js';
import { join } from './lib/api.js';
import { connectWs } from './lib/ws.js';
import type { WsHandle, CloseInfo } from './lib/ws.js';
import { nextBackoffMs, type BackoffOpts } from './lib/backoff.js';
import type { AnyFrame } from '@shared-brainstorm/shared';
import { Join } from './pages/Join.js';
import { Session } from './pages/Session.js';
import { TunnelBanner } from './components/TunnelBanner.js';

function buildWsUrl(lastSeq: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws`;
  return lastSeq >= 0 ? `${base}?last_seq=${lastSeq}` : base;
}

// not_joined comes through as a policy-violation close (code 1008). We use it
// as the signal to drop back to the Join page instead of auto-reconnecting.
const NOT_JOINED_CODE = 1008;

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
  const [joinError, setJoinError] = useState<string | null>(null);
  // On first mount we optimistically attempt to resume via the existing
  // participant cookie. While we wait for either welcome or a not_joined
  // close, we don't want to flash the Join form.
  const [resuming, setResuming] = useState(true);
  const [needsJoin, setNeedsJoin] = useState(false);

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

  // REL-05 / D-20: tracks the URL the user last clicked dismiss on. Pitfall 3:
  // a new `tunnel_url_changed` with a *different* URL replaces
  // `state.tunnelBanner.url`, and the equality check below no longer holds,
  // so the banner naturally reappears without any reducer changes.
  const [dismissedTunnelUrl, setDismissedTunnelUrl] = useState<string | null>(null);

  const startWsRef = useRef<(lastSeq: number) => void>(() => undefined);

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
        }
      },
      onClose: (info: CloseInfo) => {
        wsRef.current = null;
        if (info.code === NOT_JOINED_CODE) {
          // Cookie was missing/stale — fall back to the Join form.
          setResuming(false);
          setNeedsJoin(true);
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
  }, []);

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

  // Try to resume on mount. If there's no cookie / it's stale, the WS will
  // reject with code 1008 and we'll show the Join form.
  useEffect(() => {
    startWs(getLastSeq());
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current !== null) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoin = useCallback(
    async (name: string, code: string) => {
      setJoinError(null);
      try {
        await join({ display_name: name, join_code: code });
        setName(name);
        setJoinCode(code);
        setNeedsJoin(false);
        startWs(getLastSeq());
      } catch (e) {
        setJoinError(String(e));
      }
    },
    [startWs],
  );

  const hasSession = state.session !== null && state.me !== null;

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
      {wsRetryCount >= RETRY_PROMPT_THRESHOLD && (
        <div className="reconnect-prompt" role="status">
          Having trouble reconnecting —{' '}
          <button type="button" className="reconnect-prompt-try" onClick={handleTryNow}>
            Try now
          </button>
        </div>
      )}
      {hasSession ? (
        <Session session={state.session!} me={state.me!} />
      ) : resuming && !needsJoin ? (
        <div className="card" style={{ marginTop: '2rem' }}>
          <p className="muted">Connecting…</p>
        </div>
      ) : (
        <Join
          defaultName={getName() ?? ''}
          defaultCode={getJoinCode() ?? ''}
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
