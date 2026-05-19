import { useEffect, useRef, useState } from 'react';

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

async function copyToClipboardWithFallback(url: string): Promise<boolean> {
  // Prefer the standards-track API. In secure contexts (HTTPS, localhost)
  // this is available; under Playwright we grant the `clipboard-write`
  // permission in the spec's browser context so this path works.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // Permission denied or some other failure — fall through to the
      // execCommand path below rather than surfacing a hard error.
    }
  }
  // Fallback: stage the URL in a hidden textarea, select, exec the deprecated
  // `copy` command. Still works in older Chromium and avoids requiring the
  // newer Clipboard API permission grant.
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = url;
  ta.setAttribute('readonly', '');
  ta.style.position = 'absolute';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    // `execCommand` is deprecated but still implemented in all browsers and is
    // the only synchronous copy mechanism that works without the Clipboard
    // API permission. The standards-track path above is preferred.
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
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
