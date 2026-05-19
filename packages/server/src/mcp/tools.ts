import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StartSessionInput,
  AskGroupInput,
  AskGroupOutput,
  AwaitAnswerInput,
  AwaitAnswerOutput,
  RecordAnswerInput,
  RecordAnswerOutput,
  StopSessionOutput,
} from '@shared-brainstorm/shared';
import type { QuestionId } from '@shared-brainstorm/shared';
import { SessionManager } from '../session/SessionManager.js';
import { realClock } from '../session/clock.js';
import { startHttpServer } from '../http/index.js';
import { redactQuestion } from '../redact/redact.js';
import type { Transport, TransportInfo, TransportLocal } from '../transport/Transport.js';
import { selectTransport as defaultSelectTransport } from '../transport/selectTransport.js';
import { copyToClipboard as defaultCopyToClipboard } from '../util/clipboard.js';
import { isTruthyEnv } from '../util/env.js';
import { mcpState } from './state.js';

function buildInviteText(publicUrl: string, joinCode: string): string {
  return [
    "Hi! I'm running a quick team brainstorm — would love your input.",
    '',
    `Join: ${publicUrl}`,
    `Join code: ${joinCode}`,
    '',
    'Powered by shared-brainstorm.',
  ].join('\n');
}

/**
 * Locate the built web SPA. Packaged installs ship it at `dist/public/`
 * (assembled by scripts/prepack.mjs). Monorepo/dev installs hit one of the
 * sibling fallbacks. Returns undefined if none exist — startHttpServer then
 * skips the static middleware and the browser sees 404s, which is loud
 * enough to debug.
 */
function resolveStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, 'public'), // packaged: packages/server/dist/public
    resolve(here, '../../web/dist'), // bundled dev: from packages/server/dist
    resolve(here, '../../../web/dist'), // tsx dev: from packages/server/src/mcp
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// MockTransport — used in tests when opts.transportFactory === 'mock'
// ---------------------------------------------------------------------------

class MockTransport implements Transport {
  private urlChangeCb: ((newUrl: string) => void) | null = null;

