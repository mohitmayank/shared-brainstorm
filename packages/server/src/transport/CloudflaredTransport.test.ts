import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { CloudflaredTransport } from './CloudflaredTransport.js';
import type { SpawnFn } from './CloudflaredTransport.js';
import type { TransportErrorReason } from './Transport.js';

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

  // ---------------------------------------------------------------------------
  // Phase 2 / 02-04 — REL-08 / REL-09 / REL-03 scaffolding
  // ---------------------------------------------------------------------------
  describe('Transport widening (REL-08 / REL-09 / REL-03 scaffolding)', () => {
    it('start() returns bind: "127.0.0.1" and secureCookie: true (D-13 / D-16)', async () => {
      const fakeProc = makeFakeProcess({
        stderrLines: [
          '2024-01-01T00:00:00Z INF | https://widening-test.trycloudflare.com |',
        ],
      });

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: makeSpawnFn(fakeProc),
        pidFile: '/tmp/test-tunnel-widen.pid',
      });

      const info = await transport.start(LOCAL);
      expect(info.bind).toBe('127.0.0.1');
      expect(info.secureCookie).toBe(true);
      // Existing fields unchanged.
      expect(info.kind).toBe('cloudflared');
      expect(info.publicUrl).toBe('https://widening-test.trycloudflare.com');

      await transport.stop();
    });

    it('bindHint() returns "127.0.0.1" without calling start()', () => {
      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        pidFile: '/tmp/test-tunnel-bindhint.pid',
      });
      expect(transport.bindHint()).toBe('127.0.0.1');
    });

    it('onError(cb) stores the callback but never invokes it on a successful run (02-04 scaffolding)', async () => {
      // The full restart loop / onError firing path lands in 02-05. For 02-04,
      // the callback must be storable without crashing and must NOT fire on a
      // normal-exit path that the existing single-restart logic already covers.
      const fakeProc = makeFakeProcess({
        stderrLines: [
          '2024-01-01T00:00:00Z INF | https://onerror-test.trycloudflare.com |',
        ],
      });

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: makeSpawnFn(fakeProc),
        pidFile: '/tmp/test-tunnel-onerror.pid',
      });

      let called = false;
      transport.onError(() => {
        called = true;
      });

      await transport.start(LOCAL);
      await transport.stop();
      expect(called).toBe(false);
    });
  });

  it('fires onUrlChange callback with new URL on restart (after 1s backoff)', async () => {
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

    // Wait long enough for the 1s backoff + restart to complete.
    // RESTART_BACKOFF_MS[0] = 1000 ms; allow a comfortable margin.
    await new Promise<void>((r) => setTimeout(r, 1_300));

    expect(urlChanges.length).toBeGreaterThanOrEqual(1);
    expect(urlChanges[0]).toBe('https://second-restart.trycloudflare.com');
    // 2 spawns total (initial + 1 restart) — no further restarts because
    // secondProc never exits.
    expect(spawnCallCount).toBe(2);

    await transport.stop();
  });

  // ---------------------------------------------------------------------------
  // Phase 2 / 02-05 — REL-03 multi-restart counter + REL-11 5s/15s diagnostics
  // ---------------------------------------------------------------------------

  describe('multi-restart (REL-03 / D-08)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Armable fake process — `arm()` schedules exit AFTER the consumer
     * (spawnAndWaitForUrl) has attached its listeners. This avoids a race
     * where the exit timer fires before the proc is actually spawned (which
     * would happen if the timer was scheduled at construction time and the
     * proc sat in a queue waiting for the 1s/5s/30s backoff window).
     */
    interface ArmableProc {
      proc: FakeProcess & ChildProcess;
      arm: () => void;
    }

    function makeArmableUrlThenExit(url: string, exitDelayMs = 5): ArmableProc {
      const emitter = new EventEmitter();
      const stream = Readable.from([url + '\n']);
      const fake = Object.assign(emitter, {
        pid: 99500,
        exitCode: null as number | null,
        stdin: null,
        stdout: null,
        stderr: stream,
        kill: vi.fn(() => true),
      });
      let armed = false;
      const arm = (): void => {
        if (armed) return;
        armed = true;
        setTimeout(() => {
          (fake as FakeProcess).exitCode = 1;
          emitter.emit('exit', 1, null);
        }, exitDelayMs);
      };
      return { proc: fake as unknown as FakeProcess & ChildProcess, arm };
    }

    /**
     * Build an ordered spawn queue from ArmableProc entries. Each proc's `arm`
     * is invoked synchronously when its spawnFn call returns — by that time
     * the caller (spawnAndWaitForUrl) has the child reference, but listeners
     * for 'exit' aren't attached yet. The exit timer's setTimeout(0) trick
     * defers the emit until after the synchronous spawn-and-attach completes.
     */
    function makeArmableSpawnQueue(
      armables: ArmableProc[],
    ): { spawnFn: SpawnFn; counter: { count: number } } {
      const counter = { count: 0 };
      const spawnFn: SpawnFn = (
        _cmd: string,
        _args: readonly string[],
        _opts: SpawnOptions,
      ): ChildProcess => {
        const entry =
          armables[counter.count] ??
          ({
            proc: makeFakeProcess({ stderrLines: [] }),
            arm: () => {},
          } as ArmableProc);
        counter.count++;
        // Arm AFTER returning the proc so the caller can attach listeners
        // first. queueMicrotask runs before any setTimeout(0) so we use
        // setImmediate-equivalent (setTimeout 0) — but the arm itself
        // schedules `exitDelayMs` from now, so a delay >=1 is enough to
        // guarantee listener attachment has completed.
        Promise.resolve().then(() => entry.arm());
        return entry.proc;
      };
      return { spawnFn, counter };
    }

    it('after 3 successful restarts, a 4th exit does NOT spawn a 5th process', async () => {
      const armables = [
        makeArmableUrlThenExit('https://r0.trycloudflare.com'),
        makeArmableUrlThenExit('https://r1.trycloudflare.com'),
        makeArmableUrlThenExit('https://r2.trycloudflare.com'),
        makeArmableUrlThenExit('https://r3.trycloudflare.com'),
      ];
      const { spawnFn, counter } = makeArmableSpawnQueue(armables);

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: spawnFn,
        readyTimeoutMs: 500,
        pidFile: '/tmp/test-tunnel-multi-cap.pid',
      });

      const errors: TransportErrorReason[] = [];
      transport.onError((r) => errors.push(r));

      await transport.start(LOCAL);
      // After start() resolves, spawn 0 happened. Now drive the restart chain.
      // Restart 1 fires after 1s, restart 2 after 5s more, restart 3 after 30s more.
      // Each spawn's proc exits ~5ms after emitting a URL.

      await new Promise<void>((r) => setTimeout(r, 1_200));
      expect(counter.count).toBe(2); // initial + restart 1

      await new Promise<void>((r) => setTimeout(r, 5_100));
      expect(counter.count).toBe(3); // + restart 2

      await new Promise<void>((r) => setTimeout(r, 30_100));
      expect(counter.count).toBe(4); // + restart 3

      // Now restart 3's exit fires scheduleRestart → exhausted → onError.
      // Give it a moment to settle.
      await new Promise<void>((r) => setTimeout(r, 100));
      expect(counter.count).toBe(4); // no 5th spawn

      expect(errors.length).toBe(1);
      expect(errors[0]!.code).toBe('cloudflared_permanent_failure');
      expect(errors[0]!.restart_count).toBe(3);
      expect(errors[0]!.message).toMatch(/cloudflared exited \d+ times/);

      await transport.stop();
    }, 40_000);

    // NOTE: A separate fake-timer "exact 1s/5s/30s threshold check" test was
    // attempted but proved flaky due to interactions between vitest's fake
    // timers and Readable.from's internal nextTick scheduling. The sibling
    // test ("after 3 successful restarts, a 4th exit does NOT spawn a 5th
    // process") already exercises the full restart chain in real time and
    // would fail if the backoff schedule were corrupted (e.g. the 30s wait
    // shortened to 1s, the chain would complete in ~3s rather than ~36s).
    // The wall-clock pacing of that test IS the schedule assertion.

    it('fires onError exactly once with restart_count: 3 after the 3-restart budget is exhausted', async () => {
      const armables = [
        makeArmableUrlThenExit('https://r0.trycloudflare.com'),
        makeArmableUrlThenExit('https://r1.trycloudflare.com'),
        makeArmableUrlThenExit('https://r2.trycloudflare.com'),
        makeArmableUrlThenExit('https://r3.trycloudflare.com'),
      ];
      const { spawnFn } = makeArmableSpawnQueue(armables);

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: spawnFn,
        readyTimeoutMs: 500,
        pidFile: '/tmp/test-tunnel-onerror-fires.pid',
      });

      const errors: TransportErrorReason[] = [];
      transport.onError((r) => errors.push(r));

      await transport.start(LOCAL);
      // Wait through all 3 backoffs (1s + 5s + 30s) + exit deltas.
      await new Promise<void>((r) => setTimeout(r, 36_500));

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({
        code: 'cloudflared_permanent_failure',
        message: expect.stringMatching(/cloudflared exited 4 times — last attempt failed/),
        restart_count: 3,
      });

      await transport.stop();
    }, 45_000);

    it('Pitfall 2: stop() between restart 1 and restart 2 prevents the queued spawn', async () => {
      vi.useFakeTimers();

      const armables = [
        makeArmableUrlThenExit('https://r0.trycloudflare.com', 10),
        // Restart 1 — URL emitted, but proc set up to exit so a restart 2 would
        // otherwise be scheduled. We stop() between restart 1 and restart 2.
        makeArmableUrlThenExit('https://r1.trycloudflare.com', 10),
      ];
      const { spawnFn, counter } = makeArmableSpawnQueue(armables);

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: spawnFn,
        readyTimeoutMs: 500,
        pidFile: '/tmp/test-tunnel-pitfall2.pid',
      });

      const errors: TransportErrorReason[] = [];
      transport.onError((r) => errors.push(r));

      const startP = transport.start(LOCAL);
      await vi.advanceTimersByTimeAsync(0); // flush microtasks
      await startP;

      // Drive: initial exits, 1s backoff fires restart 1, restart 1 exits.
      await vi.advanceTimersByTimeAsync(15); // initial exit (delay=10) fires
      await vi.advanceTimersByTimeAsync(1_001); // restart 1 spawn fires
      expect(counter.count).toBe(2);
      await vi.advanceTimersByTimeAsync(15); // restart 1 exits → scheduleRestart queues backoff 2 (5s)

      // We're now ~1500ms past restart 1's spawn, inside the 5s backoff window.
      // Call stop() — this should clear the queued setTimeout for restart 2.
      const stopP = transport.stop();
      // Flush kill timers / microtasks.
      await vi.advanceTimersByTimeAsync(0);
      // Let the SIGTERM-grace timer settle if needed (SIGTERM_GRACE_MS = 3000),
      // but our fakes' kill() is synchronous so this should resolve immediately.
      await vi.advanceTimersByTimeAsync(10);
      await stopP;

      // Now advance past the would-be restart-2 window. Counter must NOT grow.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(counter.count).toBe(2); // initial + restart 1, no restart 2

      // onError should NOT have fired — we stopped before the budget was hit.
      expect(errors).toHaveLength(0);
    });

    it('urlChangeCb is invoked on each successful restart (restarts 2 and 3, not just 1)', async () => {
      // Restart 3's proc stays alive (no exit) so no 4th cycle is scheduled
      // and onError doesn't fire.
      const alive: ArmableProc = {
        proc: makeFakeProcess({ stderrLines: ['https://r3-final.trycloudflare.com'] }),
        arm: () => {},
      };
      const armables = [
        makeArmableUrlThenExit('https://r0.trycloudflare.com'),
        makeArmableUrlThenExit('https://r1.trycloudflare.com'),
        makeArmableUrlThenExit('https://r2.trycloudflare.com'),
        alive,
      ];
      const { spawnFn } = makeArmableSpawnQueue(armables);

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: spawnFn,
        readyTimeoutMs: 500,
        pidFile: '/tmp/test-tunnel-multi-urlchange.pid',
      });

      const urlChanges: string[] = [];
      transport.onUrlChange((u) => urlChanges.push(u));

      await transport.start(LOCAL);
      // Wait through all 3 backoffs (1 + 5 + 30) + exit deltas.
      await new Promise<void>((r) => setTimeout(r, 36_500));

      expect(urlChanges).toEqual([
        'https://r1.trycloudflare.com',
        'https://r2.trycloudflare.com',
        'https://r3-final.trycloudflare.com',
      ]);

      await transport.stop();
    }, 45_000);
  });

  describe('5s waiting banner + 15s timeout diagnostic (REL-11 / D-12)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('emits a `still waiting` stderr banner at the 5s mark when no URL has appeared', async () => {
      vi.useFakeTimers();

      // Proc that never emits a URL and never exits — just stays alive.
      const fakeProc = makeFakeProcess({
        stderrLines: ['2024-01-01T00:00:00Z INF Booting'],
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: makeSpawnFn(fakeProc),
        readyTimeoutMs: 15_000,
        pidFile: '/tmp/test-tunnel-5s.pid',
      });

      // Fire start() — it never resolves because the fake never prints a URL.
      const startP = transport.start(LOCAL);
      // We need to attach a catch handler to prevent unhandled-rejection noise
      // when we eventually let the 15s timeout fire (test cleanup).
      startP.catch(() => {
        /* expected when 15s timeout fires during teardown */
      });

      // Flush microtasks so stderr.on('data') is wired.
      await vi.advanceTimersByTimeAsync(0);

      // Advance to just before the 5s mark — banner should NOT have fired yet.
      await vi.advanceTimersByTimeAsync(4_999);
      const before = warnSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && /still waiting/i.test(c[0]),
      );
      expect(before).toBeUndefined();

      // Tip past 5s — banner fires.
      await vi.advanceTimersByTimeAsync(2);
      const after = warnSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && /still waiting for tunnel URL/i.test(c[0]),
      );
      expect(after).toBeDefined();

      // Cleanup — advance past 15s timeout so the rejection fires once and we
      // can stop the transport cleanly.
      await vi.advanceTimersByTimeAsync(11_000);
      warnSpy.mockRestore();
      await transport.stop();
    });

    it('does NOT emit the 5s banner when a URL appears before the 5s mark', async () => {
      vi.useFakeTimers();

      const fakeProc = makeFakeProcess({
        stderrLines: [
          '2024-01-01T00:00:00Z INF | https://quick-test.trycloudflare.com |',
        ],
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: makeSpawnFn(fakeProc),
        readyTimeoutMs: 15_000,
        pidFile: '/tmp/test-tunnel-no5s.pid',
      });

      const startP = transport.start(LOCAL);
      // Flush microtasks — URL hits stderr immediately.
      await vi.advanceTimersByTimeAsync(0);
      await startP;

      // Advance past 5s — the timer was cleared on settle.
      await vi.advanceTimersByTimeAsync(10_000);
      const banner = warnSpy.mock.calls.find(
        (c) => typeof c[0] === 'string' && /still waiting/i.test(c[0]),
      );
      expect(banner).toBeUndefined();

      warnSpy.mockRestore();
      await transport.stop();
    });

    it('15s timeout rejects with a structured diagnostic (D-12)', async () => {
      // Use real timers (short readyTimeoutMs) so we don't have to coordinate
      // fake timers with the rejection's Error message construction.
      const fakeProc = makeFakeProcess({
        stderrLines: [
          'INF Starting cloudflared',
          'INF Connecting to edge',
          'INF Connected to fra08',
        ],
      });

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        args: ['tunnel'],
        spawn: makeSpawnFn(fakeProc),
        readyTimeoutMs: 50,
        pidFile: '/tmp/test-tunnel-15s-diag.pid',
      });

      let caught: Error | null = null;
      try {
        await transport.start(LOCAL);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      const msg = caught!.message;
      // Structured diagnostic fields per D-12.
      expect(msg).toContain('cloudflared binary:');
      expect(msg).toContain('exited:');
      expect(msg).toContain('stderr_lines_seen:');
      expect(msg).toContain('last_stderr_line:');
      // Actionable text.
      expect(msg).toContain('--no-cloudflared');
      expect(msg).toContain('LAN mode');
      // Includes args (we passed `'tunnel'`).
      expect(msg).toContain('tunnel');
    });

    it('15s diagnostic reports stderr line count and the last (trimmed, ≤200 char) line', async () => {
      const longLastLine = 'INF ' + 'x'.repeat(500); // 504 chars — should be truncated.
      const fakeProc = makeFakeProcess({
        stderrLines: ['INF line one', 'INF line two', longLastLine],
      });

      const transport = new CloudflaredTransport({
        command: 'cloudflared',
        spawn: makeSpawnFn(fakeProc),
        readyTimeoutMs: 50,
        pidFile: '/tmp/test-tunnel-15s-stderr.pid',
      });

      let caught: Error | null = null;
      try {
        await transport.start(LOCAL);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      const msg = caught!.message;
      // Three '\n'-terminated lines were emitted (Readable.from appends '\n' per line).
      expect(msg).toMatch(/stderr_lines_seen: 3/);
      // last_stderr_line is JSON-encoded — should contain a truncated prefix
      // of the long line (≤200 chars), and NOT contain all 500 'x's.
      const lastLineMatch = msg.match(/last_stderr_line: "([^"]*)"/);
      expect(lastLineMatch).not.toBeNull();
      // Truncated content: starts with "INF " followed by xs, capped at 200.
      expect(lastLineMatch![1]!.length).toBeLessThanOrEqual(200);
      expect(lastLineMatch![1]!.startsWith('INF xxx')).toBe(true);
    });
  });
});
