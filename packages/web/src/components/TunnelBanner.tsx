import { useEffect, useRef, useState } from 'react';
import { copyToClipboardWithFallback } from '../lib/clipboard.js';

/**
 * Dismissable banner shown when the server emits `tunnel_url_changed`
 * (REL-05 / D-20 / D-21). The reducer (`packages/web/src/state.ts`) records
 * the latest tunnel URL; the dismiss-ack lives in `App.tsx` `useState` so
 * Pitfall 3 (banner reappears on a new URL even after dismiss) is enforced
 * at the call site by comparing the dismissed URL against the current one.
 *
 * Copy uses `navigator.clipboard.writeText` with a `document.execCommand`
 * fallback for older browsers and Playwright contexts without an explicit
 * clipboard-write permission. The fallback uses a transient off-screen
 * `<textarea>` because `execCommand('copy')` requires a selection.
 */
export interface TunnelBannerProps {
  url: string;
  onDismiss: () => void;
  /**
   * Optional hook fired after a successful copy. Used by tests to assert
   * the copy path ran without depending on real browser clipboard state.
   */
  onCopy?: () => void;
}


export function TunnelBanner({ url, onDismiss, onCopy }: TunnelBannerProps) {
  const [copied, setCopied] = useState<boolean>(false);
  // Hold the timeout id across renders so we can clear it on unmount —
  // otherwise React would warn about state updates on unmounted components
  // when the banner gets dismissed mid-flash.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, []);

  const handleCopy = async (): Promise<void> => {
    const ok = await copyToClipboardWithFallback(url);
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
    <div className="tunnel-banner" role="status">
      <span className="tunnel-banner-text">
        Tunnel URL changed — share the new link with teammates.
      </span>{' '}
      <code className="tunnel-banner-url">{url}</code>
      <span className="tunnel-banner-actions">
        <button
          type="button"
          className="tunnel-banner-copy"
          onClick={() => {
            void handleCopy();
          }}
        >
          Copy
        </button>
        {copied && (
          <span className="tunnel-banner-copied" role="status">
            Copied!
          </span>
        )}
        <button
          type="button"
          className="tunnel-banner-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss tunnel URL banner"
        >
          ×
        </button>
      </span>
    </div>
  );
}
