// REL-04 / D-19: exercise the exponential WS reconnect backoff + the
// "Having trouble reconnecting — Try now" advisory that appears after 5
// consecutive close-without-welcome cycles.
//
// Strategy:
//   1. Install a WebSocket constructor stub via `addInitScript`. The stub
//      tracks every WS created and exposes a __sbForceFail flag (initially
//      false — passthrough). The stub also stashes the active WS handle on
//      window so the spec can close it on demand.
//   2. Join the session and get approved (v2.0.0 approval-gate model). The
//      SPA reaches `hasSession=true` and wsRetryCount stays at 0.
//   3. Flip __sbForceFail=true and call __sbCloseCurrent() — this closes
//      the live WS, triggering the SPA's onClose handler. The reconnect
//      timer schedules a new WS; that new WS opens through the stub which,
//      now in force-fail mode, immediately closes it. The loop continues
//      until wsRetryCount >= 5.
//   4. Click "Try now" → wsRetryCount resets → prompt disappears.

import { test, expect } from './fixtures.js';

interface StubControl {
  __sbForceFail: boolean;
  __sbLastWs: WebSocket | null;
  __sbWsCount: number;
}

test('reconnect backoff: "Try now" prompt appears after 5 failures and resets on click', async ({
  session,
  page,
  browser,
}) => {
  // Default backoff with mid-jitter: 1+2+4+8+16 ≈ 31s. Worst-case jitter
  // (max factor 1.3) pushes the sum to ~40s. 90s wallclock is generous.
  test.setTimeout(120_000);

  // Step 1: Install the stub before any page script runs. The stub starts
  // in passthrough mode so the join handshake completes normally.
  await page.addInitScript(() => {
    const Real = WebSocket;
    const ww = window as unknown as StubControl;
    ww.__sbForceFail = false;
    ww.__sbLastWs = null;
    ww.__sbWsCount = 0;
    function StubWS(
      this: WebSocket,
      ...args: ConstructorParameters<typeof WebSocket>
    ): WebSocket {
      const ws = new Real(...args);
      ww.__sbLastWs = ws;
      ww.__sbWsCount += 1;
      if (ww.__sbForceFail) {
        const forceClose = (): void => {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        };
        ws.addEventListener('open', forceClose, { capture: true });
        ws.addEventListener('error', forceClose, { capture: true });
      }
      return ws;
    }
    StubWS.prototype = Real.prototype;
    Object.setPrototypeOf(StubWS, Real);
    (window as unknown as { WebSocket: typeof WebSocket }).WebSocket =
      StubWS as unknown as typeof WebSocket;
  });

  // Step 2: Participant joins via the Join form (v2.0.0: "Continue" button, no join code).
  await page.goto(session.public_url);
  await expect(page.getByLabel(/display name/i)).toBeVisible();
  await page.getByLabel(/display name/i).fill('Alice');
  await page.getByRole('button', { name: /^continue$/i }).click();

  // Participant is pending — waiting screen visible, WS is already live.
  await expect(page.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });

  // Step 3: Coordinator opens their URL and approves Alice.
  const coordinatorCtx = await browser.newContext();
  const coordinator = await coordinatorCtx.newPage();
  try {
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    await expect(
      coordinator.getByRole('button', { name: /approve alice/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordinator.getByRole('button', { name: /approve alice/i }).click();
  } finally {
    await coordinatorCtx.close();
  }

  // Step 4: Participant is approved — waiting screen transitions to session view.
  await expect(page.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });
  // join-empty-cta confirms the participant is in the session and the WS welcome was received.
  await expect(page.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 });

  // Step 5: Flip force-fail then close the live WS to enter the backoff
  // loop. From here every new WS that the SPA opens will be immediately
  // closed by the stub's open-listener.
  await page.evaluate(() => {
    const ww = window as unknown as StubControl;
    ww.__sbForceFail = true;
    if (ww.__sbLastWs) {
      try {
        ww.__sbLastWs.close();
      } catch {
        /* already closed */
      }
    }
  });

  // Step 6: After 5 close-without-welcome cycles the prompt renders. With
  // mid-jitter backoff the sum is ~31s; worst-case jitter is ~40s.
  await expect(page.getByText(/Having trouble reconnecting/i)).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole('button', { name: /try now/i })).toBeVisible();

  // Sanity: the stub recorded at least 6 WS creations (1 for the
  // successful join + 5 for the failure chain).
  const wsCount = await page.evaluate(
    () => (window as unknown as { __sbWsCount: number }).__sbWsCount,
  );
  expect(wsCount).toBeGreaterThanOrEqual(6);

  // Step 7: Click "Try now". wsRetryCount resets to 0; the prompt hides
  // immediately. (The stub keeps force-failing so eventually it would
  // reappear after another 5 cycles — assert the immediate hide.)
  await page.getByRole('button', { name: /try now/i }).click();
  await expect(page.getByText(/Having trouble reconnecting/i)).toBeHidden({
    timeout: 2_000,
  });
});
