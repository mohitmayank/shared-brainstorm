// Coordinator-as-planner (quick task 260522-pah). The coordinator contributes
// their OWN answer as a suggestion in the shared pool — distinct from the
// override/finalize path — then picks it as the final answer. Three things must
// hold end-to-end in a real browser:
//   1. The coordinator's "Add your answer (as a planner)" submission appears as a
//      suggestion in the pool, attributed to "Coordinator" on the coordinator card.
//   2. An approved PARTICIPANT sees that same suggestion in their browser,
//      attributed to "Coordinator" (visible + attributed requirement).
//   3. Selecting + recording the coordinator's own suggestion resolves the
//      in-process awaitAnswer long-poll and records the value as the decision.

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';
import { joinAndApprove } from './helpers.js';

const PLANNER_ANSWER = 'Use Postgres with Litestream replication';

test('coordinator-as-planner: own answer joins the pool, is attributed to participants, and can be recorded', async ({
  session,
  browser,
}) => {
  test.setTimeout(30_000);

  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Participant joins and gets approved (v2.0.0 approval-gate model).
    await joinAndApprove(participant, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // Ask a question in-process; the coordinator card appears.
    const ticket = askGroup({ question: 'Which datastore should we use?' }) as {
      ticket_id: string;
    };
    const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // (1) Coordinator contributes their own answer via the planner add-answer box
    // (NOT the override textarea — this is a pool contribution, not a finalize).
    await coordinator.getByTestId('coordinator-add-answer-textarea').fill(PLANNER_ANSWER);
    await coordinator.getByTestId('coordinator-add-answer-submit').click();

    // The coordinator's own suggestion shows up on their card attributed "Coordinator".
    const coordRow = card.getByTestId('coordinator-suggestion-coordinator-0');
    await expect(coordRow).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText('Coordinator', { exact: false })).toBeVisible();
    await expect(card.getByText(PLANNER_ANSWER)).toBeVisible();

    // (2) The participant (Alice) sees the coordinator's suggestion attributed
    // to "Coordinator" in their own browser — visible + attributed.
    await expect(participant.getByText('Other suggestions')).toBeVisible({ timeout: 10_000 });
    const aliceSuggestions = participant.locator('ul.suggestions');
    await expect(aliceSuggestions.getByText('Coordinator', { exact: false })).toBeVisible();
    await expect(aliceSuggestions.getByText(PLANNER_ANSWER)).toBeVisible();

    // (3) Coordinator selects their own suggestion and records it as final.
    await coordRow.click();
    await coordinator.getByTestId('coordinator-record-suggestion').click();

    // The pick unblocks the in-process long-poll and records the decision.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 10 });
    expect(snap.resolved).toBe(true);

    const decisions = mcpState.manager!.sessionView().decisions;
    expect(decisions.some((d) => d.answer === PLANNER_ANSWER)).toBe(true);

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
