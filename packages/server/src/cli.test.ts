import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliSourcePath = resolve(here, 'cli.ts');
const pkgPath = resolve(here, '..', 'package.json');

describe('CLI parseArgs', () => {
  it('defaults to mcp mode', () => {
    expect(parseArgs([]).mode).toBe('mcp');
  });

  it('--mcp explicit', () => {
    expect(parseArgs(['--mcp']).mode).toBe('mcp');
  });

  it('--install with host', () => {
    expect(parseArgs(['--install', 'claude-code'])).toEqual({
      mode: 'install',
      host: 'claude-code',
    });
  });

  it('--install with all valid hosts', () => {
    for (const host of ['claude-code', 'codex', 'opencode', 'gemini-cli']) {
      expect(parseArgs(['--install', host])).toEqual({ mode: 'install', host });
    }
  });

  it('--install without host throws', () => {
    expect(() => parseArgs(['--install'])).toThrow(/host/);
  });

  it('--install with unknown host throws', () => {
    expect(() => parseArgs(['--install', 'unknown'])).toThrow(/unknown host/);
  });

  it('--version', () => {
    expect(parseArgs(['--version']).mode).toBe('version');
  });

  it('-v shorthand', () => {
    expect(parseArgs(['-v']).mode).toBe('version');
  });

  it('--help', () => {
    expect(parseArgs(['--help']).mode).toBe('help');
  });

  it('-h shorthand', () => {
    expect(parseArgs(['-h']).mode).toBe('help');
  });

  it('rejects unknown flag', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown/);
  });
});

describe('main --version output', () => {
  it(
    'prints packages/server/package.json version when invoked via tsx',
    async () => {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
      const child = spawn('npx', ['tsx', cliSourcePath, '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((r) => child.on('close', r));
      expect(code, `stderr: ${stderr}`).toBe(0);
      expect(stdout.trim()).toBe(pkg.version);
    },
    15_000,
  );
});
