/**
 * Render-free tests for PlannerLinkDialog (on-load coordinator invite dialog).
 *
 * Mirrors ShareLinkButton.test.tsx: calls the component as a function and
 * inspects the returned element tree. Hooks (useEffect focus/Esc, useState
 * `copied`) do NOT fire render-free — these tests verify BRANCH LOGIC (the
 * copy/dismiss onClicks and the rendered link). The visual "Copied!" flash and
 * Esc-to-close are covered structurally + by e2e.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { PlannerLinkDialog } from './PlannerLinkDialog.js';

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

function textOf(node: AnyNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return childrenOf(node).map(textOf).filter(Boolean).join(' ');
}

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

function findFirst(node: AnyNode, pred: (n: AnyNode) => boolean): AnyNode | null {
  for (const hit of findAll(node, pred)) return hit;
  return null;
}

const byClass = (cls: string) => (n: AnyNode): boolean => {
  if (typeof n !== 'object' || n === null) return false;
  const el = n as ReactElement;
  return (el.props as { className?: string } | undefined)?.className === cls;
};

const PUBLIC = 'https://participant.example/';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlannerLinkDialog', () => {
  it('renders a role=dialog with the participant link', () => {
    const tree = PlannerLinkDialog({ publicUrl: PUBLIC, onDismiss: () => {} });
    const dialog = findFirst(tree as AnyNode, (n) => {
      if (typeof n !== 'object' || n === null) return false;
      return (n as ReactElement).props && (n as ReactElement).props['role'] === 'dialog';
    });
    expect(dialog).not.toBeNull();
    expect(textOf(tree as AnyNode)).toContain(PUBLIC);
  });

  it('renders only publicUrl — never a coordinator URL (security contract)', () => {
    const tree = PlannerLinkDialog({ publicUrl: PUBLIC, onDismiss: () => {} });
    const text = textOf(tree as AnyNode);
    expect(text).toContain(PUBLIC);
    expect(text).not.toContain('coordinator');
    expect(text).not.toContain('token');
  });

  it('the dismiss (×) button calls onDismiss', () => {
    const onDismiss = vi.fn();
    const tree = PlannerLinkDialog({ publicUrl: PUBLIC, onDismiss });
    const btn = findFirst(tree as AnyNode, byClass('planner-dialog-dismiss')) as ReactElement | null;
    expect(btn).not.toBeNull();
    (btn!.props as { onClick: () => void }).onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('clicking the backdrop calls onDismiss', () => {
    const onDismiss = vi.fn();
    const tree = PlannerLinkDialog({ publicUrl: PUBLIC, onDismiss }) as ReactElement;
    // The root node IS the backdrop.
    (tree.props as { onClick: () => void }).onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('the copy button writes publicUrl to the clipboard and fires onCopy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const onCopy = vi.fn();
    const tree = PlannerLinkDialog({ publicUrl: PUBLIC, onDismiss: () => {}, onCopy });
    const btn = findFirst(tree as AnyNode, byClass('planner-dialog-copy')) as ReactElement | null;
    expect(btn).not.toBeNull();
    // onClick wraps `void handleCopy()` and returns void — writeText is invoked
    // synchronously, but onCopy fires after the awaited copy resolves, so flush.
    (btn!.props as { onClick: () => void }).onClick();
    expect(writeText).toHaveBeenCalledWith(PUBLIC);
    await new Promise((r) => setTimeout(r, 0));
    expect(onCopy).toHaveBeenCalledOnce();
  });
});
