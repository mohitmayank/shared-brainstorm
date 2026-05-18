// packages/server/src/install/claude-code.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClaudeCode } from './claude-code.js';

describe('installClaudeCode', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'sb-cc-test-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('writes mcp.json with shared-brainstorm entry', async () => {
    const { configPath } = await installClaudeCode({ home: tmpHome });
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const servers = parsed['mcpServers'] as Record<string, unknown>;
    expect(servers['shared-brainstorm']).toEqual({
      command: 'npx',
      args: ['-y', 'shared-brainstorm'],
    });
  });

  it('does not overwrite existing mcpServers siblings', async () => {
    const configPath = join(tmpHome, '.claude', 'mcp.json');
    await mkdir(join(tmpHome, '.claude'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { other: { command: 'other' } } }),
      'utf8',
    );
    await installClaudeCode({ home: tmpHome });
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const servers = parsed['mcpServers'] as Record<string, unknown>;
    expect(servers['other']).toBeDefined();
    expect(servers['shared-brainstorm']).toBeDefined();
  });

  it('returns configPath and skillPath', async () => {
    const result = await installClaudeCode({ home: tmpHome });
    expect(result.configPath).toContain('.claude');
    expect(result.skillPath).toContain('.claude');
  });
});
