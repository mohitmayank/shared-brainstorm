import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type {
  Transport,
  TransportErrorReason,
  TransportInfo,
  TransportLocal,
} from './Transport.js';
import { parseCloudflaredUrl } from './parseCloudflaredUrl.js';

/**
 * Injectable spawn function type for testability.
 *
 * This is intentionally a narrow single-signature type covering the one
 * call-site in this file: `spawn(command, args, options)`.  The real
 * `node:child_process.spawn` has many overloads; we cast it to this type
 * in the constructor so tests can pass simple fakes without satisfying every
 * overload.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

// The real spawn satisfies our narrow signature at the call-site; we need an
// explicit cast because TypeScript won't accept an overloaded function as a
// compatible single-signature type without it.
const defaultSpawn: SpawnFn = nodeSpawn as SpawnFn;

export interface CloudflaredTransportOpts {
  /** The executable to run, e.g. `'cloudflared'` or `'npx'`. */
  command: string;
  /**
   * Arguments prepended before the auto-appended `--url` flag.
   * If this array already includes `'--url'`, the flag is NOT appended again.
   */
  args?: string[];
  /** Injectable for tests; defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
  /** How long to wait for a URL before rejecting (default 15000 ms). */
  readyTimeoutMs?: number;
  /** Path for the PID file (default `~/.shared-brainstorm/tunnel.pid`). */
  pidFile?: string;
  /**
   * Optional env to pass to the spawned child. Add-on semantics — pass a fully-
   * merged env (e.g. `{ ...process.env, CLOUDFLARED_VERSION: '2025.11.1' }`) when
   * you need to pin the cloudflared binary version under the `npx` fallback
   * path. If undefined, the child inherits `process.env` per Node default.
   *
   * Pinned: 2026-05-19 — cloudflared 2025.11.1 (D-11 corrected: pin the binary
   * via the CLOUDFLARED_VERSION env var, NOT via `npx -p cloudflared@X.Y.Z`
   * which only pins the npm wrapper. See 02-RESEARCH §Concern 1.)
   */
  spawnEnv?: NodeJS.ProcessEnv;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_PID_DIR = join(homedir(), '.shared-brainstorm');
const DEFAULT_PID_FILE = join(DEFAULT_PID_DIR, 'tunnel.pid');
const SIGTERM_GRACE_MS = 3_000;

/**
 * D-08 / REL-03: up to 3 restart attempts with exponential backoff.
 * Indexed by `restartCount` — `restartCount=0` picks the first delay (1s),
 * `restartCount=1` picks 5s, `restartCount=2` picks 30s. On the 4th call
 * (`restartCount >= 3`) the schedule is exhausted and `onError(cb)` fires.
 *
 * Pinned: 2026-05-19 — restart backoff schedule (REL-03 / D-08). Adjust with care.
 */
const RESTART_BACKOFF_MS = [1_000, 5_000, 30_000] as const;

/**
 * D-12 / REL-11: after this many ms with the cloudflared process alive but no
 * URL parsed, emit a "still waiting" stderr banner so users know we're not
 * hung. Cleared on settle / process exit / readyTimeout.
 */
const STILL_WAITING_TICK_MS = 5_000;

/** D-12 / REL-11: max chars of the last stderr line included in the timeout diag. */
const LAST_STDERR_LINE_MAX_CHARS = 200;

export class CloudflaredTransport implements Transport {
  private readonly command: string;
  private readonly userArgs: string[];
  private readonly spawnFn: SpawnFn;
  private readonly readyTimeoutMs: number;
  private readonly pidFile: string;
  private readonly spawnEnv: NodeJS.ProcessEnv | undefined;

