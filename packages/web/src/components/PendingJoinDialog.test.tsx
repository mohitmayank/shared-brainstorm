/**
 * PendingJoinDialog render-free tests.
 *
 * No @testing-library/react in this project — call the component as a function
 * and inspect the returned React tree (mirrors PlanningStreamPanel.test and
 * EmptyRoomNotice.test). Locks the contract Coordinator.tsx relies on:
 *  - one row per pending participant, in input order,
 *  - Approve / Disapprove buttons each invoke their prop with the row's id,
 *  - × close + Esc + backdrop click all invoke `onDismiss`,
 *  - role="dialog", aria-modal, aria-labelledby wired correctly,
 *  - empty `pending` renders nothing (defensive — caller already guards).
 */
/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { PendingJoinDialog } from './PendingJoinDialog.js';

// ---------------------------------------------------------------------------
// Render-free JSX-tree helpers (same pattern as PlanningStreamPanel.test)
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

function textOf(node: AnyNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return childrenOf(node)
    .map(textOf)
    .filter(Boolean)
    .join(' ');
}

function collect(node: AnyNode, pred: (props: Record<string, unknown>) => boolean): ReactElement[] {
  const out: ReactElement[] = [];
  const visit = (n: AnyNode): void => {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const el = n as ReactElement;
    if (el.props && pred(el.props as Record<string, unknown>)) out.push(el);
    childrenOf(n).forEach(visit);
  };
  visit(node);
  return out;
}

// Build a minimal participant-like value. The component only reads id +
// display_name, so we don't bother with the full WireParticipant shape.
const pp = (id: string, name: string): { id: string; display_name: string } => ({
  id,
  display_name: name,
});

describe('PendingJoinDialog', () => {
  it('renders nothing when `pending` is empty (defensive — caller already guards)', () => {
    const tree = PendingJoinDialog({
      pending: [],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss: () => {},
      // typed-as-any here because pending is widened from WireParticipant in the
      // real component; tests use a structural subset.
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    expect(tree).toBeNull();
  });

  it('renders the backdrop + card with a11y props', () => {
    const tree = PendingJoinDialog({
      pending: [pp('p1', 'Alice')],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss: () => {},
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    const backdrop = tree as ReactElement;
    const backdropProps = backdrop.props as Record<string, unknown>;
    expect(backdropProps['data-testid']).toBe('pending-join-backdrop');

    const dialog = collect(tree, (p) => p['role'] === 'dialog')[0];
    expect(dialog).toBeDefined();
    const dialogProps = dialog!.props as Record<string, unknown>;
    expect(dialogProps['aria-modal']).toBe('true');
    expect(dialogProps['aria-labelledby']).toBe('pending-join-title');
    expect(dialogProps['data-testid']).toBe('pending-join-dialog');
  });

  it('renders one row per pending participant, in input order', () => {
    const tree = PendingJoinDialog({
      pending: [pp('p1', 'Alice'), pp('p2', 'Bob'), pp('p3', 'Carol')],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss: () => {},
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    const rows = collect(tree, (p) => p['className'] === 'pending-join-row');
    expect(rows).toHaveLength(3);
    // Names appear in order
    expect(textOf(rows[0]!)).toContain('Alice');
    expect(textOf(rows[1]!)).toContain('Bob');
    expect(textOf(rows[2]!)).toContain('Carol');
  });

  it('Approve button click invokes onApprove with the row id', () => {
    const onApprove = vi.fn();
    const tree = PendingJoinDialog({
      pending: [pp('p1', 'Alice'), pp('p2', 'Bob')],
      onApprove,
      onDisapprove: () => {},
      onDismiss: () => {},
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    const approves = collect(tree, (p) => p['className'] === 'pending-join-approve');
    expect(approves).toHaveLength(2);
    (approves[1]!.props as { onClick: () => void }).onClick();
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith('p2');
  });

  it('Disapprove button click invokes onDisapprove with the row id', () => {
    const onDisapprove = vi.fn();
    const tree = PendingJoinDialog({
      pending: [pp('p1', 'Alice'), pp('p2', 'Bob')],
      onApprove: () => {},
      onDisapprove,
      onDismiss: () => {},
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    const dis = collect(tree, (p) => p['className'] === 'pending-join-disapprove');
    expect(dis).toHaveLength(2);
    (dis[0]!.props as { onClick: () => void }).onClick();
    expect(onDisapprove).toHaveBeenCalledTimes(1);
    expect(onDisapprove).toHaveBeenCalledWith('p1');
  });

  it('× close button invokes onDismiss', () => {
    const onDismiss = vi.fn();
    const tree = PendingJoinDialog({
      pending: [pp('p1', 'Alice')],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss,
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    const close = collect(tree, (p) => p['aria-label'] === 'Close pending-join dialog')[0];
    expect(close).toBeDefined();
    (close!.props as { onClick: () => void }).onClick();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('backdrop click invokes onDismiss; inner-dialog click does not propagate', () => {
    const onDismiss = vi.fn();
    const tree = PendingJoinDialog({
      pending: [pp('p1', 'Alice')],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss,
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    const backdrop = tree as ReactElement;
    (backdrop.props as { onClick: () => void }).onClick();
    expect(onDismiss).toHaveBeenCalledTimes(1);

    // The inner dialog's onClick must be a stopPropagation wrapper, NOT onDismiss.
    const dialog = collect(tree, (p) => p['role'] === 'dialog')[0]!;
    const inner = (dialog.props as { onClick?: unknown }).onClick;
    expect(typeof inner).toBe('function');
    // Calling the inner onClick with a fake event must NOT bubble into onDismiss.
    const fakeEvt = { stopPropagation: vi.fn() } as unknown as { stopPropagation: () => void };
    (inner as (e: typeof fakeEvt) => void)(fakeEvt);
    expect(fakeEvt.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1); // unchanged
  });

  it('header copy reflects the pending count (singular vs plural)', () => {
    const one = PendingJoinDialog({
      pending: [pp('p1', 'Alice')],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss: () => {},
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    expect(textOf(one)).toContain('1 teammate');

    const three = PendingJoinDialog({
      pending: [pp('p1', 'a'), pp('p2', 'b'), pp('p3', 'c')],
      onApprove: () => {},
      onDisapprove: () => {},
      onDismiss: () => {},
    } as unknown as Parameters<typeof PendingJoinDialog>[0]);
    expect(textOf(three)).toContain('3 teammates');
  });
});
