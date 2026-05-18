import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mcpState } from './mcp/state.js';

const KNOWN_HOSTS = ['claude-code', 'codex', 'opencode', 'gemini-cli'] as const;
type Host = (typeof KNOWN_HOSTS)[number];

export type ParsedArgs =
  | { mode: 'mcp' }
  | { mode: 'install'; host: Host }
  | { mode: 'version' }
  | { mode: 'help' };

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { mode: 'mcp' };
  const first = argv[0]!;
  if (first === '--mcp') return { mode: 'mcp' };
  if (first === '--version' || first === '-v') return { mode: 'version' };
  if (first === '--help' || first === '-h') return { mode: 'help' };
  if (first === '--install') {
    const host = argv[1];
    if (!host) throw new Error('--install requires a host (claude-code|codex|opencode|gemini-cli)');
    if (!(KNOWN_HOSTS as ReadonlyArray<string>).includes(host))
      throw new Error(`unknown host: ${host}`);
    return { mode: 'install', host: host as Host };
  }
  throw new Error(`unknown flag: ${first}`);
}

async function flushOnExit(reason: 'signal' | 'crash'): Promise<void> {
  if (mcpState.manager) {
    try {
      mcpState.manager.stop(reason);
    } catch {
      /* swallow */
    }
    try {
      await mcpState.transport?.stop();
    } catch {
      /* ignore */
    }
    try {
      await mcpState.http?.close();
    } catch {
      /* ignore */
    }
  }
}

function installSignalHandlers(): void {
  const onSig = (sig: NodeJS.Signals): void => {
    flushOnExit('signal').finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', () => onSig('SIGINT'));
  process.on('SIGTERM', () => onSig('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('uncaught:', err);
    flushOnExit('crash').finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (err) => {
    console.error('unhandled rejection:', err);
    flushOnExit('crash').finally(() => process.exit(1));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.mode) {
    case 'version':
      // eslint-disable-next-line no-console
      console.log(process.env['npm_package_version'] ?? 'dev');
      return;
    case 'help':
      // eslint-disable-next-line no-console
      console.log(
        `shared-brainstorm — bring your team into agentic-AI plan-mode
Usage:
  shared-brainstorm                 # default: run MCP stdio server
  shared-brainstorm --install <host>  # write MCP config + skill for host
  shared-brainstorm --version
Hosts: ${KNOWN_HOSTS.join(', ')}`,
      );
      return;
    case 'install': {
      const { runInstall } = await import('./install/index.js');
      await runInstall(args.host);
      return;
    }
    case 'mcp':
      installSignalHandlers();
      {
        const { runMcpStdio } = await import('./mcp/server.js');
        await runMcpStdio();
      }
      return;
  }
}

const isMain =
  process.argv[1] &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain || process.env['SB_FORCE_MAIN'] === '1') void main();
