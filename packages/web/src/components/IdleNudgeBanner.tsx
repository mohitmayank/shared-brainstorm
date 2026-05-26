/**
 * Dismissable advisory banner shown when the server emits `room_idle_nudge`
 * (Phase 11 ROOM-02). The reducer records the latest nudge as `idleNudge`;
 * the dismiss-ack lives in `Coordinator.tsx` `useState<string | null>` keyed
 * by `question_id` so a new nudge for a different question automatically
 * re-arms the banner (Pitfall 3 pattern, mirroring TunnelBanner.tsx).
 *
 * Styling uses `--surface-2` background (neutral advisory) — NOT `--banner-bg`
 * (amber) and NOT `--error` (red). Idle is advisory, not a failure.
 */
export interface IdleNudgeBannerProps {
  onDismiss: () => void;
}

export function IdleNudgeBanner({ onDismiss }: IdleNudgeBannerProps) {
  return (
    <div className="idle-nudge-banner" role="status" aria-live="polite">
      <span className="idle-nudge-text">
        No activity for a while — you can answer and move on.
      </span>
      <span className="idle-nudge-actions">
        <button
          type="button"
          className="idle-nudge-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss idle nudge"
        >
          ×
        </button>
      </span>
    </div>
  );
}
