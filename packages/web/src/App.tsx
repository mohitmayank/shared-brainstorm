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
import type { AnyFrame } from '@shared-brainstorm/shared';
import { Join } from './pages/Join.js';
import { Session } from './pages/Session.js';

function buildWsUrl(lastSeq: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${proto}//${window.location.host}/ws`;
  return lastSeq >= 0 ? `${base}?last_seq=${lastSeq}` : base;
}

// not_joined comes through as a policy-violation close (code 1008). We use it
// as the signal to drop back to the Join page instead of auto-reconnecting.
const NOT_JOINED_CODE = 1008;

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
          // Resume succeeded (or join's first connect succeeded).
          setResuming(false);
          setNeedsJoin(false);
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
        // Transient close: schedule a reconnect.
        reconnectTimer.current = setTimeout(() => {
          startWsRef.current(getLastSeq());
        }, 1500);
      },
    });
    wsRef.current = handle;
  }, []);

  startWsRef.current = startWs;

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
