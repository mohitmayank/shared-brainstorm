import { describe, expect, it } from 'vitest';
import { LanTransport } from './LanTransport.js';

describe('LanTransport', () => {
  it('passes preferredHost through when given a concrete IP/hostname', async () => {
    const t = new LanTransport();
    const info = await t.start({ host: '192.168.50.10', port: 7711 });
    expect(info.kind).toBe('lan');
    expect(info.publicUrl).toBe('http://192.168.50.10:7711');
    expect(info.warning).toMatch(/LAN/);
    await t.stop();
  });

  it('scans for a LAN IP when host is 0.0.0.0', async () => {
    const t = new LanTransport();
    const info = await t.start({ host: '0.0.0.0', port: 7711 });
    expect(info.kind).toBe('lan');
    // Resolved to either a non-internal IPv4 or the 127.0.0.1 fallback.
    expect(info.publicUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:7711$/);
    expect(info.publicUrl).not.toContain('0.0.0.0');
    await t.stop();
  });

  it('produces an http://<resolved>:<port> URL form', async () => {
    const t = new LanTransport();
    const info = await t.start({ host: '10.0.0.5', port: 9000 });
    expect(info.publicUrl).toBe('http://10.0.0.5:9000');
    await t.stop();
  });

  it('stores onUrlChange callback but never fires it (URL is stable)', async () => {
    const t = new LanTransport();
    let called = false;
    t.onUrlChange(() => {
      called = true;
    });
    await t.start({ host: '127.0.0.1', port: 7711 });
    await t.stop();
    expect(called).toBe(false);
  });
});
