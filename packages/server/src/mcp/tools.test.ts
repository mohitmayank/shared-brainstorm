import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { AskGroupUnionInput } from '@shared-brainstorm/shared';

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
  it('creates a session and returns session_id, public_url, invite_text (no join_code in v2.0.0)', async () => {
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
      expect((result as unknown as Record<string, unknown>)['join_code']).toBeUndefined();
      expect(result.invite_text).toContain(result.public_url);
      expect(result.clipboard_copied).toBe(true);
      expect(result.coordinator_url).toMatch(
        /^https?:\/\/.+\?role=coordinator&token=[A-Za-z0-9_-]{22}$/,
      );
      expect(result.coordinator_url).toContain(result.public_url.replace(/\/$/, ''));
      expect(result.invite_text).not.toContain('coordinator'); // Pitfall 6 guard
      expect(result.invite_text).not.toContain(result.coordinator_url);
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
      expect(result.invite_text).toContain(result.public_url);
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
      const result = askGroup({ question: 'Which approach do you prefer?' }) as { ticket_id: string };
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
      const { ticket_id } = askGroup({ question: 'Which approach?' }) as { ticket_id: string };
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
      const { ticket_id } = askGroup({ question: 'Which approach?' }) as { ticket_id: string };

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
      const { ticket_id } = askGroup({ question: 'Pick one' }) as { ticket_id: string };
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
      ).toThrow(/not found in open or terminal questions/);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tools.recordAnswer with ticket_id matching an open question resolves successfully', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'b' }, { transportFactory: 'mock', transcriptDir: dir });
      const result = askGroup({ question: 'Pick one' }) as { ticket_id: string };
      const out = recordAnswer({ ticket_id: result.ticket_id, value: 'Postgres', source: 'override' });
      expect(out.ok).toBe(true);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 9 (SYNC-02): Wave 0 stubs — recordAnswer race: ok:false path
// These tests document the expected behaviour once Wave 2 implements
// getTerminalResolution() on SessionManager and the tools.ts wrapper returns
// { ok: false, reason: 'already_resolved', resolution } instead of throwing.
// They are marked describe.skip because the production code does not exist yet;
// Wave 2 will un-skip them.
// ---------------------------------------------------------------------------
describe('recordAnswer race: ok:false path (Wave 2 implementation)', () => {
  it('D-03 (a): returns { ok: false, reason: "already_resolved", resolution } when ticket already resolved (web pick landed first)', async () => {
    // Wave 0 stub — Wave 2 implements getTerminalResolution + tools.ts race path.
    // Setup: start session → askGroup → resolve via HTTP coordinator pick → call
    // recordAnswer MCP tool with the same ticket_id → expect ok:false NOT a throw.
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'race' }, { transportFactory: 'mock', transcriptDir: dir });
      const { ticket_id } = askGroup({ question: 'Race question?' }) as { ticket_id: string };
      const mgr = mcpState.manager!;
      const qid = mgr.currentQuestion()!.id;
      // Simulate web pick: resolve via domain recordAnswer (coordinator attribution)
      mgr.recordAnswer({ question_id: qid, value: 'Web won', source: 'suggestion' });
      // MCP tool wrapper must NOT throw — must return ok:false
      const out = recordAnswer({ ticket_id, value: 'Initiator answer', source: 'override' });
      expect(out.ok).toBe(false);
      // Use cast through unknown to access the ok:false branch fields without TS narrowing issues
      const failed = out as unknown as { ok: false; reason: string; resolution: { value: string; source: string; picked_by: string } };
      expect(failed.reason).toBe('already_resolved');
      expect(failed.resolution).toBeDefined();
      expect(typeof failed.resolution.value).toBe('string');
      expect(typeof failed.resolution.source).toBe('string');
      expect(typeof failed.resolution.picked_by).toBe('string');
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D-03 (b): resolution.picked_by is populated (non-empty string) on the ok:false response', async () => {
    // Wave 0 stub — Wave 2 provides picked_by attribution in resolution.
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'race-pickedby' }, { transportFactory: 'mock', transcriptDir: dir });
      const { ticket_id } = askGroup({ question: 'Who picks?' }) as { ticket_id: string };
      const mgr = mcpState.manager!;
      const qid = mgr.currentQuestion()!.id;
      // Resolve with picked_by attribution (Wave 2 adds this param to recordAnswer)
      // For now use the domain-level call — Wave 2 will pass picked_by through
      mgr.recordAnswer({ question_id: qid, value: 'Team choice', source: 'suggestion' });
      const out = recordAnswer({ ticket_id, value: 'Late', source: 'override' });
      expect(out.ok).toBe(false);
      // Use cast through unknown to access the ok:false branch fields without TS narrowing issues
      const failed = out as unknown as { ok: false; resolution: { picked_by: string } };
      expect(failed.resolution.picked_by).toBeTruthy();
      expect(failed.resolution.picked_by.length).toBeGreaterThan(0);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D-03 (c): existing ok:true path — recordAnswer on a live open question still returns { ok: true }', async () => {
    // Wave 0 stub — this is the happy path; must remain unchanged after Wave 2.
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'ok-true' }, { transportFactory: 'mock', transcriptDir: dir });
      const { ticket_id } = askGroup({ question: 'Open question?' }) as { ticket_id: string };
      // Question is still open — recordAnswer should succeed with ok:true
      const out = recordAnswer({ ticket_id, value: 'Good answer', source: 'override' });
      expect(out.ok).toBe(true);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6: AskGroupUnionInput schema tests
