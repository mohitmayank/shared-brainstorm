import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Best-effort open of a URL in the user's default browser. Returns the name of
 * the launcher that succeeded, or null if no launcher was found / all attempts
 * failed.
 *
 * Selection order:
 *   macOS / darwin   → open
 *   Windows / win32  → cmd /c start
 *   Everything else  → xdg-open → wslview (WSL) → cmd.exe /c start (WSL)
 *
 * The URL is always passed as a spawn ARGUMENT (never interpolated into a shell
 * string) so a hostile URL cannot inject a command. Spawn errors (binary
 * missing) are swallowed — opening a browser is a nice-to-have, never a hard
 * dependency. Headless servers, sandboxes, and CI all end up with `null` and
 * that's fine; the caller still prints the URL for the user to open manually.
 */
export async function openBrowser(url: string): Promise<string | null> {
  for (const cand of pickCandidates(url)) {
    const ok = await trySpawn(cand.cmd, cand.args);
    if (ok) return cand.cmd;
  }
  return null;
}

interface Candidate {
  cmd: string;
  args: string[];
}

function pickCandidates(url: string): Candidate[] {
  const p = platform();
  if (p === 'darwin') return [{ cmd: 'open', args: [url] }];
  // `start` is a cmd.exe builtin, not an executable; the empty "" is the
  // mandatory window-title arg so a quoted URL isn't mistaken for the title.
  if (p === 'win32') return [{ cmd: 'cmd', args: ['/c', 'start', '', url] }];
  // Linux / *BSD. Native first, then WSL bridges to the Windows browser.
  return [
    { cmd: 'xdg-open', args: [url] },
    { cmd: 'wslview', args: [url] },
    { cmd: 'cmd.exe', args: ['/c', 'start', '', url] },
  ];
}

function trySpawn(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let child;
    try {
      // Detached + unref so the launcher's lifetime is never tied to ours and a
      // GUI handoff (e.g. xdg-open spawning a browser) doesn't keep us alive.
      child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    } catch {
      finish(false);
      return;
    }

    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    try {
      child.unref();
    } catch {
      /* non-fatal */
    }
  });
}
