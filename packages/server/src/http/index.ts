import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { AddressInfo } from 'node:net';
import { buildApp } from './server.js';
import { createWsRouter } from './ws.js';
import type { SessionManager } from '../session/SessionManager.js';
import { readParticipantCookie, readCoordinatorCookie } from './cookies.js';

export interface ListenOpts {
  port: number;
  host: string;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
  /**
   * REL-09: Update the participant-cookie `Secure` flag after the transport
   * has finished starting. Used by `startSession` once the active transport's
   * `secureCookie` advisory is known (boot-order rationale: HTTP boots BEFORE
   * `transport.start()` can run because the transport needs the local port).
   */
  setSecureCookie(secure: boolean): void;
  /**
   * Phase 14 (SHARE-01): Set the participant join URL after transport resolves.
   * Mirrors setSecureCookie boot-order pattern — HTTP boots before transport
   * resolves publicUrl, so this must be called post-transport.start().
   */
  setPublicUrl(url: string): void;
}

export async function startHttpServer(args: {
  manager: SessionManager;
  listen: ListenOpts;
  staticDir?: string;
  /**
   * REL-09 / D-13 / D-16: Whether participant cookies should carry `Secure`.
   * Wired from the active transport's `TransportInfo.secureCookie` advisory.
   * Defaults to `false` (LAN-safe) when omitted. May be flipped via
   * `RunningServer.setSecureCookie()` after the transport completes start.
   */
  secureCookie?: boolean;
}): Promise<RunningServer> {
  // Mutable closure-captured value so we can flip the Secure flag after the
  // transport has resolved its advisory (the HTTP server boots first because
  // the transport needs the local port).
  let secureCookieFlag = args.secureCookie ?? false;
  const app = buildApp({
    manager: args.manager,
    secureCookie: () => secureCookieFlag,
  });
  const wsRouter = createWsRouter({ manager: args.manager });
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const pid = readParticipantCookie(c);
      // Concern #6: derive isCoordinator server-side at upgrade time by comparing
      // the sb_c cookie to the active session's coordinator token. A stale/absent
      // token (session ended) yields false rather than a thrown 500 (Pitfall 7).
      // The flag is fixed here at connect and is NEVER re-read from client frames,
      // so a participant cannot escalate by sending a hello claiming coordinator.
      const ctok = readCoordinatorCookie(c);
      let isCoordinator = false;
      try {
        isCoordinator = ctok !== null && ctok === args.manager.coordinatorToken();
      } catch {
        isCoordinator = false;
      }
      let conn: { handle: (m: unknown) => void; close: () => void } | null = null;
      // WR-04: seed replay from the `?last_seq=` query param the client appends
      // in `buildWsUrl`. Previously this param was dead (only the subsequent
      // `hello` frame drove replay), so a reconnecting client could silently
      // miss buffered events between connect and the first `hello` if that frame
      // was dropped or reordered. Honoring it here makes `onOpen` replay from the
      // requested seq; a later `hello` with `last_seq` still re-replays (the
      // client's reducer dedupes by seq), so the two paths are consistent.
      const lastSeqParam = c.req.query('last_seq');
      const parsedLastSeq = lastSeqParam !== undefined ? Number(lastSeqParam) : NaN;
      let lastSeq: number | null = Number.isInteger(parsedLastSeq) ? parsedLastSeq : null;
      return {
        async onOpen(_evt, wsCtx) {
          const connectArgs: Parameters<typeof wsRouter.connect>[0] = {
            cookieParticipantId: pid,
            isCoordinator,
            send: (s) => wsCtx.send(s),
            close: () => wsCtx.close(),
          };
          if (lastSeq !== null) connectArgs.lastSeq = lastSeq;
          const r = await wsRouter.connect(connectArgs);
          if (r.kind === 'reject') {
            wsCtx.close(1008, r.reason);
            return;
          }
          conn = r;
        },
        onMessage(evt) {
          try {
            const msg = JSON.parse(
              typeof evt.data === 'string' ? evt.data : evt.data.toString(),
            );
            if (msg && msg.type === 'hello' && typeof msg.last_seq === 'number') {
              lastSeq = msg.last_seq;
            }
            conn?.handle(msg);
          } catch {
            /* ignore malformed JSON */
          }
        },
        onClose() {
          conn?.close();
        },
      };
    }),
  );

  if (args.staticDir) {
    const { serveStatic } = await import('@hono/node-server/serve-static');
    app.use('/*', serveStatic({ root: args.staticDir }));
    app.notFound(async (c) => {
      const { readFileSync } = await import('node:fs');
      const html = readFileSync(`${args.staticDir}/index.html`, 'utf8');
      return c.html(html);
    });
  }

  const { server, addr } = await new Promise<{ server: ReturnType<typeof serve>; addr: AddressInfo }>(
    (resolve) => {
      const srv = serve(
        {
          fetch: app.fetch,
          port: args.listen.port,
          hostname: args.listen.host,
        },
        (info) => resolve({ server: srv, addr: info }),
      );
    },
  );
  injectWebSocket(server);

  args.manager.setBroadcaster((evt) => wsRouter.broadcast(evt));
  // Phase 11 (ROOM-03): presence is reported by ws.ts calling
  // manager.notifyParticipant{Connected,Disconnected} directly on every
  // non-coordinator connect/close/eviction — no callback indirection needed
  // (WR-03 removed the dead setPresenceCallbacks seam).

  const actualPort = addr.port;

  // `url` is for in-process callers (tests, MCP layer). When the server is
  // bound to the wildcard, fetching `http://0.0.0.0` is non-portable, so we
  // hand out a loopback URL while keeping `host` as the actual bind address.
  // For IPv6 binds (e.g. `::1` via SHARED_BRAINSTORM_BIND), the URL must
  // bracket the address per RFC 3986 §3.2.2.
  const clientHost = args.listen.host === '0.0.0.0' ? '127.0.0.1' : args.listen.host;
  const isIpv6 = clientHost.includes(':');
  const hostInUrl = isIpv6 ? `[${clientHost}]` : clientHost;

  return {
    url: `http://${hostInUrl}:${actualPort}`,
    host: args.listen.host,
    port: actualPort,
    close: async () => {
      wsRouter.closeAll('session_ended');
      await new Promise<void>((res) => server.close(() => res()));
    },
    setSecureCookie: (secure: boolean) => {
      secureCookieFlag = secure;
    },
    setPublicUrl: (url: string) => {
      wsRouter.setPublicUrl(url);
    },
  };
}
