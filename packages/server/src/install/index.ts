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
      break;
    }
    case 'codex':
      await installCodex();
      break;
    case 'opencode':
      await installOpencode();
      break;
    case 'gemini-cli':
      await installGeminiCli();
      break;
  }
  process.stdout.write(
    `\nNow ask your agent to brainstorm a decision with your team — e.g. "Postgres or DynamoDB?"\n`,
  );
}
