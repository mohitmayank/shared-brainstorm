/**
 * Phase 12 (RESIL-01): Wave 0 stub tests for TransportFailedBanner component.
 *
 * These tests FAIL before implementation (Wave 0 contract). They will pass
 * once Plan 12-03 creates packages/web/src/components/TransportFailedBanner.tsx.
 *
 * Render-free approach: calls the component as a function and inspects the
 * returned React element tree. This project has no @testing-library/react —
 * pattern mirrors IdleNudgeBanner.test.tsx exactly.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { TransportFailedBanner } from './TransportFailedBanner.js';

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
// Tests — will fail on import until Plan 12-03 creates TransportFailedBanner.tsx
// ---------------------------------------------------------------------------

describe('TransportFailedBanner (Phase 12 RESIL-01 — Wave 0)', () => {
  const dismissFn = vi.fn();
  const defaultProps = {
    message: 'simulated permanent failure',
    restartCount: 3,
    onDismiss: dismissFn,
  };

  it('SC2a: renders a non-null element when called as a component function', () => {
    const tree = TransportFailedBanner(defaultProps);
    expect(tree).not.toBeNull();
    expect(tree).toBeDefined();
  });

  it('SC2b: primary text contains restart count "3" and "attempt"', () => {
    const tree = TransportFailedBanner(defaultProps);
    const text = textOf(tree as AnyNode);
    expect(text).toContain('3');
    expect(text).toContain('attempt');
  });

  it('SC2c: full text tree contains "stop and restart"', () => {
    const tree = TransportFailedBanner(defaultProps);
    const text = textOf(tree as AnyNode);
    expect(text).toContain('stop and restart');
  });

  it('SC2d: a button element has aria-label "Dismiss tunnel failure banner"', () => {
    const tree = TransportFailedBanner(defaultProps);
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return (
          el.type === 'button' &&
          (el.props as Record<string, unknown>)['aria-label'] === 'Dismiss tunnel failure banner'
        );
      },
    );
    expect(btn).not.toBeNull();
  });

  it('SC2e: clicking dismiss button calls the onDismiss prop', () => {
    const onDismiss = vi.fn();
    const tree = TransportFailedBanner({ message: 'simulated permanent failure', restartCount: 3, onDismiss });
    const btn = findFirst(
      tree as AnyNode,
      (n) => {
        if (typeof n !== 'object' || n === null) return false;
        const el = n as ReactElement;
        return (
          el.type === 'button' &&
          (el.props as Record<string, unknown>)['aria-label'] === 'Dismiss tunnel failure banner'
        );
      },
    ) as ReactElement | null;
    expect(btn).not.toBeNull();
    const onClick = (btn!.props as { onClick: () => void }).onClick;
    onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('SC2f: the root element has role="alert"', () => {
    const tree = TransportFailedBanner(defaultProps);
    const el = tree as ReactElement;
    expect((el.props as Record<string, unknown>)['role']).toBe('alert');
  });

  it('SC2g: full text tree does NOT contain "--no-cloudflared"', () => {
    const tree = TransportFailedBanner(defaultProps);
    const text = textOf(tree as AnyNode);
    expect(text).not.toContain('--no-cloudflared');
  });
});
