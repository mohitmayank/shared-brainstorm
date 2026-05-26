/**
 * Phase 14 (SHARE-01/02): Wave 0 stub tests for ShareLinkButton component.
 *
 * These tests FAIL before implementation (Wave 0 contract). They will pass
 * once Plan 14-04 creates packages/web/src/components/ShareLinkButton.tsx.
 *
 * Render-free approach: calls the component as a function and inspects the
 * returned React element tree. This project has no @testing-library/react —
 * pattern mirrors IdleNudgeBanner.test.tsx.
 *
 * Hooks (useState `copied`) do NOT fire render-free — unit tests verify BRANCH
 * LOGIC by extracting the button's onClick and asserting navigator.share /
 * navigator.clipboard calls (vi.stubGlobal). The visual "Copied!" 2s transition
 * is covered by e2e/share-link.spec.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { ShareLinkButton } from './ShareLinkButton.js';

// ---------------------------------------------------------------------------
// Render-free JSX-tree helpers (copied from IdleNudgeBanner.test.tsx)
// ---------------------------------------------------------------------------
type AnyNode = unknown;

function childrenOf(node: AnyNode): AnyNode[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node;
  if (typeof node === 'object') {
    const props = (node as { props?: { children?: AnyNode } }).props;
    if (props && 'children' in props) {
      const c = props.children;
      return Array.isArray(c) ? c : [c];
    }
  }
  return [];
}

/** Collect all string/number text nodes in the tree, concatenated with spaces. */
function textOf(node: AnyNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return childrenOf(node)
    .map(textOf)
    .filter(Boolean)
    .join(' ');
}

/** Depth-first search: collect all elements where predicate returns true. */
function findAll(node: AnyNode, pred: (n: AnyNode) => boolean): AnyNode[] {
  const out: AnyNode[] = [];
  const walk = (n: AnyNode): void => {
    if (n === null || n === undefined) return;
    if (pred(n)) out.push(n);
    for (const child of childrenOf(n)) walk(child);
  };
  walk(node);
  return out;
}

/** Find first element matching predicate. */
function findFirst(node: AnyNode, pred: (n: AnyNode) => boolean): AnyNode | null {
  for (const hit of findAll(node, pred)) return hit;
  return null;
}

// ---------------------------------------------------------------------------
// Tests — will fail on import until Plan 14-04 creates ShareLinkButton.tsx
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShareLinkButton (Phase 14 SHARE-01/02 — Wave 0)', () => {
  it("renders a button with label 'Share link'", () => {
    const tree = ShareLinkButton({ publicUrl: 'https://join.example/' });
    expect(tree).not.toBeNull();
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    );
    expect(btn).not.toBeNull();
    const text = textOf(btn);
    expect(text).toContain('Share link');
  });

  it('calls navigator.share when available', async () => {
    const shareMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: shareMock,
      clipboard: undefined,
    });

    const tree = ShareLinkButton({ publicUrl: 'https://join.example/' });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    ) as ReactElement | null;

    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => Promise<void> }).onClick;
    await onClick();

    expect(shareMock).toHaveBeenCalledOnce();
    expect(shareMock).toHaveBeenCalledWith({
      title: 'shared-brainstorm',
      text: 'Join my shared-brainstorm session',
      url: 'https://join.example/',
    });
  });

  it('AbortError from navigator.share is swallowed silently', async () => {
    const abortError = new DOMException('', 'AbortError');
    vi.stubGlobal('navigator', {
      share: vi.fn().mockRejectedValue(abortError),
      clipboard: undefined,
    });

    const tree = ShareLinkButton({ publicUrl: 'https://join.example/' });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    ) as ReactElement | null;

    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => Promise<void> }).onClick;

    // Must NOT throw despite navigator.share rejection with AbortError
    await expect(onClick()).resolves.not.toThrow();
    // clipboard must not be called (AbortError is user-cancel, not a real error)
    expect((navigator as unknown as Record<string, unknown>).clipboard).toBeUndefined();
  });

  it('non-AbortError falls through to clipboard copy', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: vi.fn().mockRejectedValue(new Error('NotAllowed')),
      clipboard: { writeText: writeTextMock },
    });

    const tree = ShareLinkButton({ publicUrl: 'https://join.example/' });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    ) as ReactElement | null;

    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => Promise<void> }).onClick;
    await onClick();

    expect(writeTextMock).toHaveBeenCalledWith('https://join.example/');
  });

  it('clipboard fallback runs when navigator.share is undefined', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: undefined,
      clipboard: { writeText: writeTextMock },
    });

    const tree = ShareLinkButton({ publicUrl: 'https://join.example/' });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    ) as ReactElement | null;

    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => Promise<void> }).onClick;
    await onClick();

    expect(writeTextMock).toHaveBeenCalledWith('https://join.example/');
  });

  it('onCopy prop fires on successful clipboard copy', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: undefined,
      clipboard: { writeText: writeTextMock },
    });
    const onCopyMock = vi.fn();

    const tree = ShareLinkButton({ publicUrl: 'https://join.example/', onCopy: onCopyMock });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    ) as ReactElement | null;

    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => Promise<void> }).onClick;
    await onClick();

    expect(onCopyMock).toHaveBeenCalledOnce();
  });

  it('shares public_url not coordinator_url — prop isolation test (T-14-01 security contract)', async () => {
    // This test documents the security contract: ShareLinkButton only forwards
    // the publicUrl prop value to navigator.share — coordinator_url is never
    // passed in, so it can never be shared (by construction).
    const shareMock = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      share: shareMock,
      clipboard: undefined,
    });

    const tree = ShareLinkButton({ publicUrl: 'https://participant.example/' });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return el.type === 'button';
      },
    ) as ReactElement | null;

    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => Promise<void> }).onClick;
    await onClick();

    expect(shareMock).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://participant.example/' }),
    );
    // The call must NOT include any coordinator URL
    const callArgs = shareMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs.url).toBe('https://participant.example/');
    expect(callArgs.url).not.toContain('coordinator');
    expect(callArgs.url).not.toContain('token');
  });
});
