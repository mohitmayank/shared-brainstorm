import { describe, expect, it } from 'vitest';
import { buildApp } from './server.js';
import { SessionManager } from '../session/SessionManager.js';
import { fixedClock } from '../session/clock.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const mgr = new SessionManager({
    clock: fixedClock('2026-04-29T12:00:00Z'),
    transcriptDir: mkdtempSync(join(tmpdir(), 'sb-')),
  });
  mgr.start({ brief: 'auth flow' });
  const app = buildApp({ manager: mgr });
  return { app, mgr };
}

function json(body: Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  return { method: 'POST' as const, body: JSON.stringify(body), headers };
}

async function joinAs(app: ReturnType<typeof buildApp>, mgr: SessionManager, name: string) {
  const body: Record<string, string> = { display_name: name, join_code: mgr.joinCode() };
  const res = await app.request('/api/join', json(body));
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const data = (await res.json()) as { id: string; display_name: string };
  return { cookie, ...data };
}

describe('HTTP API', () => {
  it('GET /api/session returns 401 if not joined', async () => {
    const { app } = setup();
    const res = await app.request('/api/session');
    expect(res.status).toBe(401);
  });

  it('POST /api/join requires correct join_code', async () => {
    const { app } = setup();
    const bad = await app.request('/api/join', json({ display_name: 'A', join_code: '000000' }));
    expect(bad.status).toBe(403);
  });

  it('POST /api/join with correct code returns participant (no role field)', async () => {
    const { app, mgr } = setup();
    const res = await app.request(
      '/api/join',
      json({ display_name: 'Alice', join_code: mgr.joinCode() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['display_name']).toBe('Alice');
    expect('role' in body).toBe(false);
    expect(res.headers.get('set-cookie')).toMatch(/sb_p=/);
  });

  it('POST /api/join ignores coordinator_token (legacy field)', async () => {
    const { app, mgr } = setup();
    const res = await app.request(
      '/api/join',
      json({
        display_name: 'C',
        join_code: mgr.joinCode(),
        coordinator_token: 'sbc_anything',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('role' in body).toBe(false);
  });

  it('POST /api/suggestion requires joined cookie', async () => {
    const { app } = setup();
    const r = await app.request('/api/suggestion', json({ question_id: 'x', value: 'y' }));
    expect(r.status).toBe(401);
  });

  it('POST /api/accept route is gone', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    mgr.askGroup({ question: 'q' });
    const r = await app.request(
      '/api/accept',
      json({ question_id: mgr.currentQuestion()!.id, value: 'a' }, cookie),
    );
    expect(r.status).toBe(404);
  });

  it('POST /api/preview-approve route is gone', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    const r = await app.request(
      '/api/preview-approve',
      json({ question_id: 'x' }, cookie),
    );
    expect(r.status).toBe(404);
  });

  it('POST /api/preview-default route is gone', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    const r = await app.request(
      '/api/preview-default',
      json({ preview_default: false }, cookie),
    );
    expect(r.status).toBe(404);
  });

  it('GET /api/session returns session view for joined participant', async () => {
    const { app, mgr } = setup();
    const { cookie } = await joinAs(app, mgr, 'Alice');
    const r = await app.request('/api/session', { headers: { cookie } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { brief: string };
    expect(body.brief).toBe('auth flow');
  });
});
