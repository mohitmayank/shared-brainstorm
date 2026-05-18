import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Best-effort write to the OS clipboard. Returns the name of the tool that
 * succeeded, or null if no clipboard backend was found / all attempts failed.
 *
 * Selection order:
 *   macOS / darwin       → pbcopy
 *   Windows / win32      → clip.exe
 *   Everything else      → wl-copy → xclip → xsel
 *
 * Spawn errors (binary missing) are caught silently — clipboard is a nice-to-
 * have, never a hard dependency. Headless servers, sandboxes, and CI all
 * end up with `null` and that's fine.
 */
export async function copyToClipboard(text: string): Promise<string | null> {
  const candidates = pickCandidates();
  for (const cand of candidates) {
    const ok = await trySpawn(cand.cmd, cand.args, text);
    if (ok) return cand.cmd;
  }
  return null;
}

interface Candidate {
  cmd: string;
  args: string[];
}

function pickCandidates(): Candidate[] {
  const p = platform();
  if (p === 'darwin') return [{ cmd: 'pbcopy', args: [] }];
  if (p === 'win32') return [{ cmd: 'clip.exe', args: [] }];
  // Linux / *BSD. Try Wayland first (newer), then X11.
  return [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] },
    // WSL fallback: Linux kernel but Windows clipboard is reachable via clip.exe.
    { cmd: 'clip.exe', args: [] },
  ];
}

function trySpawn(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      finish(false);
      return;
    }

    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    try {
      child.stdin.end(text);
    } catch {
      finish(false);
    }
  });
}
