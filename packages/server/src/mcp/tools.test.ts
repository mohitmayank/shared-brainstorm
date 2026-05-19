import { describe, it, expect, beforeEach } from 'vitest';
import { mcpState } from './state.js';
import {
  startSession,
  askGroup,
  awaitAnswer,
  recordAnswer,
  stopSession,
} from './tools.js';
import type { Transport, TransportErrorReason } from '../transport/Transport.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'sb-mcp-'));
}

/**
 * MockTransport in tools.ts is module-private but exposes `_getOnErrorCb()` for
 * tests. We narrow the transport reference via this structural shape so the
 * test does not require exporting the class.
 */
interface MockTransportAccessors extends Transport {
  _getOnErrorCb(): ((reason: TransportErrorReason) => void) | null;
}

function asMockTransport(t: Transport | null): MockTransportAccessors {
  if (!t) throw new Error('mcpState.transport is null');
  return t as MockTransportAccessors;
}

beforeEach(async () => {
  if (mcpState.manager) {
    try {
      mcpState.manager.stop('stop_session');
    } catch {
      /* ignore */
    }
  }
  if (mcpState.transport) {
    try {
      await mcpState.transport.stop();
    } catch {
      /* ignore */
    }
  }
  if (mcpState.http) {
    try {
      await mcpState.http.close();
    } catch {
      /* ignore */
    }
  }
  mcpState.manager = null;
  mcpState.transport = null;
  mcpState.http = null;
  mcpState.publicUrl = null;
  mcpState.transportFailed = false;
  mcpState.lastTransportError = null;
});

