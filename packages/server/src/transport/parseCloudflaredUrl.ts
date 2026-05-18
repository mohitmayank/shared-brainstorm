const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseCloudflaredUrl(buf: string): string | null {
  const m = buf.match(URL_RE);
  return m ? m[0] : null;
}
