/**
 * Shared clipboard utility used by TunnelBanner and ShareLinkButton.
 *
 * Two-path strategy:
 *   1. navigator.clipboard.writeText — standards-track, requires a secure context
 *      (HTTPS / localhost). In secure contexts this is preferred. Under Playwright
 *      the `clipboard-write` permission is granted in the spec's browser context so
 *      this path works in tests.
 *   2. document.execCommand('copy') fallback — deprecated but still implemented in
 *      all browsers. Used when the Clipboard API is unavailable or throws. Requires
 *      a DOM selection, so we stage the URL in a transient off-screen <textarea>.
 *
 * SSR guard: if `document` is undefined (server-side render) the function returns
 * false rather than throwing.
 */
export async function copyToClipboardWithFallback(url: string): Promise<boolean> {
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
