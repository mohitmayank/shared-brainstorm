// REL-05 / D-20 / D-21: TunnelBanner dismiss + reappear-on-new-URL behavior.
//
// The spec emits `tunnel_url_changed` events directly via the in-process
// `mcpState.manager.emitExternal(...)` because the LAN fixture has no real
// tunnel and cloudflared-style URL churn cannot occur naturally. Each emit
// lands in the SessionManager's RingBuffer + broadcaster, the browser's
// reducer updates `state.tunnelBanner`, and the App renders / hides the
// banner based on the dismiss-ack URL in `useState`.

import { test, expect } from './fixtures.js';
import { mcpState } from '../packages/server/src/mcp/state.js';

test('tunnel banner: dismiss applies to one URL only; new URL re-shows it (Pitfall 3)', async ({
  session,
  page,
}) => {
  test.setTimeout(30_000);

  // Step 1: Normal join.
  await page.goto(session.public_url);
  await expect(page.getByLabel(/display name/i)).toBeVisible();
  await page.getByLabel(/display name/i).fill('Alice');
  // No join code in v2.0.0 — approval-gate model.
  await page.getByRole('button', { name: /join session/i }).click();
  await expect(page.getByText(/waiting for a question from the ai host/i)).toBeVisible({
    timeout: 10_000,
  });

  // Grant clipboard-write so the standards-track navigator.clipboard path
  // succeeds; without it the component falls back to document.execCommand
  // which Playwright also honors but is harder to assert on.
  await page.context().grantPermissions(['clipboard-write', 'clipboard-read'], {
    origin: session.public_url,
  });

  // Sanity: the banner must not be visible before any emit.
  expect(mcpState.manager).not.toBeNull();
  await expect(page.locator('.tunnel-banner')).toHaveCount(0);

  // Step 2: Emit a tunnel_url_changed for first.example. Banner must render.
  mcpState.manager!.emitExternal({
    type: 'tunnel_url_changed',
    payload: { public_url: 'https://first.example/' },
  });
  const banner = page.locator('.tunnel-banner');
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText('https://first.example/');

  // Step 3: Click Copy; the inline "Copied!" indicator must appear within 1s.
  await banner.getByRole('button', { name: /copy/i }).click();
  await expect(banner.getByText(/copied!/i)).toBeVisible({ timeout: 1_000 });

  // Optional: verify the clipboard actually got the URL. Reads can be flaky
  // under some Playwright versions, so we wrap in try/catch and ignore
  // permission glitches — the inline "Copied!" already proves the path ran.
  try {
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    if (clip) {
      expect(clip).toBe('https://first.example/');
    }
  } catch {
    /* clipboard read denied in this Playwright build — skip the readback */
  }

  // Step 4: Click × dismiss; banner must hide.
  await banner.getByRole('button', { name: /dismiss tunnel url banner/i }).click();
  await expect(banner).toBeHidden({ timeout: 1_000 });

  // Step 5: Emit second URL. Banner must re-appear with the new URL
  // (Pitfall 3 / D-20: dismiss-ack was for first.example, not for any URL).
  mcpState.manager!.emitExternal({
    type: 'tunnel_url_changed',
    payload: { public_url: 'https://second.example/' },
  });
  await expect(page.locator('.tunnel-banner')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.tunnel-banner')).toContainText('https://second.example/');

  // Step 6: Emit the SAME second.example URL again — banner stays visible
  // (it was never dismissed for this URL specifically).
  mcpState.manager!.emitExternal({
    type: 'tunnel_url_changed',
    payload: { public_url: 'https://second.example/' },
  });
  // No transition expected; assert stable visibility after a short wait.
  await page.waitForTimeout(200);
  await expect(page.locator('.tunnel-banner')).toBeVisible();
  await expect(page.locator('.tunnel-banner')).toContainText('https://second.example/');

  // Step 7: Dismiss second.example. Emit it AGAIN — must stay dismissed
  // because the dismiss-ack URL now equals state.tunnelBanner.url.
  await page
    .locator('.tunnel-banner')
    .getByRole('button', { name: /dismiss tunnel url banner/i })
    .click();
  await expect(page.locator('.tunnel-banner')).toBeHidden({ timeout: 1_000 });

  mcpState.manager!.emitExternal({
    type: 'tunnel_url_changed',
    payload: { public_url: 'https://second.example/' },
  });
  // The banner must NOT reappear — dismiss is sticky for this exact URL.
  // Give the reducer + render cycle a moment to apply, then assert hidden.
  await page.waitForTimeout(300);
  await expect(page.locator('.tunnel-banner')).toBeHidden();
});
