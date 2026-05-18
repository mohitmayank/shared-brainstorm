// packages/server/src/install/util.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeJsonFile } from './util.js';

describe('mergeJsonFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sb-util-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates file with object when missing', async () => {
    const filePath = join(tmpDir, 'sub', 'mcp.json');
    await mergeJsonFile(filePath, { hello: 'world' });
    const content = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(content).toEqual({ hello: 'world' });
  });

  it('merges deep at mcpServers key without clobbering siblings', async () => {
    const filePath = join(tmpDir, 'mcp.json');
    const existing = {
      mcpServers: { 'other-tool': { command: 'other', args: [] } },
      globalSetting: true,
    };
    await writeFile(filePath, JSON.stringify(existing), 'utf8');
    await mergeJsonFile(filePath, {
      mcpServers: { 'shared-brainstorm': { command: 'npx', args: ['-y', 'shared-brainstorm'] } },
    });
    const result = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    const servers = result['mcpServers'] as Record<string, unknown>;
    expect(servers['other-tool']).toBeDefined();
    expect(servers['shared-brainstorm']).toEqual({ command: 'npx', args: ['-y', 'shared-brainstorm'] });
    expect(result['globalSetting']).toBe(true);
  });

  it("onConflict='fail' throws on conflicting leaf values", async () => {
    const filePath = join(tmpDir, 'mcp.json');
    await writeFile(filePath, JSON.stringify({ key: 'old-value' }), 'utf8');
    await expect(
      mergeJsonFile(filePath, { key: 'new-value' }, { onConflict: 'fail' }),
    ).rejects.toThrow(/conflict/i);
  });
});
