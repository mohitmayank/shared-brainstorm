// packages/server/src/install/index.ts
import { installClaudeCode } from './claude-code.js';
import { installCodex } from './codex.js';
import { installOpencode } from './opencode.js';
import { installGeminiCli } from './gemini-cli.js';

type Host = 'claude-code' | 'codex' | 'opencode' | 'gemini-cli';

export async function runInstall(host: Host): Promise<void> {
  switch (host) {
    case 'claude-code': {
      const { configPath, skillPath } = await installClaudeCode();
      process.stdout.write(`MCP config written to: ${configPath}\n`);
      process.stdout.write(`Skills copied to:      ${skillPath}\n`);
      process.stdout.write(`\nRestart Claude Code for changes to take effect.\n`);
      return;
    }
    case 'codex':
      await installCodex();
      return;
    case 'opencode':
      await installOpencode();
      return;
    case 'gemini-cli':
      await installGeminiCli();
      return;
  }
}