  private proc: ChildProcess | null = null;
  private restartCount = 0;
  private currentLocal: TransportLocal | null = null;
  private urlChangeCb: ((newUrl: string) => void) | null = null;
  // REL-03: callback fired when the 3-restart budget is exhausted. Stored by
  // 02-04 scaffolding; the firing path lives in `scheduleRestart` below (02-05).
  private onErrorCb: ((reason: TransportErrorReason) => void) | null = null;
  private stopped = false;
  /**
   * Active backoff timer between restart attempts. Stored so `stop()` can
   * cancel it — Pitfall 2 (02-RESEARCH §10): without this, a `setTimeout` for
   * restart 2 fires after the user has called `stopSession`, and we spawn
   * cloudflared on a tornado-down session.
   */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CloudflaredTransportOpts) {
    this.command = opts.command;
    this.userArgs = opts.args ?? [];
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.readyTimeoutMs =
      opts.readyTimeoutMs !== undefined
        ? opts.readyTimeoutMs
        : DEFAULT_READY_TIMEOUT_MS;
    this.pidFile =
      opts.pidFile !== undefined ? opts.pidFile : DEFAULT_PID_FILE;
    this.spawnEnv = opts.spawnEnv;
  }

  onUrlChange(cb: (newUrl: string) => void): void {
    this.urlChangeCb = cb;
  }

  onError(cb: (reason: TransportErrorReason) => void): void {
    this.onErrorCb = cb;
  }

  bindHint(): '127.0.0.1' {
    return '127.0.0.1';
  }

  async start(local: TransportLocal): Promise<TransportInfo> {
    this.stopped = false;
    this.restartCount = 0;
    this.currentLocal = local;
    const url = await this.spawnAndWaitForUrl(local);
    return {
      publicUrl: url,
      kind: 'cloudflared',
      // D-13: cloudflared serves traffic locally over loopback only; HTTPS happens
      // at the cloudflared layer above us, so participant cookies must be Secure.
      bind: '127.0.0.1',
      secureCookie: true,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Pitfall 2: cancel any pending backoff timer so a queued restart doesn't
    // fire after the session has been torn down.
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    await this.killProc();
    await this.removePidFile();
  }

  // ---------------------------------------------------------------------------
  // Test-only accessor — used by selectTransport.test.ts to assert that the
  // npx-fallback path sets CLOUDFLARED_VERSION via spawnEnv (D-11 corrected).
  // Marked underscore-prefixed and documented in CONTRIBUTING-style comment.
  // ---------------------------------------------------------------------------
  /** @internal Test-only: returns the spawnEnv passed at construction. */
  _getSpawnEnv(): NodeJS.ProcessEnv | undefined {
    return this.spawnEnv;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildArgs(local: TransportLocal): string[] {
    // If user args already contain '--url', use them verbatim.
    if (this.userArgs.includes('--url')) {
      return this.userArgs.slice();
    }
    return [
      ...this.userArgs,
      '--url',
      `http://${local.host}:${local.port}`,
    ];
  }

  private spawnAndWaitForUrl(local: TransportLocal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const args = this.buildArgs(local);
      // Compose SpawnOptions with conditional `env` to satisfy
      // exactOptionalPropertyTypes — passing `env: undefined` is not the same
      // as omitting the key (Node's child_process distinguishes them).
      const spawnOpts: SpawnOptions = {
        stdio: ['ignore', 'ignore', 'pipe'],
        ...(this.spawnEnv !== undefined ? { env: this.spawnEnv } : {}),
      };
      const child = this.spawnFn(this.command, args, spawnOpts);

      this.proc = child;

      let stderrBuf = '';
      let stderrLineCount = 0;
      let lastStderrLine = '';
      let settled = false;

      // REL-11 / D-12: 15s timeout — on fire, produce a structured diagnostic.
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (stillWaitingTimer !== null) clearTimeout(stillWaitingTimer);
          const exited = child.exitCode !== null || child.killed === true;
          const diag =
            `CloudflaredTransport: timed out after ${this.readyTimeoutMs} ms waiting for URL ` +
            `— cloudflared binary: ${this.command}, args: ${args.join(' ')}, ` +
            `exited: ${exited}, stderr_lines_seen: ${stderrLineCount}, ` +
            `last_stderr_line: ${JSON.stringify(lastStderrLine)} ` +
            `— try \`--no-cloudflared\` to fall back to LAN mode, or check your network's outbound HTTPS access.`;
          reject(new Error(diag));
        }
      }, this.readyTimeoutMs);

      // REL-11 / D-12: 5s "still waiting" banner — non-fatal nudge that we are
      // alive and the wait is intentional, not a hang.
      let stillWaitingTimer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => {
          stillWaitingTimer = null;
          if (settled) return;
          // eslint-disable-next-line no-console -- D-12 user-visible banner.
          console.warn('Cloudflared started; still waiting for tunnel URL…');
        },
        STILL_WAITING_TICK_MS,
      );

      const clearStillWaiting = (): void => {
        if (stillWaitingTimer !== null) {
          clearTimeout(stillWaitingTimer);
          stillWaitingTimer = null;
        }
      };

      const settle = (url: string): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearStillWaiting();
          resolve(url);
          // Write PID file asynchronously — errors are non-fatal.
          this.writePidFile(child.pid).catch(() => {
            /* non-fatal */
          });
        }
      };

      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => {
          // Always track stderr metadata (even after settle) so the 15s diag
          // can include the last line if a later restart attempt times out
          // — but only for the active wait window. Once settled, the
          // stderr handler is effectively a no-op for diagnostic purposes
          // because `timer` has been cleared.
          stderrBuf += chunk;
          if (stderrBuf.length > 65_536) stderrBuf = stderrBuf.slice(-65_536);
          // Count newlines in the chunk for `stderr_lines_seen`.
          for (let i = 0; i < chunk.length; i++) {
            if (chunk.charCodeAt(i) === 0x0a /* '\n' */) stderrLineCount++;
          }
          // Last complete line — split, drop the (possibly partial) trailing
          // line, take the penultimate. Truncate to 200 chars.
          const lines = stderrBuf.split('\n');
          // lines.at(-1) is the unfinished trailing chunk after the last '\n'
          // — penultimate is the last *complete* line.
          const candidate = lines.length >= 2 ? lines[lines.length - 2]! : lines[0]!;
          const trimmed = candidate.trim();
          if (trimmed.length > 0) {
            lastStderrLine =
              trimmed.length > LAST_STDERR_LINE_MAX_CHARS
                ? trimmed.slice(0, LAST_STDERR_LINE_MAX_CHARS)
                : trimmed;
          }

          if (settled) return;
          const url = parseCloudflaredUrl(stderrBuf);
          if (url) settle(url);
        });
      }

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearStillWaiting();
          reject(err);
        }
      });

      child.on('exit', (code: number | null, signal: string | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearStillWaiting();
          reject(
            new Error(
              `CloudflaredTransport: process exited before URL appeared (code=${code}, signal=${signal})`,
            ),
          );
          return;
        }

        // Process exited AFTER URL was found — kick off the restart loop. The
        // scheduleRestart helper manages the 3-attempt counter (D-08) and the
        // onError firing on exhaustion (REL-03).
        this.scheduleRestart();
      });
    });
  }

  /**
   * D-08 / REL-03: schedules the next restart attempt using the
   * `RESTART_BACKOFF_MS` schedule. On exhaustion (3rd consecutive failure),
   * invokes `onErrorCb` with `cloudflared_permanent_failure`.
   *
   * Re-entrant via the `.catch` branch — when `spawnAndWaitForUrl` rejects
   * (timeout or pre-URL exit), this is called again to schedule the next
   * attempt. When the spawn resolves but the child later exits, the exit
   * handler in `spawnAndWaitForUrl` calls this directly.
   */
  private scheduleRestart(): void {
    if (this.stopped) return;
    if (this.restartCount >= RESTART_BACKOFF_MS.length) {
      // Budget exhausted — fire onError once (gated by stopped check in case
      // a stop() raced with this fire). Do NOT reschedule.
      if (this.onErrorCb && !this.stopped) {
        this.onErrorCb({
          code: 'cloudflared_permanent_failure',
          message: `cloudflared exited ${this.restartCount + 1} times — last attempt failed`,
          restart_count: this.restartCount,
        });
      }
      return;
    }
    const delay = RESTART_BACKOFF_MS[this.restartCount]!;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // Pitfall 2 double-check: a stop() may have fired during the backoff.
      if (this.stopped) return;
      // No active local means start() was never called — defensive guard
      // (shouldn't happen in practice; scheduleRestart only runs after start).
      if (this.currentLocal === null) return;

      this.restartCount++;
      const restartLocal = this.currentLocal;
      this.spawnAndWaitForUrl(restartLocal)
        .then((newUrl) => {
          if (!this.stopped && this.urlChangeCb) this.urlChangeCb(newUrl);
        })
        .catch(() => {
          // Spawn-and-wait rejected (timeout or pre-URL exit). Re-enter the
          // restart loop. (For a post-URL exit, scheduleRestart is invoked
          // synchronously from the exit handler inside spawnAndWaitForUrl —
          // we don't need to re-enter here.)
          if (!this.stopped) this.scheduleRestart();
        });
    }, delay);
  }

  private async writePidFile(pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    await mkdir(DEFAULT_PID_DIR, { recursive: true });
    await writeFile(this.pidFile, String(pid), 'utf8');
  }

  private async removePidFile(): Promise<void> {
    await rm(this.pidFile, { force: true });
  }

  private killProc(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (!child || child.exitCode !== null) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
        resolve();
      }, SIGTERM_GRACE_MS);

      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
