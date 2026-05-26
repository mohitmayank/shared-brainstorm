/**
 * Phase 11 (ROOM-02): Wave 0 stub tests for IdleNudgeBanner component.
 *
 * These tests FAIL before implementation (Wave 0 contract). They will pass
 * once Plan 05 creates packages/web/src/components/IdleNudgeBanner.tsx.
 *
 * Render-free approach: calls the component as a function and inspects the
 * returned React element tree. This project has no @testing-library/react —
 * pattern mirrors CoordinatorQuestionCard.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { IdleNudgeBanner } from './IdleNudgeBanner.js';

// ---------------------------------------------------------------------------
// Render-free JSX-tree helpers (copied from CoordinatorQuestionCard.test.ts)
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
// Tests — will fail on import until Plan 05 creates IdleNudgeBanner.tsx
// ---------------------------------------------------------------------------

describe('IdleNudgeBanner (Phase 11 ROOM-02 — Wave 0)', () => {
  it('renders the banner when called as a component function', () => {
    const tree = IdleNudgeBanner({ onDismiss: () => {} });
    // Component must return a non-null element
    expect(tree).not.toBeNull();
    expect(tree).toBeDefined();
  });

  it('contains text "No activity for a while"', () => {
    const tree = IdleNudgeBanner({ onDismiss: () => {} });
    const text = textOf(tree as AnyNode);
    expect(text).toContain('No activity for a while');
  });

  it('dismiss button has aria-label "Dismiss idle nudge"', () => {
    const tree = IdleNudgeBanner({ onDismiss: () => {} });
    // Find a button element with aria-label "Dismiss idle nudge"
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return (
          el.type === 'button' &&
          (el.props as Record<string, unknown>)['aria-label'] === 'Dismiss idle nudge'
        );
      },
    );
    expect(btn).not.toBeNull();
  });

  it('clicking dismiss button calls the onDismiss prop', () => {
    const onDismiss = vi.fn();
    const tree = IdleNudgeBanner({ onDismiss });
    // Find the dismiss button and invoke its onClick handler
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return (
          el.type === 'button' &&
          (el.props as Record<string, unknown>)['aria-label'] === 'Dismiss idle nudge'
        );
      },
    ) as ReactElement | null;
    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => void }).onClick;
    onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
