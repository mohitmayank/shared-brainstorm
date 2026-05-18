// packages/server/src/install/codex.ts
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_SNIPPET = JSON.stringify(
  {
    mcpServers: {
      'shared-brainstorm': {
        command: 'npx',
        args: ['-y', 'shared-brainstorm'],
      },
    },
  },
  null,
  2,
);

async function findPromptFragment(): Promise<string | null> {
  const candidates = [
    resolve(__dirname, '../skills/_generic/prompt-fragment.md'),
    resolve(__dirname, '../../skills/_generic/prompt-fragment.md'),
    resolve(__dirname, '../../../skills/_generic/prompt-fragment.md'),
    resolve(__dirname, '../../../../skills/_generic/prompt-fragment.md'),
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

export async function installCodex(env: { home?: string } = {}): Promise<void> {
  const home = env.home ?? homedir();
  process.stdout.write(
    `\nshared-brainstorm — Codex installer\n====================================\n` +
      `Codex does not yet have a standardised MCP config location.\n` +
      `Add the following to your Codex MCP configuration manually:\n\n` +
      `${CONFIG_SNIPPET}\n\n`,
  );

  const promptsDir = join(home, '.shared-brainstorm', 'prompts');
  await mkdir(promptsDir, { recursive: true });
  const destPath = join(promptsDir, 'codex.md');

  const fragmentSrc = await findPromptFragment();
  if (fragmentSrc !== null) {
    const content = await readFile(fragmentSrc, 'utf8');
    await writeFile(destPath, content, 'utf8');
    process.stdout.write(`Prompt fragment written to: ${destPath}\n`);
  } else {
    process.stdout.write(`(Prompt fragment source not found — skipping write)\n`);
  }
}
