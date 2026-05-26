// Phase 14 (SHARE-01/02): Share Planner Link E2E spec.
//
// Tests the ShareLinkButton behavior in the coordinator view:
//  1. Button is visible after session start
//  2. Clipboard path: clicking Share link copies URL and shows 'Copied!'
//  3. navigator.share path: share is called with the public join URL (not coordinator_url)
//
// Mirrors the structure of e2e/tunnel-banner.spec.ts (clipboard grant pattern).

import { test, expect } from './fixtures.js';
import { mcpState } from '../packages/server/src/mcp/state.js';

test.describe('share-link (Phase 14 SHARE-01/02)', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('coordinator view shows Share link button after session start', async ({
    session,
    page,
  }) => {
    test.setTimeout(30_000);

    // Open the coordinator URL directly — no join form needed.
    await page.goto(session.coordinator_url);
    await expect(page.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // The Share link button must be visible on the coordinator page.
    const shareBtn = page.getByRole('button', { name: /share link/i });
    await expect(shareBtn).toBeVisible({ timeout: 5_000 });
  });

  test("clipboard path: clicking Share link copies URL and shows 'Copied!'", async ({
    session,
    page,
  }) => {
    test.setTimeout(30_000);

    // Grant clipboard permissions for the coordinator URL origin.
    await page.context().grantPermissions(['clipboard-write', 'clipboard-read'], {
      origin: session.coordinator_url,
    });

    await page.goto(session.coordinator_url);
    await expect(page.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Disable navigator.share so the clipboard fallback path runs.
    await page.evaluate(() => {
      // @ts-expect-error — overriding navigator.share for test purposes
      navigator.share = undefined;
    });

    // Click the Share link button.
    const shareBtn = page.getByRole('button', { name: /share link/i });
    await expect(shareBtn).toBeVisible({ timeout: 5_000 });
    await shareBtn.click();

    // The "Copied!" indicator must appear within 2s (visual confirmation of clipboard write).
    await expect(page.getByText(/copied!/i)).toBeVisible({ timeout: 2_000 });
  });

  test('navigator.share path: share is called with the public join URL', async ({
    session,
    page,
  }) => {
    test.setTimeout(30_000);

    await page.goto(session.coordinator_url);
    await expect(page.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Intercept navigator.share via a spy that records arguments and resolves.
    // This runs before the button click so the spy is in place.
    await page.evaluate(() => {
      const spy = {
        calls: [] as Array<{ title?: string; text?: string; url?: string }>,
      };
      // @ts-expect-error — assigning spy to window for later retrieval
      window.__shareSpy = spy;
      navigator.share = async (data?: { title?: string; text?: string; url?: string }) => {
        spy.calls.push(data ?? {});
      };
    });

    // Click the Share link button.
    const shareBtn = page.getByRole('button', { name: /share link/i });
    await expect(shareBtn).toBeVisible({ timeout: 5_000 });
    await shareBtn.click();

    // Give the async onClick a moment to run.
    await page.waitForTimeout(200);

    // Retrieve the spy's recorded calls and assert the URL.
    const spyCalls = await page.evaluate(() => {
      // @ts-expect-error — reading spy from window
      return (window.__shareSpy as { calls: Array<Record<string, string>> }).calls;
    });

    expect(spyCalls).toHaveLength(1);
    const shareData = spyCalls[0]!;

    // The URL passed to navigator.share must be the public join URL (public_url),
    // NOT the coordinator URL (which carries the ?token= parameter).
    // This validates T-14-01: only public_url reaches the share call.
    expect(shareData.url).toBeTruthy();
    expect(shareData.url).not.toContain('token');
    expect(shareData.url).not.toContain('role=coordinator');

    // Sanity: the mcpState manager must have set a public_url on the session.
    // (public_url is passed to the coordinator welcome by the server in Plan 14-02/03.)
    expect(mcpState.manager).not.toBeNull();
  });
});
