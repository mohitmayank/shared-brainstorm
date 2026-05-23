// packages/server/src/install/cloudflared.test.ts
import { describe, it, expect } from 'vitest';
import { checkCloudflared, cloudflaredAdvice, type ProbeFn } from './cloudflared.js';

const probeWith = (present: string[]): ProbeFn => async (cmd) => present.includes(cmd);

describe('checkCloudflared', () => {
  it('reports cloudflared present when on PATH', async () => {
    const status = await checkCloudflared(probeWith(['cloudflared', 'npx']));
    expect(status).toEqual({ cloudflared: true, npx: true });
  });

  it('reports cloudflared absent, npx present', async () => {
    const status = await checkCloudflared(probeWith(['npx']));
    expect(status).toEqual({ cloudflared: false, npx: true });
  });

  it('reports both absent', async () => {
    const status = await checkCloudflared(probeWith([]));
    expect(status).toEqual({ cloudflared: false, npx: false });
  });
});

describe('cloudflaredAdvice', () => {
  it('confirms readiness when cloudflared is present', () => {
    const msg = cloudflaredAdvice({ cloudflared: true, npx: true });
    expect(msg).toContain('cloudflared found');
    expect(msg).not.toContain('install');
  });

  it('suggests installing when only npx is available (mentions fallback)', () => {
    const msg = cloudflaredAdvice({ cloudflared: false, npx: true }, 'darwin');
    expect(msg).toContain('npx fallback');
    expect(msg).toContain('brew install');
  });

  it('warns LAN-only and suggests installing when neither is present', () => {
    const msg = cloudflaredAdvice({ cloudflared: false, npx: false }, 'linux');
    expect(msg).toContain('LAN-only');
    expect(msg).toContain('cloudflared-linux-amd64.deb');
  });

  it('gives a Windows install hint on win32', () => {
    const msg = cloudflaredAdvice({ cloudflared: false, npx: false }, 'win32');
    expect(msg).toContain('winget install');
  });

  it('falls back to the downloads URL on unknown platforms', () => {
    const msg = cloudflaredAdvice({ cloudflared: false, npx: false }, 'aix');
    expect(msg).toContain('developers.cloudflare.com');
  });
});
