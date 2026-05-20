// REL-04 / D-19: exercise the exponential WS reconnect backoff + the
// "Having trouble reconnecting — Try now" advisory that appears after 5
// consecutive close-without-welcome cycles.
//
// Strategy:
//   1. Install a WebSocket constructor stub via `addInitScript`. The stub
//      tracks every WS created and exposes a __sbForceFail flag (initially
//      false — passthrough). The stub also stashes the active WS handle on
//      window so the spec can close it on demand.
//   2. Join the session normally. The SPA reaches `hasSession=true` and
//      wsRetryCount stays at 0.
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

  // Step 2: Normal join — real welcome arrives, wsRetryCount=0.
  await page.goto(session.public_url);
  await expect(page.getByLabel(/display name/i)).toBeVisible();
  await page.getByLabel(/display name/i).fill('Alice');
  // No join code in v2.0.0 — approval-gate model.
  await page.getByRole('button', { name: /join session/i }).click();
  await expect(page.getByText(/waiting for a question from the ai host/i)).toBeVisible({
    timeout: 10_000,
  });

  // Step 3: Flip force-fail then close the live WS to enter the backoff
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

  // Step 4: After 5 close-without-welcome cycles the prompt renders. With
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

  // Step 5: Click "Try now". wsRetryCount resets to 0; the prompt hides
  // immediately. (The stub keeps force-failing so eventually it would
  // reappear after another 5 cycles — assert the immediate hide.)
  await page.getByRole('button', { name: /try now/i }).click();
  await expect(page.getByText(/Having trouble reconnecting/i)).toBeHidden({
    timeout: 2_000,
  });
});
