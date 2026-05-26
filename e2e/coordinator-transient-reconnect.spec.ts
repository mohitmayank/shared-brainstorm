// RESIL-02 SC2: coordinator transient WS drop resilience.
//
// Proves that the coordinator auto-reconnects (no manual reload) after a
// transient WebSocket drop and can still pick/approve after the reconnect:
//   - The question is visible before and after the WS drop.
//   - The SPA's exponential-backoff loop (App.tsx onClose) re-establishes the WS
//     without any user interaction.
//   - After reconnect the coordinator can record an override or approve a pending
//     participant — the sb_c cookie is still valid (HttpOnly, survives in-memory).
//
// WS drop technique: mirrors reconnect-backoff.spec.ts exactly — addInitScript
// installs a StubWS that starts in passthrough mode; after the coordinator has a
// live session the stub is flipped to force-fail-then-recover (one-shot: fails
// exactly once then re-enables passthrough) so the coordinator auto-reconnects.
//
// Mirror pattern: reconnect-backoff.spec.ts (transient drop technique),
//                 coordinator-flow.spec.ts (coordinator setup + token).

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer } from '../packages/server/src/mcp/tools.js';

interface StubControl {
  __sbForceFail: boolean;
  __sbLastWs: WebSocket | null;
  __sbWsCount: number;
}

test('RESIL-02 SC2: coordinator transient WS drop — auto-reconnects, question visible before & after, can act immediately', async ({
  session,
  browser,
}) => {
  // Generous timeout: one real WS open/close/reopen cycle plus backoff jitter.
  test.setTimeout(60_000);

  const coordinatorCtx = await browser.newContext();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Step 1: Install the WebSocket stub BEFORE any page script runs.
    // The stub starts in passthrough mode so the coordinator join completes normally.
    await coordinator.addInitScript(() => {
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

    // Step 2: Coordinator opens the coordinator_url. The stub is in passthrough mode
    // so the WS connection succeeds and the coordinator page renders.
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Step 3: Post a question so the coordinator sees it (question card visible).
    const ticket = askGroup({ question: 'Which auth strategy should we use?' }) as {
      ticket_id: string;
    };
    const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(/Which auth strategy should we use/)).toBeVisible();

    // Confirm the stub recorded at least 1 WS (the join handshake).
    const wsCountBefore = await coordinator.evaluate(
      () => (window as unknown as { __sbWsCount: number }).__sbWsCount,
    );
    expect(wsCountBefore).toBeGreaterThanOrEqual(1);

    // Step 4: Trigger a TRANSIENT drop — flip force-fail ON, close the live WS.
    // The SPA's onClose fires; it schedules a new WS via the backoff timer. That
    // new WS hits the stub which force-closes it ONCE. We flip force-fail back OFF
    // after a short delay so the next attempt succeeds (one-shot transient drop).
    await coordinator.evaluate(() => {
      const ww = window as unknown as StubControl;
      ww.__sbForceFail = true;
      if (ww.__sbLastWs) {
        try {
          ww.__sbLastWs.close();
        } catch {
          /* already closed */
        }
      }
      // Re-enable passthrough after 800ms so the first retry fails but the
      // second reconnect attempt succeeds — simulating a genuine transient blip.
      setTimeout(() => {
        ww.__sbForceFail = false;
      }, 800);
    });

    // Step 5: The SPA must auto-reconnect WITHOUT manual reload.
    // coordinator-page must remain visible (no WS-error overlay that replaces it).
    // Wait for at least 2 WS creations (one failed + one that succeeds).
    await coordinator.waitForFunction(
      () => (window as unknown as { __sbWsCount: number }).__sbWsCount >= 2,
      { timeout: 20_000 },
    );

    // Step 5b: `__sbWsCount >= 2` only proves a 2nd socket was CREATED (which may be
    // the force-failed retry). Before acting, wait until the SPA actually has a LIVE
    // socket back — force-fail disabled AND the latest WS OPEN (readyState === 1) —
    // so the question_resolved event from the override below is received live rather
    // than racing a still-backing-off reconnect (flake under combined-run load).
    await coordinator.waitForFunction(
      () => {
        const ww = window as unknown as { __sbForceFail: boolean; __sbLastWs: WebSocket | null };
        return ww.__sbForceFail === false && ww.__sbLastWs !== null && ww.__sbLastWs.readyState === 1;
      },
      { timeout: 20_000 },
    );

    // Step 6: After auto-reconnect, question must still be visible (welcome re-primed
    // session state via ring-buffer replay or fresh welcome).
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(/Which auth strategy should we use/)).toBeVisible();

    // Step 7: Act immediately after reconnect — record an override (the HTTP call
    // carries the sb_c cookie, which survived the transient WS drop as HttpOnly).
    await card.getByTestId('coordinator-override-textarea').fill('JWT with refresh rotation');
    await coordinator.getByTestId('coordinator-record-override').click();

    // Override resolves the awaitAnswer long-poll.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 10 });
    expect(snap.resolved).toBe(true);
    expect(snap.resolution?.value).toBe('JWT with refresh rotation');

    // Coordinator card flips to resolved variant.
    await expect(card.getByTestId('coordinator-resolved-marker')).toBeAttached({
      timeout: 15_000,
    });
  } finally {
    await coordinatorCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block owns teardown.
});

