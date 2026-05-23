// packages/server/src/install/cloudflared.ts
//
// Post-install advisory: detect whether `cloudflared` (or the `npx` fallback the
// runtime uses) is available, and tell the user how to get public links beyond
// their LAN. Mirrors the detection order in transport/selectTransport.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Probe shape — injectable so tests don't shell out to `which`/`where`. */
export type ProbeFn = (cmd: string) => Promise<boolean>;

/** Default PATH probe: `which` on POSIX, `where` on Windows. Never throws. */
export async function isOnPath(cmd: string): Promise<boolean> {
  try {
    await exec(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

export interface CloudflaredStatus {
  /** A real `cloudflared` binary is on PATH. */
  cloudflared: boolean;
  /** `npx` is on PATH — the runtime can fall back to the `cloudflared` npm wrapper. */
  npx: boolean;
}

/** Probe for `cloudflared` and `npx`, matching selectTransport's detection. */
export async function checkCloudflared(probe: ProbeFn = isOnPath): Promise<CloudflaredStatus> {
  const [cloudflared, npx] = await Promise.all([probe('cloudflared'), probe('npx')]);
  return { cloudflared, npx };
}

/** Platform-appropriate install command for cloudflared. */
function installHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return '  brew install cloudflare/cloudflare/cloudflared';
    case 'win32':
      return '  winget install --id Cloudflare.cloudflared';
    case 'linux':
      return [
        '  wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb',
        '  sudo dpkg -i cloudflared-linux-amd64.deb',
      ].join('\n');
    default:
      return '  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';
  }
}

/**
 * Human-readable advisory for the post-install summary. Pure — takes the probe
 * result (and platform) and returns the lines to print, without trailing newline.
 */
export function cloudflaredAdvice(
  status: CloudflaredStatus,
  platform: NodeJS.Platform = process.platform,
): string {
  if (status.cloudflared) {
    return '✓ cloudflared found — shareable links beyond your LAN are ready.';
  }
  if (status.npx) {
    return [
      '• cloudflared not found. Sessions will use the npx fallback, which downloads',
      '  it on first run. For faster, offline-friendly startup, install it natively:',
      installHint(platform),
    ].join('\n');
  }
  return [
    '• cloudflared not found — sessions will be LAN-only (teammates must be on the',
    '  same network). To share links beyond your LAN, install cloudflared:',
    installHint(platform),
  ].join('\n');
}