  async start(local: TransportLocal): Promise<TransportInfo> {
    return {
      publicUrl: `http://${local.host}:${local.port}`,
      kind: 'mock' as const,
    };
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  onUrlChange(cb: (newUrl: string) => void): void {
    this.urlChangeCb = cb;
  }

  /** Expose stored callback (for tests). */
  _getUrlChangeCb(): ((newUrl: string) => void) | null {
    return this.urlChangeCb;
  }
}

// ---------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------

export interface StartSessionOpts {
  /**
   * - `'mock'`         → in-process MockTransport (tests only)
   * - `'lan'`          → force LanTransport
   * - `'cloudflared'`  → force locally-installed cloudflared
   * - `'npx-cloudflared'` → force `npx --yes cloudflared`
   * - omitted          → call `selectTransport()` and pick best available
   */
  transportFactory?: 'mock' | 'lan' | 'cloudflared' | 'npx-cloudflared';
  transcriptDir?: string;
  /** Injectable for tests; defaults to the real selectTransport(). */
  selectTransport?: typeof defaultSelectTransport;
  /** Override SPA dir resolution (tests only). `null` disables static serving. */
  staticDir?: string | null;
  /** Injectable for tests; defaults to the real OS clipboard helper. */
  copyToClipboard?: typeof defaultCopyToClipboard;
}

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

export async function startSession(
  raw: unknown,
  opts?: StartSessionOpts,
): Promise<{
  session_id: string;
  public_url: string;
  join_code: string;
  invite_text: string;
  clipboard_copied: boolean;
}> {
  if (mcpState.manager !== null) {
    throw new Error('A session is already active. Call stopSession first.');
  }

  const input = StartSessionInput.parse(raw);

  const transcriptDir =
    opts?.transcriptDir ?? join(homedir(), '.shared-brainstorm', 'sessions');

  const manager = new SessionManager({
    clock: realClock,
    transcriptDir,
  });

  const { session_id, join_code } = manager.start({ brief: input.brief });

  // Boot HTTP server on a random port. Bind the wildcard so LanTransport can
  // resolve a real LAN IP (binding to 127.0.0.1 short-circuits pickReachableIp).
  const staticDir =
    opts?.staticDir === null
      ? undefined
      : (opts?.staticDir ?? resolveStaticDir());
  const httpArgs: Parameters<typeof startHttpServer>[0] = {
    manager,
    listen: { port: 0, host: '0.0.0.0' },
  };
  if (staticDir) httpArgs.staticDir = staticDir;
  const http = await startHttpServer(httpArgs);

  const local: TransportLocal = { host: http.host, port: http.port };

  const select = opts?.selectTransport ?? defaultSelectTransport;
  let transport: Transport;
  if (opts?.transportFactory === 'mock') {
    transport = new MockTransport();
  } else {
    const selectOpts: Parameters<typeof select>[0] = {};
    if (opts?.transportFactory) selectOpts.prefer = opts.transportFactory;
    transport = await select(selectOpts);
  }

  const transportInfo = await transport.start(local);
  const publicUrl = transportInfo.publicUrl;

  // Wire URL-change callback so transport can update mcpState.publicUrl
  transport.onUrlChange((newUrl) => {
    mcpState.publicUrl = newUrl;
    manager.emitExternal({
      type: 'tunnel_url_changed',
      payload: { public_url: newUrl },
    });
  });

  // Commit to mcpState
  mcpState.manager = manager;
  mcpState.transport = transport;
  mcpState.http = http;
  mcpState.publicUrl = publicUrl;

  const invite_text = buildInviteText(publicUrl, join_code);
  const clipboardDisabled = isTruthyEnv(process.env['SHARED_BRAINSTORM_NO_CLIPBOARD']);
  const copy = opts?.copyToClipboard ?? defaultCopyToClipboard;
  const clipboard_copied = clipboardDisabled
    ? false
    : (await copy(invite_text).catch(() => null)) !== null;

  return {
    session_id,
    public_url: publicUrl,
    join_code,
    invite_text,
    clipboard_copied,
  };
}

// ---------------------------------------------------------------------------
// askGroup
// ---------------------------------------------------------------------------

export function askGroup(raw: unknown): AskGroupOutput {
  if (!mcpState.manager) throw new Error('No active session. Call startSession first.');

  const input = AskGroupInput.parse(raw);
  const redacted = redactQuestion(input);
  const result = mcpState.manager.askGroup(redacted);
  return AskGroupOutput.parse(result);
}

// ---------------------------------------------------------------------------
// awaitAnswer
// ---------------------------------------------------------------------------

export async function awaitAnswer(raw: unknown): Promise<AwaitAnswerOutput> {
  if (!mcpState.manager) throw new Error('No active session. Call startSession first.');

  const input = AwaitAnswerInput.parse(raw);
  const result = await mcpState.manager.awaitAnswer(input);
  return AwaitAnswerOutput.parse(result);
}

// ---------------------------------------------------------------------------
// recordAnswer
// ---------------------------------------------------------------------------

export function recordAnswer(raw: unknown): RecordAnswerOutput {
  if (!mcpState.manager) throw new Error('No active session. Call startSession first.');
  const input = RecordAnswerInput.parse(raw);
  const mgr = mcpState.manager;
  const view = mgr.sessionView();
  const q = view.current_question;
  if (!q || q.ticket_id !== input.ticket_id) {
    throw new Error(
      `record_answer: ticket_id ${input.ticket_id} does not match the current question`,
    );
  }
  mgr.recordAnswer({
    question_id: q.id as QuestionId,
    value: input.value,
    source: input.source,
  });
  return RecordAnswerOutput.parse({ ok: true });
}

// ---------------------------------------------------------------------------
// stopSession
// ---------------------------------------------------------------------------

export async function stopSession(): Promise<StopSessionOutput> {
  const manager = mcpState.manager;
  if (!manager) throw new Error('No active session.');

  const transport = mcpState.transport;
  const http = mcpState.http;

  // Clear state FIRST to prevent concurrent startSession from seeing stale refs
  mcpState.manager = null;
  mcpState.transport = null;
  mcpState.http = null;
  mcpState.publicUrl = null;

  const stopResult = manager.stop('stop_session');

  // Best-effort async teardown after state is already cleared
  if (transport) await transport.stop().catch(() => {});
  if (http) await http.close().catch(() => {});

  return StopSessionOutput.parse(stopResult);
}
