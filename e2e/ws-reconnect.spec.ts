import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';
import { joinAndApprove } from './helpers.js';

test('ws reconnect: replay restores state via hello/welcome', async ({ session, browser }) => {
  // Use a generous timeout because we have two WS connect/disconnect cycles.
  test.setTimeout(40_000);

  // Step (a): Create participant + coordinator contexts for the approval-gate join.
  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const page = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Join and get approved (v2.0.0 approval-gate model). After this the participant
    // is on the approved session view and the WS is live with a welcome received.
    await joinAndApprove(page, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // The coordinator tab is no longer needed — close it to free resources.
    await coordinatorCtx.close();

    // Step (b): The `welcome` frame already arrived (joinAndApprove waited for join-empty-cta).
    // sessionStorage.lastSeq is set on the participant page when the welcome event landed.
    // Emit Q1 so the browser receives a question_broadcast event
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

    // Step (c): Trigger reconnect via page.reload(). The reload clears sessionStorage
    // (including sb.last_seq), resets the in-memory WS connection,
    // and shows the "Connecting…" state briefly before auto-resuming via the existing cookie.
    //
    // We fire askGroup for Q2 immediately after initiating the reload but while the
    // browser is still mid-navigation, so Q2 goes into the RingBuffer while the WS
    // is disconnected. The server will deliver Q2 in the `welcome` frame (or via
    // a subsequent broadcast once the WS reconnects).
    const reloadPromise = page.reload({ waitUntil: 'domcontentloaded' });

    // Step (d): Emit Q2 during reconnect window (synchronous; goes into RingBuffer).
    askGroup({ question: 'Q2: emitted during reconnect' });

    // Wait for the reload to finish loading the document.
    await reloadPromise;

    // Step (e): After reload, the participant cookie is still valid. App.tsx tries to
    // resume via WS (startWs on mount) and the server accepts because the cookie is valid.
    // However, sessionStorage is cleared on reload so getLastSeq() returns -1, meaning
    // the hello command is sent without last_seq. The server sends the full session state
    // in the `welcome` frame, so the browser will see Q2 (the current question).
    //
    // The resume is automatic — no re-join needed when the cookie is valid.
    await expect(page.getByText(/Q2: emitted during reconnect/)).toBeVisible({ timeout: 15_000 });

    // Step (f): Verify sessionStorage.lastSeq has advanced (new events received after reconnect).
    const lastSeqAfter = await page.evaluate(() => window.sessionStorage.getItem('sb.last_seq'));
    expect(Number(lastSeqAfter)).toBeGreaterThan(Number(lastSeqBefore));
  } finally {
    await participantCtx.close();
    // coordinatorCtx may already be closed (closed above after approval); close is idempotent.
    await coordinatorCtx.close().catch(() => {});
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block handles teardown.
});
