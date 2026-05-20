import type { WireComment } from '../../state.js';

interface CommentRowProps {
  comment: WireComment;
  participantName: string; // resolved by parent from session.participants
}

/**
 * Read-only comment line inside a coordinator question card's `<ul class="comments">`.
 * No interactive elements (UI-SPEC Per-Component Contract).
 */
export function CommentRow({ comment, participantName }: CommentRowProps) {
  return (
    <li className="coordinator-comment-row">
      <strong>{participantName}</strong>: {comment.text}
    </li>
  );
}