describe('startSession', () => {
  it('creates a session and returns session_id, public_url, join_code, invite_text', async () => {
    const dir = makeTmpDir();
    try {
      const result = await startSession(
        { brief: 'test brainstorm' },
        {
          transportFactory: 'mock',
          transcriptDir: dir,
          // Stub clipboard so the test doesn't depend on the host OS.
          copyToClipboard: async () => 'stub',
        },
      );
      expect(result.session_id).toMatch(/^sb_s_/);
      expect(result.public_url).toMatch(/^http:\/\//);
      expect(result.join_code).toMatch(/^\d{6}$/);
      expect(result.invite_text).toContain(result.public_url);
      expect(result.invite_text).toContain(result.join_code);
      expect(result.clipboard_copied).toBe(true);
      expect('coordinator_url' in result).toBe(false);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clipboard_copied is false when no clipboard tool is available', async () => {
    const dir = makeTmpDir();
    try {
      const result = await startSession(
        { brief: 'headless' },
        {
          transportFactory: 'mock',
          transcriptDir: dir,
          copyToClipboard: async () => null,
        },
      );
      expect(result.clipboard_copied).toBe(false);
      // invite_text is still composed — clipboard is a nice-to-have.
      expect(result.invite_text).toContain(result.public_url);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SHARED_BRAINSTORM_NO_CLIPBOARD=1 suppresses clipboard copy entirely', async () => {
    const dir = makeTmpDir();
    const original = process.env['SHARED_BRAINSTORM_NO_CLIPBOARD'];
    process.env['SHARED_BRAINSTORM_NO_CLIPBOARD'] = '1';
    let copyCalled = false;
    try {
      const result = await startSession(
        { brief: 'suppressed' },
        {
          transportFactory: 'mock',
          transcriptDir: dir,
          copyToClipboard: async () => {
            copyCalled = true;
            return 'stub';
          },
        },
      );
      expect(copyCalled).toBe(false);
      expect(result.clipboard_copied).toBe(false);
      expect(result.invite_text).toContain(result.join_code);
    } finally {
      if (original === undefined) delete process.env['SHARED_BRAINSTORM_NO_CLIPBOARD'];
      else process.env['SHARED_BRAINSTORM_NO_CLIPBOARD'] = original;
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when a session is already active', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'first' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      await expect(
        startSession({ brief: 'second' }, { transportFactory: 'mock', transcriptDir: dir }),
      ).rejects.toThrow(/already active/i);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves the SPA at / (regression: URL must work in browser)', async () => {
    const dir = makeTmpDir();
    const spaDir = makeTmpDir();
    writeFileSync(join(spaDir, 'index.html'), '<!doctype html><div id=root>SPA</div>');
    try {
      const { public_url } = await startSession(
        { brief: 'static serving' },
        { transportFactory: 'mock', transcriptDir: dir, staticDir: spaDir },
      );
      const res = await fetch(public_url + '/');
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('SPA');
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
      rmSync(spaDir, { recursive: true, force: true });
    }
  });

  it('calls selectTransport when transportFactory is not mock', async () => {
    const dir = makeTmpDir();
    let called = false;
    let receivedPrefer: string | undefined;
    try {
      await startSession(
        { brief: 'pick a transport' },
        {
          transcriptDir: dir,
          transportFactory: 'lan',
          selectTransport: async (selectOpts) => {
            called = true;
            receivedPrefer = selectOpts?.prefer;
            return new (await import('../transport/LanTransport.js')).LanTransport();
          },
        },
      );
      expect(called).toBe(true);
      expect(receivedPrefer).toBe('lan');
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not call selectTransport when transportFactory is mock', async () => {
    const dir = makeTmpDir();
    let called = false;
    try {
      await startSession(
        { brief: 'mock path' },
        {
          transcriptDir: dir,
          transportFactory: 'mock',
          selectTransport: async () => {
            called = true;
            throw new Error('should not be reached for mock');
          },
        },
      );
      expect(called).toBe(false);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('askGroup', () => {
  it('returns a ticket_id and broadcasts immediately', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'brainstorm' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      const result = askGroup({ question: 'Which approach do you prefer?' });
      expect(result.ticket_id).toMatch(/^sb_t_/);
      // Question lands in 'broadcast' (not 'preview') status.
      expect(mcpState.manager!.currentQuestion()?.status).toBe('broadcast');
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('awaitAnswer', () => {
  it('returns a snapshot of suggestions+comments with participant names', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'b' }, { transportFactory: 'mock', transcriptDir: dir });
      const mgr = mcpState.manager!;
      const alice = mgr.addParticipant({ display_name: 'Alice' });
      const bob = mgr.addParticipant({ display_name: 'Bob' });
      const { ticket_id } = askGroup({ question: 'Which approach?' });
      const qid = mgr.currentQuestion()!.id;
      mgr.postSuggestion({ participant_id: alice.id, question_id: qid, value: 'X' });
      mgr.postComment({ participant_id: bob.id, question_id: qid, text: 'maybe Y' });

      const snap = await awaitAnswer({ ticket_id, timeout_s: 1 });
      expect(snap.resolved).toBe(false);
      expect(snap.suggestions).toEqual([
        { participant_name: 'Alice', value: 'X', at: expect.any(String) },
      ]);
      expect(snap.comments).toEqual([
        { participant_name: 'Bob', text: 'maybe Y', at: expect.any(String) },
      ]);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns snapshot with resolved=true after recordAnswer', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'b' }, { transportFactory: 'mock', transcriptDir: dir });
      const { ticket_id } = askGroup({ question: 'Which approach?' });

      // Resolve in the background.
      setTimeout(() => {
        recordAnswer({ ticket_id, value: 'Option A', source: 'override' });
      }, 50);

      const snap = await awaitAnswer({ ticket_id, timeout_s: 5 });
      expect(snap.resolved).toBe(true);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordAnswer', () => {
  it('resolves the ticket and pushes to decisions', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'b' }, { transportFactory: 'mock', transcriptDir: dir });
      const { ticket_id } = askGroup({ question: 'Pick one' });
      const out = recordAnswer({ ticket_id, value: 'Postgres', source: 'override' });
      expect(out.ok).toBe(true);
      expect(mcpState.manager!.sessionView().decisions).toEqual([
        expect.objectContaining({ answer: 'Postgres' }),
      ]);
      expect(mcpState.manager!.currentQuestion()).toBeNull();
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects mismatched ticket_id', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'b' }, { transportFactory: 'mock', transcriptDir: dir });
      askGroup({ question: 'q?' });
      expect(() =>
        recordAnswer({ ticket_id: 'sb_t_bogus', value: 'A', source: 'override' }),
      ).toThrow(/does not match the current question/);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stopSession', () => {
  it('clears state and returns transcript_path', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'stop test' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      expect(mcpState.manager).not.toBeNull();

      const result = await stopSession();

      expect(result.ok).toBe(true);
      expect(result.transcript_path).toBeTruthy();
      expect(mcpState.manager).toBeNull();
      expect(mcpState.transport).toBeNull();
      expect(mcpState.http).toBeNull();
      expect(mcpState.publicUrl).toBeNull();
      expect(mcpState.transportFailed).toBe(false);
      expect(mcpState.lastTransportError).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transport_failed (REL-03 wiring)', () => {
  it('startSession initialises mcpState.transportFailed=false and lastTransportError=null', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'transport-failed init' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      expect(mcpState.transportFailed).toBe(false);
      expect(mcpState.lastTransportError).toBeNull();
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invoking onError sets mcpState flag + last-error snapshot and broadcasts a ring-buffered transport_failed event', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'transport-failed fire' },
        { transportFactory: 'mock', transcriptDir: dir },
      );

      const cb = asMockTransport(mcpState.transport)._getOnErrorCb();
      expect(cb).not.toBeNull();

      const reason: TransportErrorReason = {
        code: 'cloudflared_permanent_failure',
        message: 'simulated permanent failure',
        restart_count: 3,
      };
      cb!(reason);

      expect(mcpState.transportFailed).toBe(true);
      expect(mcpState.lastTransportError).not.toBeNull();
      expect(mcpState.lastTransportError?.code).toBe(reason.code);
      expect(mcpState.lastTransportError?.message).toBe(reason.message);
      expect(mcpState.lastTransportError?.restart_count).toBe(reason.restart_count);
      // `at` is an ISO timestamp set at fire-time; just sanity check it parses.
      expect(mcpState.lastTransportError?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Number.isNaN(Date.parse(mcpState.lastTransportError!.at))).toBe(false);

      // Ring-buffered: replay(-1) returns all events since (and including) seq 0.
      // The transport_failed event should be present.
      const events = mcpState.manager!.replay(-1);
      const failedEvents = events.filter((e) => e.type === 'transport_failed');
      expect(failedEvents).toHaveLength(1);
      // The generic Envelope<P> helper in packages/shared/src/events.ts erases
      // the literal type discriminator at d.ts generation, so TS cannot narrow
      // `evt.payload` from `evt.type === 'transport_failed'` alone. Cast the
      // payload through `unknown` once we have already filtered by type.
      const evt = failedEvents[0]!;
      const payload = evt.payload as unknown as {
        code: string;
        message: string;
        restart_count: number;
        at: string;
      };
      expect(evt.type).toBe('transport_failed');
      expect(payload.code).toBe(reason.code);
      expect(payload.message).toBe(reason.message);
      expect(payload.restart_count).toBe(reason.restart_count);
      expect(payload.at).toBe(mcpState.lastTransportError!.at);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('askGroup throws a transport_failed error after onError has fired', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'transport-failed gate' },
        { transportFactory: 'mock', transcriptDir: dir },
      );

      const cb = asMockTransport(mcpState.transport)._getOnErrorCb();
      cb!({
        code: 'cloudflared_permanent_failure',
        message: 'simulated permanent failure',
        restart_count: 3,
      });

      expect(() => askGroup({ question: 'will this go through?' })).toThrow(
        /transport_failed/,
      );
      // Error message should also surface code and restart_count for debuggability.
      expect(() => askGroup({ question: 'will this go through?' })).toThrow(
        /cloudflared_permanent_failure/,
      );
      expect(() => askGroup({ question: 'will this go through?' })).toThrow(/restart_count=3/);
      // And the gate must NOT have created a question — manager state is untouched.
      expect(mcpState.manager!.currentQuestion()).toBeNull();
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stopSession resets transport-failure state; subsequent startSession starts clean', async () => {
    const dir = makeTmpDir();
    try {
      await startSession(
        { brief: 'first session — will fail' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      const cb = asMockTransport(mcpState.transport)._getOnErrorCb();
      cb!({
        code: 'cloudflared_permanent_failure',
        message: 'simulated permanent failure',
        restart_count: 3,
      });
      expect(mcpState.transportFailed).toBe(true);

      await stopSession();
      expect(mcpState.transportFailed).toBe(false);
      expect(mcpState.lastTransportError).toBeNull();

      // New session must start with the flag cleared and askGroup must work.
      await startSession(
        { brief: 'second session — fresh' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      expect(mcpState.transportFailed).toBe(false);
      expect(mcpState.lastTransportError).toBeNull();
      const result = askGroup({ question: 'fresh question?' });
      expect(result.ticket_id).toMatch(/^sb_t_/);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
