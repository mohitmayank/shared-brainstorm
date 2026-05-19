import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';

test('ws reconnect: replay restores state via hello/welcome', async ({ session, page }) => {
  // Use a generous timeout because we have two WS connect/disconnect cycles.
  test.setTimeout(40_000);

  // Step (a): Navigate to the SPA.
  await page.goto(session.public_url);

  // Wait for the Join form (no active cookie yet on first load).
  await expect(page.getByLabel(/display name/i)).toBeVisible();
  await page.getByLabel(/display name/i).fill('Alice');
  await page.getByLabel(/join code/i).fill(session.join_code);
  await page.getByRole('button', { name: /join session/i }).click();

  // Step (b): Wait for the in-session view. The `welcome` frame sets sessionStorage.lastSeq.
  await expect(page.getByText(/waiting for a question from the ai host/i)).toBeVisible({
    timeout: 8_000,
  });

  // Step (c): Emit Q1 so that the browser receives a question_broadcast event
  // and sessionStorage.lastSeq advances past the welcome sequence number.
  const ticket1 = askGroup({ question: 'Q1: smoke check' });
  await expect(page.getByText(/Q1: smoke check/)).toBeVisible({ timeout: 8_000 });

  // Confirm sessionStorage.lastSeq is set to a positive value.
  const lastSeqBefore = await page.evaluate(() => window.sessionStorage.getItem('sb.last_seq'));
  expect(lastSeqBefore).not.toBeNull();
  expect(Number(lastSeqBefore)).toBeGreaterThan(0);

  // Resolve Q1 so we can ask Q2 later (askGroup throws BUSY if a question is in flight).
  // Q1 has no browser-submitted suggestions (the browser is just observing at this point),
  // so we resolve it via synthesis (AI-generated answer) with a short poll timeout.
  await awaitAnswer({ ticket_id: ticket1.ticket_id, timeout_s: 1 });
  recordAnswer({ ticket_id: ticket1.ticket_id, value: 'resolved-Q1', source: 'synthesis' });

  // Step (d): Trigger reconnect via page.reload(). The reload clears sessionStorage
  // (including sb.last_seq and sb.join_code), resets the in-memory WS connection,
  // and shows the "Connecting…" state briefly before auto-resuming via the existing cookie.
  //
  // We fire askGroup for Q2 immediately after initiating the reload but while the
  // browser is still mid-navigation, so Q2 goes into the RingBuffer while the WS
  // is disconnected. The server will deliver Q2 in the `welcome` frame (or via
  // a subsequent broadcast once the WS reconnects).
  const reloadPromise = page.reload({ waitUntil: 'domcontentloaded' });

  // Step (e): Emit Q2 during reconnect window (synchronous; goes into RingBuffer).
  askGroup({ question: 'Q2: emitted during reconnect' });

  // Wait for the reload to finish loading the document.
  await reloadPromise;

  // Step (f): After reload, the participant cookie is still valid. App.tsx tries to
  // resume via WS (startWs on mount) and the server accepts because the cookie is valid.
  // However, sessionStorage is cleared on reload so getLastSeq() returns -1, meaning
  // the hello command is sent without last_seq. The server sends the full session state
  // in the `welcome` frame, so the browser will see Q2 (the current question).
  //
  // The resume is automatic — no re-join needed when the cookie is valid.
  await expect(page.getByText(/Q2: emitted during reconnect/)).toBeVisible({ timeout: 15_000 });

  // Step (g): Verify sessionStorage.lastSeq has advanced (new events received after reconnect).
  const lastSeqAfter = await page.evaluate(() => window.sessionStorage.getItem('sb.last_seq'));
  expect(Number(lastSeqAfter)).toBeGreaterThan(Number(lastSeqBefore));

  // NOTE: Do NOT call stopSession() — the fixture's finally block handles teardown.
});
