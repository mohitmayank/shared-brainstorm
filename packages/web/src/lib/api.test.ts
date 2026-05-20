import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postCoordinatorJoin, postCoordinatorAnswer } from './api.js';

// The two coordinator REST helpers reuse the shared `post<T>` wrapper: they send
// JSON with `credentials: 'include'` (so the sb_c cookie rides along), resolve on
// 200, and reject with an Error carrying a `.status` property on non-2xx.

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('lib/api — coordinator helpers', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe('postCoordinatorJoin', () => {
    it('POSTs { token } to /api/coordinator/join with credentials and resolves on 200', async () => {
      const f = mockFetch(200, { ok: true });
      globalThis.fetch = f;
      const res = await postCoordinatorJoin('tok_abc');
      expect(res).toEqual({ ok: true });
      expect(f).toHaveBeenCalledTimes(1);
      const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock
        .calls[0]!;
      expect(url).toBe('/api/coordinator/join');
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(JSON.parse(init.body as string)).toEqual({ token: 'tok_abc' });
    });

    it('rejects with an Error carrying .status on 401', async () => {
      globalThis.fetch = mockFetch(401, { error: 'not_coordinator' });
      await expect(postCoordinatorJoin('bad')).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('postCoordinatorAnswer', () => {
    it('POSTs the answer body to /api/coordinator/answer and resolves on 200', async () => {
      const f = mockFetch(200, { ok: true });
      globalThis.fetch = f;
      const res = await postCoordinatorAnswer({
        ticket_id: 't1',
        value: 'do it this way',
        source: 'suggestion',
      });
      expect(res).toEqual({ ok: true });
      const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock
        .calls[0]!;
      expect(url).toBe('/api/coordinator/answer');
      expect(JSON.parse(init.body as string)).toEqual({
        ticket_id: 't1',
        value: 'do it this way',
        source: 'suggestion',
      });
    });

    it('rejects with .status === 409 on already-resolved', async () => {
      globalThis.fetch = mockFetch(409, { error: 'already_resolved' });
      await expect(
        postCoordinatorAnswer({ ticket_id: 't1', value: 'x', source: 'override' }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});
