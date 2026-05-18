import { describe, expect, it } from 'vitest';
import { parseCloudflaredUrl } from './parseCloudflaredUrl.js';

describe('parseCloudflaredUrl', () => {
  it('extracts a trycloudflare.com URL from cloudflared-style stderr', () => {
    const line =
      '2024-01-01T00:00:00Z INF | https://some-tunnel-name.trycloudflare.com |';
    expect(parseCloudflaredUrl(line)).toBe(
      'https://some-tunnel-name.trycloudflare.com',
    );
  });

  it('returns null when no URL is present', () => {
    expect(parseCloudflaredUrl('Starting cloudflared tunnel...')).toBeNull();
    expect(parseCloudflaredUrl('')).toBeNull();
  });

  it('handles trailing whitespace and pipe characters around the URL', () => {
    const line = '  | https://abc-def-123.trycloudflare.com |  ';
    expect(parseCloudflaredUrl(line)).toBe(
      'https://abc-def-123.trycloudflare.com',
    );
  });

  it('is case-insensitive for the scheme and domain', () => {
    const line = 'HTTPS://MY-TUNNEL.trycloudflare.com';
    expect(parseCloudflaredUrl(line)).toBe('HTTPS://MY-TUNNEL.trycloudflare.com');
  });

  it('does not match non-trycloudflare URLs', () => {
    expect(
      parseCloudflaredUrl('https://example.com/foo'),
    ).toBeNull();
  });

  it('extracts URL from multi-line buffer', () => {
    const buf = [
      '2024-01-01T00:00:00Z INF Thank you for trying Cloudflare Tunnel.',
      '2024-01-01T00:00:00Z INF | https://happy-server-example.trycloudflare.com          |',
      '2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+',
    ].join('\n');
    expect(parseCloudflaredUrl(buf)).toBe(
      'https://happy-server-example.trycloudflare.com',
    );
  });
});