test('RESIL-02 SC2b: coordinator transient drop with pending participant — can approve after reconnect', async ({
  session,
  browser,
}) => {
  test.setTimeout(60_000);

  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Step 1: Install stub on coordinator page before navigation.
    await coordinator.addInitScript(() => {
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

    // Step 2: Coordinator opens coordinator_url (passthrough).
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Step 3: Post a question.
    const ticket = askGroup({ question: 'Should we use microservices?' }) as {
      ticket_id: string;
    };
    await expect(
      coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`),
    ).toBeVisible({ timeout: 10_000 });

    // Step 4: Participant joins and lands on the waiting screen.
    await participant.goto(session.public_url);
    await expect(participant.getByLabel(/display name/i)).toBeVisible();
    await participant.getByLabel(/display name/i).fill('Carol');
    await participant.getByRole('button', { name: /^continue$/i }).click();
    await expect(participant.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });

    // Step 5: Coordinator sees Carol pending — but before approving, trigger transient drop.
    await expect(
      coordinator.getByRole('button', { name: /approve carol/i }),
    ).toBeVisible({ timeout: 10_000 });

    await coordinator.evaluate(() => {
      const ww = window as unknown as StubControl;
      ww.__sbForceFail = true;
      if (ww.__sbLastWs) {
        try {
          ww.__sbLastWs.close();
        } catch {
          /* already closed */
        }
      }
      // One-shot transient: re-enable passthrough after 800ms.
      setTimeout(() => {
        ww.__sbForceFail = false;
      }, 800);
    });

    // Wait for auto-reconnect (at least 2 WS creations).
    await coordinator.waitForFunction(
      () => (window as unknown as { __sbWsCount: number }).__sbWsCount >= 2,
      { timeout: 20_000 },
    );
    // Wait for a LIVE socket back (force-fail off + OPEN) before acting — count>=2
    // alone may be the failed retry; avoids racing a still-backing-off reconnect.
    await coordinator.waitForFunction(
      () => {
        const ww = window as unknown as { __sbForceFail: boolean; __sbLastWs: WebSocket | null };
        return ww.__sbForceFail === false && ww.__sbLastWs !== null && ww.__sbLastWs.readyState === 1;
      },
      { timeout: 20_000 },
    );

    // Step 6: Coordinator page still visible after reconnect.
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Step 7: Carol still shows in the pending roster (welcome re-primed participants).
    await expect(
      coordinator.getByRole('button', { name: /approve carol/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Step 8: Approve Carol — the HTTP call succeeds (sb_c cookie intact).
    await coordinator.getByRole('button', { name: /approve carol/i }).click();
    await expect(participant.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });
    // After approval with a question already open, the participant sees the question card
    // (not join-empty-cta which only shows when there are no active questions).
    // Assert the participant can see the question text — confirming the approval worked
    // and the session state was delivered correctly.
    await expect(participant.getByText(/Should we use microservices/)).toBeVisible({
      timeout: 10_000,
    });

    // Drain the ticket so the fixture can clean up cleanly.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 2 }).catch(
      () => ({ resolved: false }),
    );
    void snap; // result not asserted — just draining for cleanup
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }
});
