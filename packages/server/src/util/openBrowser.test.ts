import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock node:child_process before importing the module under test.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { openBrowser } from './openBrowser.js';

/** A minimal fake ChildProcess that emits `exit`/`error` on the next tick. */
function fakeChild(opts: { exitCode?: number; error?: boolean }): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = () => {};
  queueMicrotask(() => {
    if (opts.error) ee.emit('error', new Error('ENOENT'));
    else ee.emit('exit', opts.exitCode ?? 0);
  });
  return ee;
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe('openBrowser', () => {
  it('returns the launcher name when the spawned process exits 0', async () => {
    spawnMock.mockImplementation(() => fakeChild({ exitCode: 0 }));
    const result = await openBrowser('https://example.test/');
    expect(result).not.toBeNull();
    // The URL is passed as a spawn argument, never interpolated into a shell string.
    const [, args] = spawnMock.mock.calls[0]!;
    expect(args as string[]).toContain('https://example.test/');
  });

  it('returns null when every launcher exits non-zero', async () => {
    spawnMock.mockImplementation(() => fakeChild({ exitCode: 1 }));
    const result = await openBrowser('https://example.test/');
    expect(result).toBeNull();
  });

  it('returns null when spawn throws (binary missing)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    const result = await openBrowser('https://example.test/');
    expect(result).toBeNull();
  });

  it('returns null when the child emits an error event', async () => {
    spawnMock.mockImplementation(() => fakeChild({ error: true }));
    const result = await openBrowser('https://example.test/');
    expect(result).toBeNull();
  });
});
