/**
 * Dismissable error banner shown when the server emits `transport_failed`
 * (Phase 12 RESIL-01). The reducer (`packages/web/src/state.ts`) records the
 * failure as `state.transportFailed`; the dismiss-ack lives in `App.tsx`
 * `useState<boolean>` so the component remains purely presentational.
 *
 * A permanent failure fires exactly once per session, so a simple boolean
 * flag in App.tsx is sufficient — no URL-equality check needed (unlike
 * TunnelBanner Pitfall 3).
 */
export interface TransportFailedBannerProps {
  message: string;
  restartCount: number;
  onDismiss: () => void;
}

export function TransportFailedBanner({
  message,
  restartCount,
  onDismiss,
}: TransportFailedBannerProps) {
  return (
    <div className="transport-failed-banner" role="alert" aria-live="assertive">
      <div className="transport-failed-text">
        {`Tunnel permanently unavailable — cloudflared could not reconnect after ${restartCount} ${restartCount === 1 ? 'attempt' : 'attempts'}.`}
        {message ? <div className="transport-failed-detail">{`Details: ${message}`}</div> : null}
        <div className="transport-failed-recovery">
          To recover: stop and restart the session. Cloudflared failures are usually caused by a
          firewall or network blocking outbound HTTPS. Teammates on the same network can use the
          local URL if cloudflared is unavailable.
        </div>
      </div>
      <span className="transport-failed-actions">
        <button
          type="button"
          className="transport-failed-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss tunnel failure banner"
        >
          ×
        </button>
      </span>
    </div>
  );
}
