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

export function setParticipantCookie(c: Context, participantId: string): void {
  c.header(
    'set-cookie',
    `${COOKIE_NAME}=${encodeURIComponent(participantId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    { append: true },
  );
}
