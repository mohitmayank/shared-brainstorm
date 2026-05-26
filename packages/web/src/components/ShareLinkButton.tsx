import { useEffect, useRef, useState } from 'react';
import { copyToClipboardWithFallback } from '../lib/clipboard.js';

export interface ShareLinkButtonProps {
  /**
   * The participant JOIN URL to share. Never coordinator_url — only the public
   * join link is passed to this component. The parent guard
   * `{publicUrl && <ShareLinkButton publicUrl={publicUrl} />}` ensures this
   * is always a valid join link (T-14-05 security contract).
   */
  publicUrl: string;
  /**
   * Optional hook fired after a successful clipboard write. Used by tests to
   * assert the copy path ran without depending on real browser clipboard state.
   * Mirrors TunnelBannerProps.onCopy.
   */
  onCopy?: () => void;
}

export function ShareLinkButton({ publicUrl, onCopy }: ShareLinkButtonProps) {
  const [copied, setCopied] = useState<boolean>(false);
  // Hold the timeout id across renders so we can clear it on unmount —
  // otherwise React would warn about state updates on unmounted components.
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard against setState after unmount: the clipboard write is async, so the
  // component can unmount (session ends) between the await and setCopied.
  const mounted = useRef<boolean>(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
      if (copyTimer.current !== null) {
        clearTimeout(copyTimer.current);
        copyTimer.current = null;
      }
    };
  }, []);

  const handleClick = async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title: 'shared-brainstorm',
          text: 'Join my shared-brainstorm session',
          url: publicUrl,
        });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // non-AbortError: fall through to clipboard copy
      }
    }
    const ok = await copyToClipboardWithFallback(publicUrl);
    if (ok) {
      if (onCopy) onCopy();
      if (!mounted.current) return; // component unmounted during the async copy
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(false);
        copyTimer.current = null;
      }, 2000);
    }
  };

  return (
    <span className="share-link">
      <button
        type="button"
        className="share-link-button"
        onClick={handleClick}
      >
        Share link
      </button>
      {copied && (
        <span className="share-link-copied" role="status">
          Copied!
        </span>
      )}
    </span>
  );
}
