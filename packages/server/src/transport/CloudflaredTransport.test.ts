import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { CloudflaredTransport } from './CloudflaredTransport.js';
import type { SpawnFn } from './CloudflaredTransport.js';

// ---------------------------------------------------------------------------
// Fake process factory
// ---------------------------------------------------------------------------

/**
 * A minimal ChildProcess-shaped object for testing.
 * We only implement the parts CloudflaredTransport actually uses:
 *   - .stderr (Readable)
 *   - .pid
 *   - .exitCode
 *   - .kill()
 *   - EventEmitter ('exit', 'error')
 */
interface FakeProcess extends EventEmitter {
  pid: number;
  exitCode: number | null;
  stdin: null;
  stdout: null;
  stderr: Readable;
  kill: ReturnType<typeof vi.fn>;
}

interface FakeProcessOpts {
  stderrLines?: string[];
  /** If set, the process exits with this code after `exitDelayMs`. */
  exitCode?: number;
  exitDelayMs?: number;
}

function makeFakeProcess(opts: FakeProcessOpts = {}): FakeProcess & ChildProcess {
  const emitter = new EventEmitter();

  const stderrSource = opts.stderrLines
    ? Readable.from(opts.stderrLines.map((l) => l + '\n'))
    : Readable.from([]);

  const fake: FakeProcess = Object.assign(emitter, {
    pid: 12345,
    exitCode: null as number | null,
    stdin: null,
    stdout: null,
    stderr: stderrSource,
    kill: vi.fn((signal?: NodeJS.Signals | number) => {
      const code = signal === 'SIGKILL' ? 1 : 0;
      fake.exitCode = code;
      emitter.emit('exit', code, signal ?? null);
      return true;
    }),
  });

  if (opts.exitCode !== undefined) {
    const delay = opts.exitDelayMs ?? 5;
    const exitCode = opts.exitCode;
    setTimeout(() => {
      fake.exitCode = exitCode;
      emitter.emit('exit', exitCode, null);
    }, delay);
  }

  return fake as FakeProcess & ChildProcess;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SpawnFn shim that always returns the provided fake process. */
function makeSpawnFn(fakeProc: FakeProcess & ChildProcess): SpawnFn {
  return (
    _cmd: string,
    _args: readonly string[],
    _opts: SpawnOptions,
  ): ChildProcess => fakeProc;
}

const LOCAL = { host: '127.0.0.1', port: 7711 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudflaredTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves with publicUrl when cloudflared prints the tunnel URL', async () => {
    const fakeProc = makeFakeProcess({
      stderrLines: [
        '2024-01-01T00:00:00Z INF | https://happy-test.trycloudflare.com |',
      ],
    });

    const transport = new CloudflaredTransport({
      command: 'cloudflared',
      spawn: makeSpawnFn(fakeProc),
      pidFile: '/tmp/test-tunnel-resolve.pid',
    });

    const info = await transport.start(LOCAL);

    expect(info.kind).toBe('cloudflared');
    expect(info.publicUrl).toBe('https://happy-test.trycloudflare.com');

    await transport.stop();
  });

  it('rejects with a timeout error when no URL appears in time', async () => {
    const fakeProc = makeFakeProcess({
      stderrLines: ['2024-01-01T00:00:00Z INF Starting...'],
    });

    const transport = new CloudflaredTransport({
      command: 'cloudflared',
      spawn: makeSpawnFn(fakeProc),
      readyTimeoutMs: 50,
      pidFile: '/tmp/test-tunnel-timeout.pid',
    });

    await expect(transport.start(LOCAL)).rejects.toThrow(/timed out/);
  });

  it('stop() kills the process with SIGTERM', async () => {
    const fakeProc = makeFakeProcess({
      stderrLines: ['https://stop-test.trycloudflare.com'],
    });

    const transport = new CloudflaredTransport({
      command: 'cloudflared',
      spawn: makeSpawnFn(fakeProc),
      pidFile: '/tmp/test-tunnel-stop.pid',
    });

    await transport.start(LOCAL);
    await transport.stop();

    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('appends --url flag when args do not already include it', async () => {
    let capturedArgs: readonly string[] = [];

    const fakeProc = makeFakeProcess({
      stderrLines: ['https://args-test.trycloudflare.com'],
    });

    const spawnFn: SpawnFn = (
      _cmd: string,
      args: readonly string[],
      _opts: SpawnOptions,
    ): ChildProcess => {
      capturedArgs = args;
      return fakeProc;
    };

    const transport = new CloudflaredTransport({
      command: 'cloudflared',
      args: ['tunnel'],
      spawn: spawnFn,
      pidFile: '/tmp/test-tunnel-args.pid',
    });

    await transport.start(LOCAL);
    await transport.stop();

    expect(capturedArgs).toContain('--url');
    expect(capturedArgs).toContain(`http://${LOCAL.host}:${LOCAL.port}`);
  });

  it('does NOT append --url when user args already include it', async () => {
    let capturedArgs: readonly string[] = [];

    const fakeProc = makeFakeProcess({
      stderrLines: ['https://preurl-test.trycloudflare.com'],
    });

    const spawnFn: SpawnFn = (
      _cmd: string,
      args: readonly string[],
      _opts: SpawnOptions,
    ): ChildProcess => {
      capturedArgs = args;
      return fakeProc;
    };

    const transport = new CloudflaredTransport({
      command: 'cloudflared',
      args: ['tunnel', '--url', 'http://127.0.0.1:9999'],
      spawn: spawnFn,
      pidFile: '/tmp/test-tunnel-preurl.pid',
    });

    await transport.start(LOCAL);
    await transport.stop();

    const occurrences = (capturedArgs as string[]).filter((a) => a === '--url').length;
    expect(occurrences).toBe(1);
    // The user-provided --url value should not be overridden.
    const urlIdx = (capturedArgs as string[]).indexOf('--url');
    expect((capturedArgs as string[])[urlIdx + 1]).toBe('http://127.0.0.1:9999');
  });

  it('fires onUrlChange callback with new URL on restart', async () => {
    // First process — emits URL then exits.
    const firstProc = makeFakeProcess({
      stderrLines: ['https://first.trycloudflare.com'],
      exitCode: 1,
      exitDelayMs: 20,
    });

    // Second process — spawned on restart.
    const secondProc = makeFakeProcess({
      stderrLines: ['https://second-restart.trycloudflare.com'],
    });

    const procs = [firstProc, secondProc];
    let spawnCallCount = 0;

    const spawnFn: SpawnFn = (
      _cmd: string,
      _args: readonly string[],
      _opts: SpawnOptions,
    ): ChildProcess => {
      const proc = procs[spawnCallCount] ?? secondProc;
      spawnCallCount++;
      return proc;
    };

    const transport = new CloudflaredTransport({
      command: 'cloudflared',
      spawn: spawnFn,
      readyTimeoutMs: 500,
      pidFile: '/tmp/test-tunnel-restart.pid',
    });

    const urlChanges: string[] = [];
    transport.onUrlChange((u) => {
      urlChanges.push(u);
    });

    await transport.start(LOCAL);

    // Wait long enough for restart to complete.
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(urlChanges.length).toBeGreaterThanOrEqual(1);
    expect(urlChanges[0]).toBe('https://second-restart.trycloudflare.com');

    await transport.stop();
  });
});
