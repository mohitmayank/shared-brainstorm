import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import type { AddressInfo } from 'node:net';
import { buildApp } from './server.js';
import { createWsRouter } from './ws.js';
import type { SessionManager } from '../session/SessionManager.js';
import { readParticipantCookie } from './cookies.js';

export interface ListenOpts {
  port: number;
  host: string;
}

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(args: {
  manager: SessionManager;
  listen: ListenOpts;
  staticDir?: string;
}): Promise<RunningServer> {
  const app = buildApp({ manager: args.manager });
  const wsRouter = createWsRouter({ manager: args.manager });
  const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const pid = readParticipantCookie(c);
      let conn: { handle: (m: unknown) => void; close: () => void } | null = null;
      let lastSeq: number | null = null;
      return {
        async onOpen(_evt, wsCtx) {
          const connectArgs: Parameters<typeof wsRouter.connect>[0] = {
            cookieParticipantId: pid,
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

  const actualPort = addr.port;

  // `url` is for in-process callers (tests, MCP layer). When the server is
  // bound to the wildcard, fetching `http://0.0.0.0` is non-portable, so we
  // hand out a loopback URL while keeping `host` as the actual bind address.
  const clientHost = args.listen.host === '0.0.0.0' ? '127.0.0.1' : args.listen.host;

  return {
    url: `http://${clientHost}:${actualPort}`,
    host: args.listen.host,
    port: actualPort,
    close: async () => {
      wsRouter.closeAll('session_ended');
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
