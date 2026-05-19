// Prerequisite: dist/cli.js must exist. Run `npm run build -w packages/server` first.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shimPath = resolve(here, 'shared-brainstorm.js');
const distPath = resolve(here, '..', 'dist', 'cli.js');
const pkgPath = resolve(here, '..', 'package.json');

function runShim(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [shimPath, ...args], {
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
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

const distBuilt = existsSync(distPath);
const maybe = distBuilt ? it : it.skip;

if (!distBuilt) {
  it.skip('dist/cli.js not found — run `npm run build -w packages/server` first', () => {});
}

describe('bin/shared-brainstorm.js shim', () => {
  maybe('--version prints the package.json version', async () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    const result = await runShim(['--version']);
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  maybe('--help prints the usage banner', async () => {
    const result = await runShim(['--help']);
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('shared-brainstorm');
    expect(result.stdout).toContain('--install');
  });
});
