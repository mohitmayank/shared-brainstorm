import type { WireSession } from '../../state.js';

interface DecisionsPanelProps {
  decisions: WireSession['decisions'];
}

/**
 * Recorded decisions list (UI-SPEC Per-Component Contract). Returns `null` when
 * there are none — no empty card. Reuses the existing `.decisions` list styling.
 */
export function DecisionsPanel({ decisions }: DecisionsPanelProps) {
  if (decisions.length === 0) return null;
  return (
    <section
      aria-label="Decisions"
      data-testid="coordinator-decisions-panel"
      className="card coordinator-decisions-panel"
    >
      <h2>Decisions ({decisions.length})</h2>
      <ul className="decisions">
        {decisions.map((d) => (
          <li key={d.question_id} data-testid={`coordinator-decision-${d.question_id}`}>
            <span className="muted">{d.question}</span> → <strong>{d.answer}</strong>
          </li>
        ))}
      </ul>
    </section>
  );
}
