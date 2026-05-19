import { test, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptV2 } from '../packages/shared/src/transcript.js';

// ESM-safe path resolution (mirrors packages/server/bin/shim.test.ts pattern).
const here = dirname(fileURLToPath(import.meta.url));
const shimPath = resolve(here, '..', 'packages', 'server', 'bin', 'shared-brainstorm.js');
const distPath = resolve(here, '..', 'packages', 'server', 'dist', 'cli.js');

// Skip if the server hasn't been built yet — be loud about the reason (lesson #13).
test.skip(!existsSync(distPath), 'dist/cli.js not found — run `npm run build -w packages/server` first');

// 30s budget: subprocess boot + MCP stdio handshake + SIGINT + transcript flush.
test.setTimeout(30_000);

test('signal-handling: SIGINT writes transcript with ended_reason=signal', async () => {
  // (a) Isolate the subprocess HOME so its transcript never pollutes the developer's
  //     real ~/.shared-brainstorm/sessions/ directory (T-01-sig-home-pollution mitigation).
  const tmpHome = mkdtempSync(join(tmpdir(), 'sb-e2e-sig-'));
  const sessionsDir = join(tmpHome, '.shared-brainstorm', 'sessions');

  let child: ChildProcessWithoutNullStreams | null = null;

  try {
    // (b) Spawn the bin shim with HOME overridden to the tmp dir.
    //     Using 'pipe' for all stdio so we can send MCP frames on stdin and
    //     read JSON-RPC responses from stdout.
    child = spawn('node', [shimPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: tmpHome },
    });

    // (c) Buffer stdout line-by-line; stderr is captured for debugging but not parsed.
    let stdoutBuf = '';
    let stderrBuf = '';
    const stdoutFrames: unknown[] = [];

    child.stdout.on('data', (d: Buffer) => {
      stdoutBuf += d.toString();
      // MCP stdio transport uses newline-delimited JSON — one object per line.
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.length === 0) continue;
        try {
          stdoutFrames.push(JSON.parse(line));
        } catch {
          // Non-JSON line on stdout (unexpected, but ignore defensively).
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
    });

    /** Poll stdoutFrames until a frame with the given id is found, or timeout. */
    async function waitForFrameById(id: number, timeoutMs: number): Promise<unknown> {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const frame = stdoutFrames.find((f) => (f as { id?: number }).id === id);
        if (frame) return frame;
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      throw new Error(
        `Timed out waiting for JSON-RPC frame id=${id} after ${timeoutMs}ms.\nstderr=${stderrBuf}`,
      );
    }

    /** Write a single JSON-RPC frame (one line) to the subprocess stdin. */
    function writeFrame(frame: unknown): void {
      child!.stdin.write(JSON.stringify(frame) + '\n');
    }

    // (d) Full MCP stdio handshake — concrete frames from the plan's <interfaces> block.
    //
    // Frame 1: initialize (id 1)
    writeFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-test', version: '1.0.0' },
      },
    });
    await waitForFrameById(1, 5_000);

    // Frame 2: notifications/initialized (no id, no response expected)
    writeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // Frame 3: tools/call startSession (id 2)
    writeFrame({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'startSession',
        arguments: { brief: 'signal test' },
      },
    });
    const startResponse = await waitForFrameById(2, 10_000);
    // Receiving the response confirms the session is live and the transcript will be written.
    expect(startResponse).toBeDefined();

    // (e) Send SIGINT to the subprocess (targets the specific subprocess PID, NOT the test
    //     runner — per RESEARCH Pitfall 4: child.kill('SIGINT') is safe here because it
    //     delivers the signal to the child process group, not the Playwright test process).
    child.kill('SIGINT');

    // (f) Wait for the subprocess to exit.
    //     cli.ts installSignalHandlers() → onSig('SIGINT') → flushOnExit('signal') →
    //     manager.stop('signal') → writes transcript → process.exit(130).
    const exitCode = await new Promise<number>((r) => {
      child!.on('close', (code) => r(code ?? -1));
    });
    expect(exitCode).toBe(130);

    // (g) Find the transcript file written by the subprocess under tmpHome.
    //     There must be exactly one .json file in sessionsDir.
    expect(existsSync(sessionsDir)).toBe(true);
    const files = readdirSync(sessionsDir);
    expect(files).toHaveLength(1);
    const transcriptName = files[0]!;
    expect(transcriptName).toMatch(/\.json$/);

    // (h) Parse the transcript via TranscriptV2 and assert ended_reason='signal' (D-08).
    //     TranscriptV2.parse() throws on schema mismatch — this IS the primary assertion.
    //     There is no fallback path: D-08 requires the transcript assertion.
    const raw = readFileSync(join(sessionsDir, transcriptName), 'utf8');
    const parsed = TranscriptV2.parse(JSON.parse(raw));
    expect(parsed.ended_reason).toBe('signal');
    expect(parsed.brief).toBe('signal test');
  } finally {
    // (i) Ensure the subprocess is dead and the tmp HOME is cleaned up regardless of
    //     whether the test passed or threw.
    if (child && !child.killed) {
      child.kill('SIGKILL');
    }
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
