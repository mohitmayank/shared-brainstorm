import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { setParticipantCookie } from './cookies.js';

/**
 * Cookie helper tests — REL-09 (Wave-0 gap closed by 02-04).
 *
 * The shape of the participant cookie is a security-relevant invariant. LAN
 * mode (D-15) MUST keep the existing `HttpOnly; SameSite=Lax; Max-Age=86400`
 * shape with NO `Secure` attribute (Secure cookies are dropped by browsers
 * over plain HTTP). Cloudflared mode (D-16) appends `Secure` so the cookie
 * is bound to the HTTPS public URL.
 */

async function buildAndCall(
  setOpts: Parameters<typeof setParticipantCookie>[2],
  participantId = 'sb_p_abcd',
): Promise<Response> {
  const app = new Hono();
  app.get('/test', (c) => {
    setParticipantCookie(c, participantId, setOpts);
    return c.json({ ok: true });
  });
  return await app.request('/test');
}

describe('setParticipantCookie — REL-09 / D-13 / D-16', () => {
  it('with no opts produces LAN-default attributes (no Secure)', async () => {
    const res = await buildAndCall(undefined);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toBe('sb_p=sb_p_abcd; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    expect(cookie).not.toMatch(/Secure/);
  });

  it('with empty opts object produces LAN-default attributes', async () => {
    const res = await buildAndCall({});
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toBe('sb_p=sb_p_abcd; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    expect(cookie).not.toMatch(/Secure/);
  });

  it('with secure: false explicit produces LAN-default attributes', async () => {
    const res = await buildAndCall({ secure: false });
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toBe('sb_p=sb_p_abcd; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    expect(cookie).not.toMatch(/Secure/);
  });

  it('with secure: true appends Secure attribute (cloudflared mode)', async () => {
    const res = await buildAndCall({ secure: true });
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toBe(
      'sb_p=sb_p_abcd; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure',
    );
    expect(cookie).toMatch(/; Secure$/);
  });

  it('preserves D-16 cookie attributes — does NOT switch to SameSite=Strict', async () => {
    const res = await buildAndCall({ secure: true });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/SameSite=Strict/);
  });

  it('preserves D-16 cookie attributes — does NOT add __Host- prefix', async () => {
    const res = await buildAndCall({ secure: true });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^sb_p=/);
    expect(cookie).not.toMatch(/^__Host-/);
  });

  it('URI-encodes participant id containing reserved characters', async () => {
    // An id containing `=` would otherwise terminate the cookie value early.
    const res = await buildAndCall(undefined, 'with=equals');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^sb_p=with%3Dequals;/);
    // Round-trip: decoding the value matches the input.
    const value = cookie.split(';')[0]!.replace(/^sb_p=/, '');
    expect(decodeURIComponent(value)).toBe('with=equals');
  });

  it('URI-encodes participant id containing semicolons', async () => {
    // A naked semicolon would split into a malformed second attribute.
    const res = await buildAndCall(undefined, 'with;semi');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^sb_p=with%3Bsemi;/);
  });
});
