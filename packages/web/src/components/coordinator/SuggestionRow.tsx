import type { WireSuggestion } from '../../state.js';

interface SuggestionRowProps {
  suggestion: WireSuggestion;
  participantName: string; // resolved by parent from session.participants
  ticketId: string; // radio group name scoping (one group per question)
  isSelected: boolean;
  disabled: boolean; // true when the question is resolved OR a record is in flight
  index: number; // stable testid suffix
  onSelect: () => void;
}

/**
 * A single pick-able suggestion. Native `<input type="radio">` semantics give
 * arrow-key navigation + screen-reader grouping for free (UI-SPEC A11y). When
 * `disabled` (resolved/recording) the radio is non-interactive and the row drops
 * the `your-pick` highlight so the resolved card reads as read-only history.
 */
export function SuggestionRow({
  suggestion,
  participantName,
  ticketId,
  isSelected,
  disabled,
  index,
  onSelect,
}: SuggestionRowProps) {
  const className = `coordinator-suggestion-row${isSelected && !disabled ? ' your-pick' : ''}`;
  return (
    <label className={className}>
      <input
        type="radio"
        name={`coordinator-pick-${ticketId}`}
        data-testid={`coordinator-suggestion-${suggestion.participant_id}-${index}`}
        disabled={disabled}
        checked={isSelected}
        onChange={onSelect}
        style={{ width: 'auto', marginRight: '.5rem' }}
      />
      <strong>{participantName}</strong>: {suggestion.value}
      {suggestion.rationale && <span className="muted"> ({suggestion.rationale})</span>}
    </label>
  );
}