// ---------------------------------------------------------------------------
describe('Phase 6: AskGroupUnionInput schema (BATCH-01)', () => {
  it('AskGroupUnionInput.parse({question:Q1}) succeeds and produces AskGroupInput shape (back-compat)', () => {
    const result = AskGroupUnionInput.parse({ question: 'Q1' });
    expect((result as Record<string, unknown>)['question']).toBe('Q1');
    expect((result as Record<string, unknown>)['questions']).toBeUndefined();
  });

  it('AskGroupUnionInput.parse({questions:[{question:Q1},{question:Q2}]}) succeeds and questions has length 2', () => {
    const result = AskGroupUnionInput.parse({ questions: [{ question: 'Q1' }, { question: 'Q2' }] });
    expect((result as Record<string, unknown>)['questions']).toHaveLength(2);
  });

  it('AskGroupUnionInput.parse({questions:[...11 items...]}) throws ZodError (max=10 cap)', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ question: `Q${i}` }));
    expect(() => AskGroupUnionInput.parse({ questions: items })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Phase 6: tools.askGroup batch path (BATCH-01)
// ---------------------------------------------------------------------------
describe('Phase 6: askGroup batch (BATCH-01)', () => {
  it('tools.askGroup({question:Q1}) returns {ticket_id:string} — no tickets field', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'batch' }, { transportFactory: 'mock', transcriptDir: dir });
      const result = askGroup({ question: 'Q1?' });
      expect((result as Record<string, unknown>)['ticket_id']).toMatch(/^sb_t_/);
      expect((result as Record<string, unknown>)['tickets']).toBeUndefined();
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tools.askGroup({questions:[{question:Q1},{question:Q2}]}) returns {tickets:[{question_id,ticket_id},...]}, 2 items', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'batch' }, { transportFactory: 'mock', transcriptDir: dir });
      const result = askGroup({ questions: [{ question: 'Q1?' }, { question: 'Q2?' }] }) as {
        tickets: Array<{ question_id: string; ticket_id: string }>;
      };
      expect(result.tickets).toHaveLength(2);
      expect(result.tickets[0]!.question_id).toMatch(/^sb_q_/);
      expect(result.tickets[0]!.ticket_id).toMatch(/^sb_t_/);
      expect(result.tickets[1]!.question_id).toMatch(/^sb_q_/);
      expect(result.tickets[1]!.ticket_id).toMatch(/^sb_t_/);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tools.askGroup batch calls redactQuestion once per question item (2 questions = 2 redact calls)', async () => {
    const dir = makeTmpDir();
    try {
      await startSession({ brief: 'batch' }, { transportFactory: 'mock', transcriptDir: dir });
      const redactMod = await import('../redact/redact.js');
      const spy = vi.spyOn(redactMod, 'redactQuestion');
      askGroup({ questions: [{ question: 'Q1?' }, { question: 'Q2?' }] });
      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tools.askGroup({question:Q1}) with no active session throws No active session', () => {
    // mcpState.manager should be null (beforeEach resets it)
    expect(() => askGroup({ question: 'orphan?' })).toThrow(/No active session/);
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
      const result = askGroup({ question: 'fresh question?' }) as { ticket_id: string };
      expect(result.ticket_id).toMatch(/^sb_t_/);
    } finally {
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('console.error on permanent failure contains honest recovery hint and no fake flag', async () => {
    const dir = makeTmpDir();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await startSession(
        { brief: 'transport-failed console hint' },
        { transportFactory: 'mock', transcriptDir: dir },
      );
      const cb = asMockTransport(mcpState.transport)._getOnErrorCb();
      expect(cb).not.toBeNull();

      cb!({
        code: 'cloudflared_permanent_failure',
        message: 'sim',
        restart_count: 3,
      });

      expect(consoleSpy).toHaveBeenCalledOnce();
      const msg = consoleSpy.mock.calls[0]?.[0] as string;
      expect(msg).toContain('stop and restart');
      expect(msg).not.toContain('--no-cloudflared');
    } finally {
      consoleSpy.mockRestore();
      await stopSession().catch(() => null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
