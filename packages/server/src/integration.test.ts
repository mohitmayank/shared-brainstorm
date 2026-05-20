import { describe, expect, it, afterEach } from 'vitest';
import {
  startSession,
  askGroup,
  awaitAnswer,
  recordAnswer,
  stopSession,
} from './mcp/tools.js';
import { mcpState } from './mcp/state.js';
import { existsSync, readFileSync } from 'node:fs';

describe('Full integration: start → join → ask → suggest → record → stop', () => {
  afterEach(async () => {
    if (mcpState.manager) {
      await stopSession().catch(() => {});
    }
  });

  it('runs the complete brainstorm lifecycle', async () => {
    // 1. Start session
    const session = await startSession(
      { brief: 'auth flow design' },
      { transportFactory: 'mock' },
    );
    expect(session.session_id).toMatch(/^sb_s_/);
    expect(session.public_url).toMatch(/^http:\/\//);
    expect((session as unknown as Record<string, unknown>)['join_code']).toBeUndefined();
    expect(session.coordinator_url).toMatch(/\?role=coordinator&token=[A-Za-z0-9_-]{22}$/);
    expect(session.invite_text).not.toContain(session.coordinator_url);

    const mgr = mcpState.manager!;
    const app = mcpState.http!;
    expect(app.port).toBeGreaterThan(0);

    // 2. Two teammates join via REST (no join code required in v2.0.0)
    const aliceRes = await fetch(`${app.url}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Alice' }),
    });
    expect(aliceRes.status).toBe(200);
    const aliceData = (await aliceRes.json()) as { id: string };
    const aliceCookie = aliceRes.headers.get('set-cookie')!.split(';')[0]!;
    // v2.0.0: approve so Alice can post suggestions/comments.
    mgr.approveParticipant(aliceData.id as Parameters<typeof mgr.approveParticipant>[0]);

    const bobRes = await fetch(`${app.url}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Bob' }),
    });
    expect(bobRes.status).toBe(200);
    const bobData = (await bobRes.json()) as { id: string };
    const bobCookie = bobRes.headers.get('set-cookie')!.split(';')[0]!;
    // v2.0.0: approve so Bob can post comments.
    mgr.approveParticipant(bobData.id as Parameters<typeof mgr.approveParticipant>[0]);

    // 3. Ask a question (broadcasts immediately, no preview gate)
    const ticket = askGroup({
      question: 'Where should we store refresh tokens?',
      options: [
        { label: 'Keychain', description: 'OS-managed' },
        { label: 'SQLCipher', description: 'App-level control' },
      ],
      recommendation: 'Keychain',
    }) as { ticket_id: string };
    expect(ticket.ticket_id).toMatch(/^sb_t_/);
    expect(mgr.currentQuestion()!.status).toBe('broadcast');

    // 4. Alice posts a suggestion via REST
    const qId = mgr.currentQuestion()!.id;
    const sugRes = await fetch(`${app.url}/api/suggestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: aliceCookie },
      body: JSON.stringify({
        question_id: qId,
        value: 'Keychain',
        rationale: 'Team already familiar',
      }),
    });
    expect(sugRes.status).toBe(200);

    // 5. Bob posts a comment via REST
    const commentRes = await fetch(`${app.url}/api/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: bobCookie },
      body: JSON.stringify({
        question_id: qId,
        text: 'Any rotation policy planned?',
      }),
    });
    expect(commentRes.status).toBe(200);

    // 6. AI host polls awaitAnswer to get the discussion snapshot
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 1 });
    expect(snap.resolved).toBe(false);
    expect(snap.suggestions).toEqual([
      expect.objectContaining({ participant_name: 'Alice', value: 'Keychain' }),
    ]);
    expect(snap.comments).toEqual([
      expect.objectContaining({ participant_name: 'Bob', text: 'Any rotation policy planned?' }),
    ]);

    // 7. AI host (after asking initiator via AskUserQuestion) records the final answer
    const out = recordAnswer({
      ticket_id: ticket.ticket_id,
      value: 'Keychain',
      source: 'suggestion',
    });
    expect(out.ok).toBe(true);

    // 8. Session view shows the decision
    const view = mgr.sessionView();
    expect(view.decisions).toHaveLength(1);
    expect(view.decisions[0]!.answer).toBe('Keychain');
    expect(view.current_question).toBeNull();

    // 9. Stop session
    const stop = await stopSession();
    expect(stop.ok).toBe(true);
    expect(stop.transcript_path).toMatch(/\.json$/);
    expect(existsSync(stop.transcript_path)).toBe(true);

    // 10. Verify transcript content
    const transcript = JSON.parse(readFileSync(stop.transcript_path, 'utf8'));
    expect(transcript.schema_version).toBe(2);
    expect(transcript.brief).toBe('auth flow design');
    expect(transcript.ended_reason).toBe('stop_session');
    expect(transcript.participants).toHaveLength(2);
    expect(transcript.questions).toHaveLength(1);
    expect(transcript.questions[0].resolution.value).toBe('Keychain');
    expect(transcript.questions[0].resolution.source).toBe('suggestion');
    expect(transcript.questions[0].status).toBe('resolved');
  });

  it('GET /api/session returns full view for joined participant', async () => {
    const _session = await startSession({ brief: 'test' }, { transportFactory: 'mock' });
    const mgr = mcpState.manager!;
    const app = mcpState.http!;

    const joinRes = await fetch(`${app.url}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'Bob' }),
    });
    const bobData = (await joinRes.json()) as { id: string };
    const cookie = joinRes.headers.get('set-cookie')!.split(';')[0]!;
    // v2.0.0: approve so Bob can access /api/session.
    mgr.approveParticipant(bobData.id as Parameters<typeof mgr.approveParticipant>[0]);

    const sessRes = await fetch(`${app.url}/api/session`, {
      headers: { cookie },
    });
    expect(sessRes.status).toBe(200);
    const body = (await sessRes.json()) as { brief: string; participants: unknown[] };
    expect(body.brief).toBe('test');
    expect(body.participants).toHaveLength(1);
  });

  it('Phase 6: allows concurrent questions — no BUSY error when asking while question is in flight', async () => {
    await startSession({ brief: 'test' }, { transportFactory: 'mock' });

    // Phase 6 (BATCH-02): concurrent questions are allowed; second askGroup must NOT throw BUSY
    askGroup({ question: 'first?' });
    expect(() => askGroup({ question: 'second?' })).not.toThrow();
    // Both questions should be open
    expect(mcpState.manager!.sessionView().questions).toHaveLength(2);
  });

  it('redaction strips paths from questions', async () => {
    await startSession({ brief: 'test' }, { transportFactory: 'mock' });
    const mgr = mcpState.manager!;

    askGroup({ question: 'Should we store keys at /home/alice/.ssh/id_rsa?' });

    const q = mgr.currentQuestion()!;
    expect(q.text).toContain('<PATH>');
    expect(q.text).not.toContain('/home/alice');
  });
});
