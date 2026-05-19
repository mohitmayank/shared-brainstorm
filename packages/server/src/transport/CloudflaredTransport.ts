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
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_PID_DIR = join(homedir(), '.shared-brainstorm');
const DEFAULT_PID_FILE = join(DEFAULT_PID_DIR, 'tunnel.pid');
const SIGTERM_GRACE_MS = 3_000;

export class CloudflaredTransport implements Transport {
  private readonly command: string;
  private readonly userArgs: string[];
  private readonly spawnFn: SpawnFn;
  private readonly readyTimeoutMs: number;
  private readonly pidFile: string;

  private proc: ChildProcess | null = null;
  private restartCount = 0;
  private currentLocal: TransportLocal | null = null;
  private urlChangeCb: ((newUrl: string) => void) | null = null;
  // REL-03 scaffolding (02-04): callback storage only. The actual firing path
  // from the 3-restart loop lands in 02-05; until then this is a no-op hook.
  private onErrorCb: ((reason: TransportErrorReason) => void) | null = null;
  private stopped = false;

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
    await this.killProc();
    await this.removePidFile();
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
      const child = this.spawnFn(this.command, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      this.proc = child;

      let stderrBuf = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(
            new Error(
              `CloudflaredTransport: timed out after ${this.readyTimeoutMs} ms waiting for URL`,
            ),
          );
        }
      }, this.readyTimeoutMs);

      const settle = (url: string): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
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
          if (settled) return;
          stderrBuf += chunk;
          if (stderrBuf.length > 65_536) stderrBuf = stderrBuf.slice(-65_536);
          const url = parseCloudflaredUrl(stderrBuf);
          if (url) settle(url);
        });
      }

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      child.on('exit', (code: number | null, signal: string | null) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `CloudflaredTransport: process exited before URL appeared (code=${code}, signal=${signal})`,
            ),
          );
          return;
        }

        // Process exited after URL was found — attempt one auto-restart.
        if (!this.stopped && this.restartCount < 1 && this.currentLocal) {
          this.restartCount++;
          const restartLocal = this.currentLocal;
          this.spawnAndWaitForUrl(restartLocal)
            .then((newUrl) => {
              if (!this.stopped && this.urlChangeCb) this.urlChangeCb(newUrl);
            })
            .catch(() => {
              /* restart failed — nothing more to do */
            });
        }
      });
    });
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
