/**
 * Phase 14 (SHARE-01): Wave 0 stub tests for copyToClipboardWithFallback.
 *
 * These tests FAIL before implementation (Wave 0 contract). They will pass
 * once Plan 14-04 creates packages/web/src/lib/clipboard.ts.
 *
 * No @testing-library/react — this is a pure function helper test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboardWithFallback } from '../lib/clipboard.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('copyToClipboardWithFallback (Phase 14 SHARE-01 — Wave 0)', () => {
  it('returns true when navigator.clipboard.writeText succeeds', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const result = await copyToClipboardWithFallback('https://x/');
    expect(result).toBe(true);
    expect((navigator.clipboard as unknown as { writeText: ReturnType<typeof vi.fn> }).writeText).toHaveBeenCalledWith('https://x/');
  });

  it('falls back to execCommand when clipboard.writeText is unavailable', async () => {
    vi.stubGlobal('navigator', {
      // no clipboard property
    });
    const execCommandSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true);
    const result = await copyToClipboardWithFallback('https://x/');
    expect(result).toBe(true);
    expect(execCommandSpy).toHaveBeenCalledWith('copy');
  });

  it('returns false when document is undefined (SSR guard)', async () => {
    vi.stubGlobal('navigator', {
      // no clipboard property
    });
    vi.stubGlobal('document', undefined);
    const result = await copyToClipboardWithFallback('https://x/');
    expect(result).toBe(false);
  });
});
