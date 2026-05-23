// packages/server/src/install/index.ts
import { installClaudeCode } from './claude-code.js';
import { installCodex } from './codex.js';
import { installOpencode } from './opencode.js';
import { installGeminiCli } from './gemini-cli.js';
import { checkCloudflared, cloudflaredAdvice, type ProbeFn } from './cloudflared.js';

type Host = 'claude-code' | 'codex' | 'opencode' | 'gemini-cli';

export interface RunInstallOpts {
  /** Override home directory; used in tests to avoid writing to the real home. */
  home?: string;
  /** Injectable PATH probe for the cloudflared advisory; defaults to a real probe. */
  probe?: ProbeFn;
}

export async function runInstall(host: Host, opts: RunInstallOpts = {}): Promise<void> {
  // exactOptionalPropertyTypes: pass home only when set to avoid spreading `undefined`
  const homeEnv = opts.home !== undefined ? { home: opts.home } : {};
  switch (host) {
    case 'claude-code': {
      const { configPath, skillPath } = await installClaudeCode(homeEnv);
      process.stdout.write(`MCP config written to: ${configPath}\n`);
      process.stdout.write(`Skills copied to:      ${skillPath}\n`);
      process.stdout.write(`\nRestart Claude Code for changes to take effect.\n`);
      break;
    }
    case 'codex':
      await installCodex(homeEnv);
      break;
    case 'opencode':
      await installOpencode(homeEnv);
      break;
    case 'gemini-cli':
      await installGeminiCli(homeEnv);
      break;
    default: {
      // Compile-time exhaustiveness check: if a new host is added to the Host
      // union without a matching case, this line makes the build fail.
      const _exhaustive: never = host;
      throw new Error(`runInstall: unknown host: ${String(_exhaustive)}`);
    }
  }
  // Public-link readiness: tell the user whether cloudflared is available and,
  // if not, how to install it (mirrors transport/selectTransport.ts detection).
  const status = await checkCloudflared(opts.probe);
  process.stdout.write(`\n${cloudflaredAdvice(status)}\n`);

  process.stdout.write(
    `\nNow ask your agent to brainstorm a decision with your team — e.g. "Postgres or DynamoDB?"\n`,
  );
}
