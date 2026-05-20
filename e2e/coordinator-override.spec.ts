// COORD-03 (override path). Same two-context setup as coordinator-flow, but
// instead of picking a participant's suggestion the coordinator types their own
// answer into the override textarea and clicks "Record override". Two things
// must hold:
//   1. The browser-driven override unblocks the in-process awaitAnswer long-poll
//      (resolved:true) and the resolved marker appears on the card.
//   2. The typed value is recorded VERBATIM and UNREDACTED — the override is
//      trusted initiator input, NOT participant input, so the redact pipeline
//      (which scrubs paths/secrets out of askGroup) must NOT touch it. We embed a
//      path-like string and assert it survives intact in the session decisions.

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';
import { joinAndApprove } from './helpers.js';

// A path-like, secret-looking value that the askGroup redactor would scrub.
// The override path is trusted initiator input, so it must survive verbatim.
const OVERRIDE_ANSWER = 'Store them in /Users/foo/secret/keystore.json';

test('coordinator override: typed answer resolves the question, recorded verbatim + unredacted', async ({
  session,
  browser,
}) => {
  test.setTimeout(30_000);

  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Participant joins and gets approved via the coordinator (v2.0.0 approval-gate model).
    await joinAndApprove(participant, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // The coordinator tab is still open and ready. Ask a question in-process.
    const ticket = askGroup({ question: 'Where should we store refresh tokens?' });
    const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Type a verbatim override answer (NOT selecting any suggestion).
    await coordinator.getByTestId('coordinator-override-textarea').fill(OVERRIDE_ANSWER);
    await coordinator.getByTestId('coordinator-record-override').click();

    // The override unblocks the in-process long-poll.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 10 });
    expect(snap.resolved).toBe(true);

    // The typed override is recorded VERBATIM — the path-like string survives
    // unredacted (override is trusted initiator input, not participant input).
    const decisions = mcpState.manager!.sessionView().decisions;
    expect(decisions.some((d) => d.answer === OVERRIDE_ANSWER)).toBe(true);

    // The resolved marker appears on the coordinator card.
    await expect(card.getByTestId('coordinator-resolved-marker')).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block owns teardown.
});
