/**
 * Planning-stream: PlanningStreamPanel render-free tests.
 *
 * No @testing-library/react in this project — we call the component as a
 * function and inspect the returned React tree (mirrors EmptyRoomNotice.test
 * and CoordinatorQuestionCard.test). The intent is to lock in the contract that
 * the App and Coordinator pages rely on:
 *  - the mode control renders ONLY when both `mode` and `onModeChange` are
 *    provided (the participant view passes neither — read-only),
 *  - `aria-pressed` on the mode buttons reflects the current mode,
 *  - clicking a mode button calls `onModeChange` with that mode value,
 *  - lines render in order; the empty state copy distinguishes Off from
 *    Waiting (so a participant — who only ever sees this under `everyone` —
 *    never sees the "Off" copy).
 */
/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { PlanningStreamPanel } from './PlanningStreamPanel.js';

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

function textOf(node: AnyNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return childrenOf(node)
    .map(textOf)
    .filter(Boolean)
    .join(' ');
}

/** Depth-first collect every node whose props match the predicate. */
function collect(node: AnyNode, pred: (props: Record<string, unknown>) => boolean): ReactElement[] {
  const out: ReactElement[] = [];
  const visit = (n: AnyNode) => {
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

const baseProps = { stream: [] as Array<{ text: string; at: string }> };

describe('PlanningStreamPanel (planning-stream)', () => {
  it('renders the labelled section with the testid hook', () => {
    const tree = PlanningStreamPanel(baseProps) as ReactElement;
    const props = tree.props as Record<string, unknown>;
    expect(props['data-testid']).toBe('planning-stream-panel');
    expect(props['aria-label']).toBe('AI planning stream');
  });

  it('omits the mode control when called without `mode`/`onModeChange` (participant read-only view)', () => {
    const tree = PlanningStreamPanel(baseProps);
    const buttons = collect(tree, (p) => p['type'] === 'button' || p['className'] === 'planning-stream-mode');
    expect(buttons).toHaveLength(0);
  });

  it('participant empty state shows "Waiting for the AI…" (NEVER the Off copy)', () => {
    const tree = PlanningStreamPanel(baseProps);
    const text = textOf(tree);
    expect(text).toContain('Waiting for the AI to share its planning');
    expect(text).not.toContain('Off — the AI is not sharing its planning.');
  });

  it('coordinator mode=off empty state shows the "Off" copy', () => {
    const tree = PlanningStreamPanel({ ...baseProps, mode: 'off', onModeChange: () => {} });
    const text = textOf(tree);
    expect(text).toContain('Off — the AI is not sharing its planning.');
  });

  it('renders three mode buttons when called with `mode`/`onModeChange` (coordinator control)', () => {
    const tree = PlanningStreamPanel({ ...baseProps, mode: 'coordinator', onModeChange: () => {} });
    const buttons = collect(tree, (p) => p['className'] === 'planning-stream-mode');
    expect(buttons).toHaveLength(3);
    const labels = buttons.map((b) => textOf(b));
    expect(labels).toEqual(['Off', 'Just me', 'Everyone']);
  });

  it('`aria-pressed` reflects the current mode (one button pressed at a time)', () => {
    const tree = PlanningStreamPanel({ ...baseProps, mode: 'everyone', onModeChange: () => {} });
    const buttons = collect(tree, (p) => p['className'] === 'planning-stream-mode');
    const pressed = buttons.map((b) => (b.props as Record<string, unknown>)['aria-pressed']);
    expect(pressed).toEqual([false, false, true]);
  });

  it('clicking a mode button invokes `onModeChange` with the button value', () => {
    const onModeChange = vi.fn();
    const tree = PlanningStreamPanel({ ...baseProps, mode: 'off', onModeChange });
    const buttons = collect(tree, (p) => p['className'] === 'planning-stream-mode');
    // Click "Just me" (coordinator) — second button.
    const click = (buttons[1]!.props as { onClick: () => void }).onClick;
    click();
    expect(onModeChange).toHaveBeenCalledTimes(1);
    expect(onModeChange).toHaveBeenCalledWith('coordinator');
  });

  it('renders each line as a paragraph in order', () => {
    const stream = [
      { text: 'first thought', at: 't1' },
      { text: 'second thought', at: 't2' },
    ];
    const tree = PlanningStreamPanel({ stream });
    const lines = collect(tree, (p) => p['className'] === 'planning-stream-line');
    expect(lines).toHaveLength(2);
    expect(textOf(lines[0]!)).toBe('first thought');
    expect(textOf(lines[1]!)).toBe('second thought');
  });
});
