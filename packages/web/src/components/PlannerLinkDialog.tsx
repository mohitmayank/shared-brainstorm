import { useEffect, useRef, useState } from 'react';
import { copyToClipboardWithFallback } from '../lib/clipboard.js';

/**
 * On-load dialog shown to the coordinator carrying the participant ("planner")
 * join link + a copy button, so teammates get invited from the browser now that
 * the terminal no longer auto-copies the invite.
 *
 * Security contract (same as ShareLinkButton): renders ONLY `publicUrl` — never
 * the coordinator URL. The parent guards `publicUrl !== null` before mounting.
 *
 * Dismissal is per-load (no persistence): the parent owns a `useState(true)` and
 * flips it false on dismiss. Closes on the × button, the backdrop, and Esc.
 */
export interface PlannerLinkDialogProps {
  /** Participant JOIN URL to share. Never coordinator_url. */
  publicUrl: string;
  onDismiss: () => void;
  /** Optional hook fired after a successful copy (test seam, mirrors ShareLinkButton). */
  onCopy?: () => void;
}

export function PlannerLinkDialog({ publicUrl, onDismiss, onCopy }: PlannerLinkDialogProps) {
  const [copied, setCopied] = useState<boolean>(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyButtonRef = useRef<HTMLButtonElement | null>(null);

  // Initial focus on the copy button (the primary action) + Esc-to-close.
  useEffect(() => {
    copyButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, [onDismiss]);

  const handleCopy = async (): Promise<void> => {
    const ok = await copyToClipboardWithFallback(publicUrl);
    if (ok) {
      setCopied(true);
      if (onCopy) onCopy();
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(false);
        copyTimer.current = null;
      }, 2000);
    }
  };

  return (
    <div
      className="planner-dialog-backdrop"
      onClick={onDismiss}
      data-testid="planner-dialog-backdrop"
    >
      <div
        className="planner-dialog card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="planner-dialog-title"
        // Stop backdrop click from firing when interacting inside the dialog.
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="planner-dialog-dismiss"
          onClick={onDismiss}
          aria-label="Close share-link dialog"
        >
          ×
        </button>
        <h2 id="planner-dialog-title">Invite your team</h2>
        <p className="muted">
          Share this link so teammates can join. They&apos;ll wait for your approval once they open it.
        </p>
        <code className="planner-dialog-url">{publicUrl}</code>
        <div className="planner-dialog-actions">
          <button
            ref={copyButtonRef}
            type="button"
            className="planner-dialog-copy"
            onClick={() => {
              void handleCopy();
            }}
          >
            Copy link
          </button>
          {copied && (
            <span className="planner-dialog-copied" role="status">
              Copied!
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
