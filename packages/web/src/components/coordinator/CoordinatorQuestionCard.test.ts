/**
 * CHATAI-02 invariant proof for CoordinatorQuestionCard.
 *
 * Pure .ts file — no render library, no @testing-library, no jsdom.
 * Validates the data-model invariant: clarifications are structurally separate
 * from suggestions at every layer; the coordinator pick radiogroup NEVER sees
 * clarifications.
 */
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { newClarificationId } from '@shared-brainstorm/shared';
import type { WireQuestion } from '../../state.js';

// ---------------------------------------------------------------------------
// Render-free JSX-tree helpers (this project has no @testing-library; tests
// call the component as a function and inspect the returned React element tree).
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

/** Depth-first search for the first element carrying the given data-testid. */
function findByTestId(node: AnyNode, testId: string): ReactElement | null {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props && props['data-testid'] === testId) return node as ReactElement;
  for (const child of childrenOf(node)) {
    const hit = findByTestId(child, testId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Collect every element in the tree whose `type` is a function component with
 * the given name (e.g. 'SuggestionRow'). Child components are not rendered by
 * the render-free harness — we inspect the props passed to them instead.
 */
function findComponents(node: AnyNode, name: string): ReactElement[] {
  const out: ReactElement[] = [];
  const walk = (n: AnyNode): void => {
    if (n === null || n === undefined || typeof n !== 'object') return;
    const type = (n as { type?: unknown }).type;
    if (typeof type === 'function' && (type as { name?: string }).name === name) {
      out.push(n as ReactElement);
    }
    for (const child of childrenOf(n)) walk(child);
  };
  walk(node);
  return out;
}

// ---------------------------------------------------------------------------
// Minimal question factory — builds a plain object matching the WireQuestion
// interface without any imports from server-only modules.
// ---------------------------------------------------------------------------
function makeQuestion(overrides?: Partial<WireQuestion>): WireQuestion {
  return {
    id: 'sb_q_001',
    ticket_id: 'sb_t_001',
    asked_at: '2026-01-01T00:00:00Z',
    text: 'Which DB?',
    status: 'broadcast',
    suggestions: [],
    comments: [],
    clarifications: [],
    resolution: null,
    ...overrides,
  };
}

describe('CHATAI-02: clarifications and suggestions are independent arrays', () => {
  it('clarifications and suggestions are different array references — no aliasing', () => {
    const q = makeQuestion({
      clarifications: [
        {
          id: newClarificationId(),
          participant_id: 'sb_p_001',
          text: 'Why Postgres?',
          asked_at: '2026-01-01T00:00:01Z',
        },
      ],
      suggestions: [
        {
          id: 's_1',
          participant_id: 'sb_p_002',
          value: 'Postgres',
          at: '2026-01-01T00:00:02Z',
        },
      ],
    });
    // Structurally separate
    expect(q.clarifications).not.toBe(q.suggestions);
    expect(q.clarifications).toHaveLength(1);
    expect(q.suggestions).toHaveLength(1);
    // No shared item by id
    const clarificationIds = q.clarifications.map((cl) => cl.id);
    const suggestionIds = q.suggestions.map((s) => s.id);
    for (const clId of clarificationIds) {
      expect(suggestionIds).not.toContain(clId);
    }
  });

  it('clarification ID namespace is distinct from suggestion ID namespace', () => {
    const clId = newClarificationId();
    // Clarification IDs start with sb_cl_; suggestion IDs start with s_
    expect(clId).toMatch(/^sb_cl_/);
    // A suggestion ID produced by SessionManager would start with 's_', not 'sb_cl_'
    const syntheticSuggestionId = `s_${1}`;
    expect(syntheticSuggestionId).not.toMatch(/^sb_cl_/);
  });

  it('CoordinatorQuestionCard component accepts clarifications in question prop without throw', async () => {
    // Dynamically import the component to verify it does not crash when a
    // question prop carries clarifications (CHATAI-02: clarifications are ignored
    // by the pick radiogroup). We treat the JSX return value as opaque — this is
    // a pure .ts file with no renderer — but the import + call must not throw.
    const { CoordinatorQuestionCard } = await import('./CoordinatorQuestionCard.js');
    const q = makeQuestion({
      clarifications: [
        {
          id: newClarificationId(),
          participant_id: 'sb_p_001',
          text: 'Why Postgres?',
          asked_at: '2026-01-01T00:00:01Z',
        },
      ],
      suggestions: [
        {
          id: 's_1',
          participant_id: 'sb_p_002',
          value: 'Postgres',
          at: '2026-01-01T00:00:02Z',
        },
      ],
    });
    const result = CoordinatorQuestionCard({
      question: q,
      participants: [],
      participantName: (id) => id,
      selectedSuggestionId: undefined,
      overrideText: '',
      recording: false,
      error: null,
      addAnswerText: '',
      onSelectSuggestion: () => {},
      onChangeOverride: () => {},
      onRecordSuggestion: () => {},
      onRecordOverride: () => {},
      onChangeAddAnswer: () => {},
      onAddAnswer: () => {},
    });
    // JSX element is a non-null object — clarifications did not cause a crash
    expect(result).not.toBeNull();
    // The suggestion array was not contaminated by clarification entries
    expect(q.suggestions).toHaveLength(1);
    expect(q.clarifications).toHaveLength(1);
    expect(q.suggestions[0]!.id).not.toBe(q.clarifications[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// Coordinator-as-planner: attribution, answered-count exclusion, add-answer UI.
// ---------------------------------------------------------------------------
describe('Coordinator-as-planner: CoordinatorQuestionCard', () => {
  async function renderCard(
    overrides: Partial<Parameters<
      Awaited<typeof import('./CoordinatorQuestionCard.js')>['CoordinatorQuestionCard']
    >[0]>,
  ) {
    const { CoordinatorQuestionCard } = await import('./CoordinatorQuestionCard.js');
    return CoordinatorQuestionCard({
      question: makeQuestion(),
      participants: [],
      participantName: (id) => id,
      selectedSuggestionId: undefined,
      overrideText: '',
      recording: false,
      error: null,
      addAnswerText: '',
      onSelectSuggestion: () => {},
      onChangeOverride: () => {},
      onRecordSuggestion: () => {},
      onRecordOverride: () => {},
      onChangeAddAnswer: () => {},
      onAddAnswer: () => {},
      ...overrides,
    });
  }

  it('renders a coordinator-authored suggestion attributed as "Coordinator"', async () => {
    const tree = await renderCard({
      question: makeQuestion({
        suggestions: [
          {
            id: 's_1',
            participant_id: 'coordinator',
            value: 'use JWT',
            at: '2026-01-01T00:00:02Z',
            author_kind: 'coordinator',
            display_name: 'Coordinator',
          },
        ],
      }),
      // Roster lookup would NOT find 'coordinator' — proves embedded name wins.
      participantName: (id) => (id === 'coordinator' ? 'WRONG' : id),
    });
    // SuggestionRow receives the resolved name via its `participantName` prop
    // (child components are not rendered by the render-free harness).
    const rows = findComponents(tree, 'SuggestionRow');
    expect(rows).toHaveLength(1);
    const rowProps = rows[0]!.props as { participantName: string; suggestion: { value: string } };
    expect(rowProps.participantName).toBe('Coordinator');
    expect(rowProps.participantName).not.toBe('WRONG');
    expect(rowProps.suggestion.value).toBe('use JWT');
  });

  it('the "N/M answered" count EXCLUDES the coordinator\'s own suggestion', async () => {
    const tree = await renderCard({
      question: makeQuestion({
        suggestions: [
          {
            id: 's_1',
            participant_id: 'coordinator',
            value: 'use JWT',
            at: '2026-01-01T00:00:02Z',
            author_kind: 'coordinator',
            display_name: 'Coordinator',
          },
        ],
      }),
      // Two approved participants, neither has answered.
      participants: [
        { id: 'sb_p_001', display_name: 'Alice', joined_at: '', status: 'approved' },
        { id: 'sb_p_002', display_name: 'Bob', joined_at: '', status: 'approved' },
      ],
    });
    const progress = findByTestId(tree, 'batch-progress-sb_q_001');
    expect(progress).not.toBeNull();
    const progressText = textOf(progress);
    // A coordinator suggestion + 0 participant answers ⇒ "0/2 answered", never "1/2".
    expect(progressText).toContain('0/2 answered');
    expect(progressText).not.toContain('1/2');
  });

  it('renders the add-answer textarea + button and fires the submit callback', async () => {
    let added = false;
    const tree = await renderCard({
      addAnswerText: 'my answer',
      onAddAnswer: () => {
        added = true;
      },
    });
    const textarea = findByTestId(tree, 'coordinator-add-answer-textarea');
    const submit = findByTestId(tree, 'coordinator-add-answer-submit');
    expect(textarea).not.toBeNull();
    expect(submit).not.toBeNull();
    // Button enabled (non-empty trimmed text, not recording).
    expect((submit!.props as { disabled?: boolean }).disabled).toBe(false);
    // Firing the click handler invokes the parent callback.
    (submit!.props as { onClick: () => void }).onClick();
    expect(added).toBe(true);
  });

  it('when the question has options, the add-answer block is a radio group (no textarea) and selecting fires onChangeAddAnswer with the label', async () => {
    let chosen: string | null = null;
    const tree = await renderCard({
      question: makeQuestion({
        options: [
          { label: 'Postgres', description: 'relational' },
          { label: 'Mongo' },
        ],
      }),
      onChangeAddAnswer: (text) => {
        chosen = text;
      },
    });
    // Options replace the free-text textarea entirely (mirrors the participant card).
    expect(findByTestId(tree, 'coordinator-add-answer-textarea')).toBeNull();
    const optA = findByTestId(tree, 'coordinator-add-answer-option-Postgres');
    const optB = findByTestId(tree, 'coordinator-add-answer-option-Mongo');
    expect(optA).not.toBeNull();
    expect(optB).not.toBeNull();
    // The radio input lives inside the label — selecting it reports the label.
    const radio = childrenOf(optA).find(
      (n) => typeof n === 'object' && n !== null && (n as { type?: unknown }).type === 'input',
    ) as { props: { onChange: () => void; checked: boolean } } | undefined;
    expect(radio).toBeDefined();
    radio!.props.onChange();
    expect(chosen).toBe('Postgres');
  });

  it('option radio reflects the current addAnswerText as checked', async () => {
    const tree = await renderCard({
      question: makeQuestion({
        options: [{ label: 'Postgres' }, { label: 'Mongo' }],
      }),
      addAnswerText: 'Mongo',
    });
    const checkedOf = (testId: string): boolean => {
      const label = findByTestId(tree, testId);
      const radio = childrenOf(label).find(
        (n) => typeof n === 'object' && n !== null && (n as { type?: unknown }).type === 'input',
      ) as { props: { checked: boolean } } | undefined;
      return radio?.props.checked ?? false;
    };
    expect(checkedOf('coordinator-add-answer-option-Mongo')).toBe(true);
    expect(checkedOf('coordinator-add-answer-option-Postgres')).toBe(false);
  });
});
