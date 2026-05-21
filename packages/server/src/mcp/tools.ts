import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StartSessionInput,
  AskGroupInput,
  AskGroupOutput,
  AskGroupUnionInput,
  AskGroupBatchOutput,
  AwaitAnswerInput,
  AwaitAnswerOutput,
  RecordAnswerInput,
  RecordAnswerOutput,
  StopSessionOutput,
  AnswerClarificationInput,
  AnswerClarificationOutput,
} from '@shared-brainstorm/shared';
import type { QuestionId, ServerEvent } from '@shared-brainstorm/shared';
import { SessionManager } from '../session/SessionManager.js';
import { realClock } from '../session/clock.js';
import { startHttpServer } from '../http/index.js';
import { redactQuestion } from '../redact/redact.js';
import type {
  Transport,
  TransportErrorReason,
  TransportInfo,
  TransportLocal,
} from '../transport/Transport.js';
import {
  selectTransport as defaultSelectTransport,
  validateBindOverride,
} from '../transport/selectTransport.js';
import { copyToClipboard as defaultCopyToClipboard } from '../util/clipboard.js';
import { isTruthyEnv } from '../util/env.js';
import { mcpState } from './state.js';

function buildInviteText(publicUrl: string): string {
  return [
    "Hi! I'm running a quick team brainstorm — would love your input.",
    '',
    `Join: ${publicUrl}`,
    '',
    'The host will approve you once you open the link.',
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
  private onErrorCb: ((reason: TransportErrorReason) => void) | null = null;

  async start(local: TransportLocal): Promise<TransportInfo> {
    return {
      publicUrl: `http://${local.host}:${local.port}`,
      kind: 'mock' as const,
      // D-13: Mock uses LAN-style defaults so tests don't accidentally require Secure.
      bind: '0.0.0.0',
      secureCookie: false,
    };
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  onUrlChange(cb: (newUrl: string) => void): void {
    this.urlChangeCb = cb;
  }

  onError(cb: (reason: TransportErrorReason) => void): void {
    this.onErrorCb = cb;
  }

  bindHint(): '0.0.0.0' {
    return '0.0.0.0';
  }

  /** Expose stored callback (for tests). */
  _getUrlChangeCb(): ((newUrl: string) => void) | null {
    return this.urlChangeCb;
  }

  /** Expose stored onError callback (for tests). */
  _getOnErrorCb(): ((reason: TransportErrorReason) => void) | null {
    return this.onErrorCb;
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
  invite_text: string;
  clipboard_copied: boolean;
  coordinator_url: string;
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

  const { session_id } = manager.start({ brief: input.brief });

  // ── Phase 2 (02-04) restructure ────────────────────────────────────────
  // 1. Construct the transport WITHOUT calling .start() yet.
  // 2. Use transport.bindHint() to pick the effective bind, then apply the
  //    SHARED_BRAINSTORM_BIND override (REL-08 / D-17).
  // 3. Boot the HTTP server with that effective bind.
  // 4. Call transport.start({host, port}) once we know the local port.
  // 5. Pass transportInfo.secureCookie back to the running app — see below.
  // ───────────────────────────────────────────────────────────────────────

  const select = opts?.selectTransport ?? defaultSelectTransport;
  let transport: Transport;
  if (opts?.transportFactory === 'mock') {
    transport = new MockTransport();
  } else {
    const selectOpts: Parameters<typeof select>[0] = {};
    if (opts?.transportFactory) selectOpts.prefer = opts.transportFactory;
    transport = await select(selectOpts);
  }

  // Effective bind: env override wins (with stderr warning); else transport's hint.
  const transportBindHint = transport.bindHint();
  const bindOverride = validateBindOverride(process.env['SHARED_BRAINSTORM_BIND']);
  let effectiveBind: string = transportBindHint;
  if (bindOverride.kind === 'accept') {
    // eslint-disable-next-line no-console
    console.warn(
      `⚠  SHARED_BRAINSTORM_BIND=${bindOverride.value} overrides transport default — only use if you know why`,
    );
    effectiveBind = bindOverride.value;
  } else if (bindOverride.kind === 'reject') {
    const raw = process.env['SHARED_BRAINSTORM_BIND'] ?? '';
    // eslint-disable-next-line no-console
    console.warn(
      `⚠  SHARED_BRAINSTORM_BIND=${raw} ignored: ${bindOverride.reason}; falling back to transport default ${transportBindHint}`,
    );
  }

  // Boot HTTP server on a random port at the effective bind.
  const staticDir =
    opts?.staticDir === null
      ? undefined
      : (opts?.staticDir ?? resolveStaticDir());
  const httpArgs: Parameters<typeof startHttpServer>[0] = {
    manager,
    listen: { port: 0, host: effectiveBind },
  };
  if (staticDir) httpArgs.staticDir = staticDir;
  const http = await startHttpServer(httpArgs);

  const local: TransportLocal = { host: http.host, port: http.port };

  const transportInfo = await transport.start(local);
  const publicUrl = transportInfo.publicUrl;

  // Sanity check: transport's returned bind should match the hint we used,
  // unless the user overrode it via the env var. A mismatch with no override
  // is a transport-implementation bug.
  if (
    bindOverride.kind !== 'accept' &&
    transportInfo.bind !== transportBindHint
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      `transport.bindHint() returned ${transportBindHint} but .start() returned ${transportInfo.bind} — implementation mismatch`,
    );
  }

  // Now that the transport has resolved its advisory, flip the participant
  // cookie's Secure flag (D-13 / D-16). The HTTP server captures secureCookie
  // via a thunk so the flip propagates to subsequent /api/join requests
  // without needing to rebuild the Hono app.
  http.setSecureCookie(transportInfo.secureCookie);

  // Reset transport-failure state BEFORE wiring the onError callback. This
  // ensures a fresh session starts clean even if a prior session ended via
  // permanent failure, and protects against the (defensive) case where a
  // transport invokes onError synchronously during registration.
  mcpState.transportFailed = false;
  mcpState.lastTransportError = null;

  // Wire URL-change callback so transport can update mcpState.publicUrl
  transport.onUrlChange((newUrl) => {
    mcpState.publicUrl = newUrl;
    manager.emitExternal({
      type: 'tunnel_url_changed',
      payload: { public_url: newUrl },
    });
  });

  // Wire terminal-failure callback (REL-03 / D-09). Cloudflared fires this once
  // it has exhausted its restart budget; LAN/mock store the callback but never
  // invoke it. We do three things:
  //   1. Set mcpState flag + last-error snapshot so the next askGroup short-circuits.
  //   2. Emit a loud stderr banner (single-fire — restart loop caps at 3).
  //   3. Broadcast a ring-buffered transport_failed event so connected and
  //      late-joining clients can render the permanent-down state. Per D-09
  //      (research-corrected) this follows the tunnel_url_changed precedent
  //      via manager.emitExternal — pitfall 6 (no participants connected) is
  //      acceptable: the stderr banner + mcpState flag still fire, and the
  //      event lands in the RingBuffer for the next reconnect.
  transport.onError((reason) => {
    const at = realClock.isoNow();
    mcpState.transportFailed = true;
    mcpState.lastTransportError = {
      code: reason.code,
      message: reason.message,
      restart_count: reason.restart_count,
      at,
    };
    // eslint-disable-next-line no-console
    console.error(
      `⚠  Cloudflared tunnel permanently down after ${reason.restart_count} restart attempts. Last error: ${reason.message}`,
    );
    // Cast through `unknown` because the generic `Envelope<P>` helper in
    // packages/shared/src/events.ts erases the `type` literal at d.ts
    // generation (z.ZodLiteral<string>), so excess-property checking on
    // direct object literal assignment to Omit<ServerEvent,'seq'|'ts'> fails
    // even though the variant exists in the schema. The runtime path is
    // identical to tunnel_url_changed.
    manager.emitExternal({
      type: 'transport_failed',
      payload: {
        code: reason.code,
        message: reason.message,
        restart_count: reason.restart_count,
        at,
      },
    } as unknown as Omit<ServerEvent, 'seq' | 'ts'>);
  });

  // Commit to mcpState
  mcpState.manager = manager;
  mcpState.transport = transport;
  mcpState.http = http;
  mcpState.publicUrl = publicUrl;

  const invite_text = buildInviteText(publicUrl);

  // Phase 3 (COORD-01): compose the coordinator URL from the public URL using
  // the URL API so trailing slashes / pre-existing query strings are handled
  // correctly. This URL is surfaced as its own return field — it MUST NOT enter
  // invite_text (auto-copied to clipboard); the MCP host prints it separately.
  const coordinatorToken = manager.coordinatorToken();
  const coordinatorUrlObj = new URL(publicUrl);
  coordinatorUrlObj.searchParams.set('role', 'coordinator');
  coordinatorUrlObj.searchParams.set('token', coordinatorToken);
  const coordinator_url = coordinatorUrlObj.toString();

  const clipboardDisabled = isTruthyEnv(process.env['SHARED_BRAINSTORM_NO_CLIPBOARD']);
  const copy = opts?.copyToClipboard ?? defaultCopyToClipboard;
  const clipboard_copied = clipboardDisabled
    ? false
    : (await copy(invite_text).catch(() => null)) !== null;

  return {
    session_id,
    public_url: publicUrl,
    invite_text,
    clipboard_copied,
    coordinator_url,
  };
}

// ---------------------------------------------------------------------------
// askGroup
// ---------------------------------------------------------------------------

export function askGroup(raw: unknown): AskGroupOutput | AskGroupBatchOutput {
  if (!mcpState.manager) throw new Error('No active session. Call startSession first.');

  // REL-03 / D-09 gate: if the transport has permanently failed, short-circuit
  // BEFORE redacting/broadcasting. The MCP CallToolRequestSchema handler in
  // mcp/server.ts catches this throw and converts it to `{ isError: true }`
  // content, surfacing a structured error to the AI host. Per D-10 the
  // coordinator must call stopSession manually — we do NOT auto-stop here.
  if (mcpState.transportFailed) {
    const err = mcpState.lastTransportError;
    throw new Error(
      `transport_failed: ${err?.message ?? 'cloudflared tunnel down'} ` +
        `(code=${err?.code ?? 'unknown'}, restart_count=${err?.restart_count ?? 0}). ` +
        `Coordinator may need to stopSession and restart.`,
    );
  }

  const input = AskGroupUnionInput.parse(raw); // Phase 6: union handles both single and batch

  if ('questions' in input) {
    // Phase 6 (BATCH-01): batch path — redact each question item, call askGroupBatch
    const redactedItems = input.questions.map((q) => redactQuestion(q));
    const result = mcpState.manager.askGroupBatch(redactedItems);
    return AskGroupBatchOutput.parse(result);
  } else {
    // Single path — byte-identical to pre-Phase-6 behavior
    const redacted = redactQuestion(input);
    const result = mcpState.manager.askGroup(redacted);
    return AskGroupOutput.parse(result);
  }
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
  // Phase 6: look up in questions[] array by ticket_id (supports N concurrent questions)
  const q = view.questions.find((q) => q.ticket_id === input.ticket_id);
  if (!q) {
    throw new Error(
      `record_answer: ticket_id ${input.ticket_id} not found in open questions`,
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
// answerClarification (CHATAI-01)
// ---------------------------------------------------------------------------

/**
 * 6th MCP tool: AI host records an answer to a participant's clarification.
 * Finds the question via `ticket_id`, sets `answer` + `answered_at` on the
 * matching clarification, and re-emits `clarification_added` for browser upsert.
 */
export function answerClarification(raw: unknown): AnswerClarificationOutput {
  if (!mcpState.manager) throw new Error('No active session. Call startSession first.');
  const input = AnswerClarificationInput.parse(raw);
  mcpState.manager.answerClarification({
    ticket_id: input.ticket_id,
    clarification_id: input.clarification_id,
    answer_text: input.text,
  });
  return AnswerClarificationOutput.parse({ ok: true });
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
  mcpState.transportFailed = false;
  mcpState.lastTransportError = null;

  const stopResult = manager.stop('stop_session');

  // Best-effort async teardown after state is already cleared
  if (transport) await transport.stop().catch(() => {});
  if (http) await http.close().catch(() => {});

  return StopSessionOutput.parse(stopResult);
}
