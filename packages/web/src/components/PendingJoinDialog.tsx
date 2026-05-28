import { useEffect, useRef } from 'react';
import type { WireParticipant } from '../state.js';

/**
 * Pending-join popup: a centered modal (same backdrop/card shape as
 * {@link PlannerLinkDialog}) that surfaces the list of teammates currently
 * waiting for approval, so the coordinator doesn't miss a join while focused
 * elsewhere. The existing pending-roster section stays as a fallback for
 * anyone the coordinator dismisses without deciding.
 *
 * Approve and Disapprove both delegate to the parent — Disapprove maps to the
 * same `kickParticipant` path as the roster's Kick button, so a rejected
 * teammate immediately sees the existing "You were not approved" screen.
 *
 * Dismissal is per-arrival-cohort: × / Esc / backdrop click all call
 * `onDismiss`, and the parent tracks which pending ids have been dismissed so
 * a NEW joiner whose id isn't in the dismissed set re-opens this dialog
 * automatically.
 */
export interface PendingJoinDialogProps {
  pending: WireParticipant[];
  onApprove: (id: string) => void;
  onDisapprove: (id: string) => void;
  onDismiss: () => void;
}

export function PendingJoinDialog({
  pending,
  onApprove,
  onDisapprove,
  onDismiss,
}: PendingJoinDialogProps): React.ReactElement | null {
  // Hooks first (rules-of-hooks): the early-return below must come AFTER hooks
  // so the call order is stable across renders. In practice the caller guards
  // with `showPendingDialog` so this component is unmounted when there are no
  // pending — the empty-pending case is purely defensive.
  const firstApproveRef = useRef<HTMLButtonElement | null>(null);

  // Initial focus on the primary action + Esc-to-close. Mirrors PlannerLinkDialog.
  useEffect(() => {
    firstApproveRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  if (pending.length === 0) return null;

  const count = pending.length;
  const label = count === 1 ? '1 teammate' : `${count} teammates`;

  return (
    <div
      className="planner-dialog-backdrop"
      onClick={onDismiss}
      data-testid="pending-join-backdrop"
    >
      <div
        className="planner-dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pending-join-title"
        data-testid="pending-join-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="planner-dialog-dismiss pending-join-dismiss"
          onClick={onDismiss}
          aria-label="Close pending-join dialog"
        >
          ×
        </button>
        <h2 id="pending-join-title">Approve teammates?</h2>
        <p className="muted">
          {label} want to join. Approve to let them suggest answers; disapprove to block them.
        </p>
        <ul className="pending-join-list">
          {pending.map((p, i) => (
            <li key={p.id} className="pending-join-row">
              <span className="pending-join-name">{p.display_name}</span>
              <button
                ref={i === 0 ? firstApproveRef : null}
                type="button"
                className="pending-join-approve"
                aria-label={`Approve ${p.display_name}`}
                onClick={() => onApprove(p.id)}
              >
                Approve
              </button>
              <button
                type="button"
                className="pending-join-disapprove"
                aria-label={`Disapprove ${p.display_name}`}
                onClick={() => onDisapprove(p.id)}
              >
                Disapprove
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
