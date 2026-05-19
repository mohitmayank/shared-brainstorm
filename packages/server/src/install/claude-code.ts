// packages/server/src/install/claude-code.ts
import { cp, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnOptions, ChildProcess } from 'node:child_process';
import { spawn as defaultSpawn } from 'node:child_process';
import { mergeJsonFile } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Injectable spawn function type for testability.
 *
 * Mirrors the pattern in CloudflaredTransport.ts — duplicated here to keep
 * install/ self-contained and avoid a cross-layer import.
 */
export type SpawnFn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildProcess;

export interface InstallClaudeCodeOpts {
  home?: string;
  /** Injectable for tests; defaults to `node:child_process.spawn`. */
  spawn?: SpawnFn;
}

const MCP_ENTRY = {
  mcpServers: {
    'shared-brainstorm': {
      command: 'npx',
      args: ['-y', 'shared-brainstorm'],
    },
  },
};

async function findSkillSource(): Promise<string | null> {
  const candidates = [
    resolve(__dirname, '../skills/claude-code/shared-brainstorm'),
    resolve(__dirname, '../../skills/claude-code/shared-brainstorm'),
    resolve(__dirname, '../../../skills/claude-code/shared-brainstorm'),
    resolve(__dirname, '../../../../skills/claude-code/shared-brainstorm'),
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Best-effort post-install verification: spawns `claude mcp list` (5s timeout)
 * and warns loudly to stderr if `shared-brainstorm` is not in the output.
 *
 * Per D-14: never throws, never fails the install.
 * Per D-14: silent if `claude` is not on PATH (ENOENT).
 */
async function verifyClaudeMcpInstall(spawnFn: SpawnFn): Promise<void> {
  // Best-effort: if `claude` isn't on PATH, the spawn throws ENOENT → skip silently.
  try {
    const child = spawnFn('claude', ['mcp', 'list'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (_d: Buffer) => {
      // drain stderr to prevent buffer backpressure
    });

    const exitCode: number = await new Promise((resolveFn, rejectFn) => {
      // Cap at 5s — `claude mcp list` does a health-check spawn of every server;
      // a misbehaving server in the user's list shouldn't hang our install.
      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        rejectFn(new Error('claude mcp list timed out'));
      }, 5_000);
      child.on('close', (code) => {
        clearTimeout(timeout);
        resolveFn(code ?? 1);
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        rejectFn(err);
      });
    });

    if (exitCode !== 0) return; // Best-effort — don't lecture if `claude mcp list` itself is broken.

    // Look for our server name anywhere in stdout. The format is one server
    // per line; the name is the first token before `:`.
    if (!stdout.includes('shared-brainstorm')) {
      // eslint-disable-next-line no-console
      console.error(
        '⚠  Verification: `claude mcp list` succeeded but did not list "shared-brainstorm".\n' +
          '    The MCP config was written to ~/.claude.json, but Claude Code is not seeing it.\n' +
          '    Try restarting Claude Code, or run:\n' +
          '      claude mcp add --scope user shared-brainstorm -- npx -y shared-brainstorm',
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return; // `claude` not on PATH — silent skip per D-14.
    // Any other error (timeout, etc.) — surface gently but never fail.
    // eslint-disable-next-line no-console
    console.error(`  (note: post-install verify skipped: ${e.message})`);
  }
}

export async function installClaudeCode(
  opts: InstallClaudeCodeOpts = {},
): Promise<{ configPath: string; skillPath: string }> {
  const home = opts.home ?? homedir();
  // REL-12: write to ~/.claude.json (not ~/.claude/mcp.json) — the file
  // Claude Code actually reads for MCP configuration.
  const configPath = join(home, '.claude.json');
  const skillPath = join(home, '.claude', 'skills', 'shared-brainstorm');

  await mergeJsonFile(configPath, MCP_ENTRY);

  const skillSource = await findSkillSource();
  if (skillSource !== null) {
    await mkdir(skillPath, { recursive: true });
    await cp(skillSource, skillPath, { recursive: true });
  }

  // Post-install best-effort verify: warn if `claude mcp list` doesn't see us.
  await verifyClaudeMcpInstall(opts.spawn ?? defaultSpawn);

  return { configPath, skillPath };
}
