import type { Context } from 'hono';

const COOKIE_NAME = 'sb_p';

export function readParticipantCookie(c: Context): string | null {
  const raw = c.req.header('cookie') ?? '';
  for (const part of raw.split(/;\s*/)) {
    const [k, v] = part.split('=');
    if (k === COOKIE_NAME && v) return decodeURIComponent(v);
  }
  return null;
}

/**
 * Set the participant cookie.
 *
 * `opts.secure` is set by the HTTP server based on the active transport's
 * `secureCookie` advisory (D-13 / D-16). LAN-mode leaves Secure off (default),
 * cloudflared-mode turns it on so browsers only echo the cookie over HTTPS.
 *
 * Output shape (LAN/default):
 *   `sb_p=<id>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
 * Output shape (cloudflared):
 *   `sb_p=<id>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`
 */
export function setParticipantCookie(
  c: Context,
  participantId: string,
  opts: { secure?: boolean } = {},
): void {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=86400'];
  if (opts.secure) attrs.push('Secure');
  c.header(
    'set-cookie',
    `${COOKIE_NAME}=${encodeURIComponent(participantId)}; ${attrs.join('; ')}`,
    { append: true },
  );
}
