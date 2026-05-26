/**
 * Phase 11 (ROOM-03): Wave 0 stub tests for EmptyRoomNotice component.
 *
 * These tests FAIL before implementation (Wave 0 contract). They will pass
 * once Plan 05 creates packages/web/src/components/EmptyRoomNotice.tsx.
 *
 * Render-free approach: calls the component as a function and inspects the
 * returned React element tree. This project has no @testing-library/react —
 * pattern mirrors CoordinatorQuestionCard.test.ts.
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { EmptyRoomNotice } from './EmptyRoomNotice.js';

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

// ---------------------------------------------------------------------------
// Tests — will fail on import until Plan 05 creates EmptyRoomNotice.tsx
// ---------------------------------------------------------------------------

describe('EmptyRoomNotice (Phase 11 ROOM-03 — Wave 0)', () => {
  it('renders the notice when called as a component function', () => {
    const tree = EmptyRoomNotice();
    // Component must return a non-null element
    expect(tree).not.toBeNull();
    expect(tree).toBeDefined();
  });

  it('contains text "Room is empty"', () => {
    const tree = EmptyRoomNotice();
    const text = textOf(tree as AnyNode);
    expect(text).toContain('Room is empty');
  });

  it('has role="status" on the root element', () => {
    const tree = EmptyRoomNotice();
    const el = tree as ReactElement;
    expect((el.props as Record<string, unknown>)['role']).toBe('status');
  });

  it('has aria-live="polite" on the root element', () => {
    const tree = EmptyRoomNotice();
    const el = tree as ReactElement;
    expect((el.props as Record<string, unknown>)['aria-live']).toBe('polite');
  });
});
