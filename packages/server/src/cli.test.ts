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

describe('main --mcp banner', () => {
  it(
    'emits banner on stderr when SHARED_BRAINSTORM_NO_REDACT=1',
    async () => {
      const child = spawn('npx', ['tsx', cliSourcePath, '--mcp'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SHARED_BRAINSTORM_NO_REDACT: '1' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 5000);
        child.on('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
      expect(stderr).toContain('Redaction DISABLED');
      expect(stderr).toContain('SHARED_BRAINSTORM_NO_REDACT=1');
      expect(stdout).not.toContain('Redaction DISABLED');
    },
    30_000,
  );

  it(
    'does NOT emit banner when env var is unset',
    async () => {
      const env = { ...process.env };
      delete env['SHARED_BRAINSTORM_NO_REDACT'];
      const child = spawn('npx', ['tsx', cliSourcePath, '--mcp'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => resolve(), 5000);
        child.on('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
      expect(stderr).not.toContain('Redaction DISABLED');
    },
    30_000,
  );

  it(
    'does NOT emit banner in install mode',
    async () => {
      const tmpHome = resolve(here, '..', '..', '..', 'node_modules', '.tmp-test-home');
      const child = spawn('npx', ['tsx', cliSourcePath, '--install', 'claude-code'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, SHARED_BRAINSTORM_NO_REDACT: '1', HOME: tmpHome },
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      expect(stderr).not.toContain('Redaction DISABLED');
    },
    15_000,
  );
});
