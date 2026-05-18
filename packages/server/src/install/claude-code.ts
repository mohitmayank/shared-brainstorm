// packages/server/src/install/claude-code.ts
import { cp, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeJsonFile } from './util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export async function installClaudeCode(
  env: { home?: string } = {},
): Promise<{ configPath: string; skillPath: string }> {
  const home = env.home ?? homedir();
  const configPath = join(home, '.claude', 'mcp.json');
  const skillPath = join(home, '.claude', 'skills', 'shared-brainstorm');

  await mergeJsonFile(configPath, MCP_ENTRY);

  const skillSource = await findSkillSource();
  if (skillSource !== null) {
    await mkdir(skillPath, { recursive: true });
    await cp(skillSource, skillPath, { recursive: true });
  }

  return { configPath, skillPath };
}
