import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Transport } from './Transport.js';
import { LanTransport } from './LanTransport.js';
import { CloudflaredTransport } from './CloudflaredTransport.js';

const exec = promisify(execFile);

async function isOnPath(cmd: string): Promise<boolean> {
  try {
    await exec(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

export interface SelectTransportOpts {
  prefer?: 'cloudflared' | 'npx-cloudflared' | 'lan';
}

export async function selectTransport(opts: SelectTransportOpts = {}): Promise<Transport> {
  if (opts.prefer === 'lan') return new LanTransport();
  if (await isOnPath('cloudflared'))
    return new CloudflaredTransport({ command: 'cloudflared' });
  if (await isOnPath('npx'))
    return new CloudflaredTransport({
      command: 'npx',
      args: ['--yes', 'cloudflared', 'tunnel'],
    });
  return new LanTransport();
}
