// COORD-01 + COORD-03 (suggestion path), proven end-to-end through a real
// browser. Two contexts in one test (workers:1 is mandatory — see
// e2e/playwright.config.ts): a participant tab joins via the Join form, and a
// coordinator tab opens `?role=coordinator&token=X` and reaches the coordinator
// page WITHOUT ever touching the Join form. The participant's suggestion shows
// up live in the coordinator view; clicking "Record this" resolves the question
// and unblocks the in-process awaitAnswer long-poll — the same contract the CLI
// path satisfies. Both tabs then observe the resolved state.

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';

test('coordinator flow: participant suggestion → Record this → awaitAnswer unblocks + both tabs resolved', async ({
  session,
  browser,
}) => {
  test.setTimeout(30_000);

  // (a) Two independent contexts: one participant, one coordinator.
  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // (b) Coordinator opens the coordinator_url first so they can approve the
    // participant. It must reach the coordinator page directly — NO Join form.
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });
    await expect(coordinator.getByLabel(/join code/i)).toHaveCount(0);

    // (c) Participant joins via the Join form (v2.0.0 approval-gate model).
    await participant.goto(session.public_url);
    await expect(participant.getByLabel(/display name/i)).toBeVisible();
    await participant.getByLabel(/display name/i).fill('Alice');
    // v2.0.0: button is "Continue", not "Join session"
    await participant.getByRole('button', { name: /^continue$/i }).click();

    // (d) Participant is pending — must see the waiting-for-approval screen.
    await expect(participant.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });
    await expect(participant.getByText(/waiting for approval/i)).toBeVisible();

    // (e) Coordinator sees Alice in the pending roster; click Approve.
    await expect(
      coordinator.getByRole('button', { name: /approve alice/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordinator.getByRole('button', { name: /approve alice/i }).click();

    // (f) Participant's waiting screen transitions away (approval received via WS).
    await expect(participant.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });

    // (g) Participant now sees the JOIN-06 empty-state CTA (no question posted yet).
    await expect(participant.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 });
    await expect(participant.getByText(/you're in!/i)).toBeVisible();

    // (h) Ask a question in-process; capture the ticket_id for the testid.
    const ticket = askGroup({ question: 'Where should we store refresh tokens?' });

    // (i) The question card lands on the coordinator tab.
    const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText(/Where should we store refresh tokens/)).toBeVisible();

    // (j) Participant submits a suggestion (free-text, no options).
    await expect(participant.getByText(/Where should we store refresh tokens/)).toBeVisible({
      timeout: 10_000,
    });
    await participant.getByPlaceholder('Your answer').fill('Keychain');
    await participant.getByRole('button', { name: /submit/i }).click();

    // (k) The suggestion appears live inside the coordinator's question card,
    // carrying Alice's name + value (radiogroup row). Match by text content so
    // we don't need the server-side participant_id.
    const suggestion = card.getByText(/Keychain/);
    await expect(suggestion).toBeVisible({ timeout: 10_000 });

    // (l) Select the suggestion radio, then click "Record this".
    await card.getByRole('radio').first().check();
    await coordinator.getByTestId('coordinator-record-suggestion').click();

    // (m) The browser-driven pick unblocks the in-process awaitAnswer long-poll
    // (resolved:true) — the COORD-01/03 end-to-end proof that the coordinator
    // tab drives the same long-poll the CLI path satisfies.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 10 });
    expect(snap.resolved).toBe(true);
    // The recorded value lives in the session decisions — assert the suggestion
    // value round-tripped through the browser-driven Record this.
    const decisions = mcpState.manager!.sessionView().decisions;
    expect(decisions.some((d) => d.answer === 'Keychain')).toBe(true);

    // (n) The participant tab sees the question resolve (Decisions card shows the
    // recorded answer; the active question is gone).
    await expect(participant.getByText('Keychain').last()).toBeVisible({ timeout: 10_000 });

    // (o) The coordinator card flips to resolved (resolved marker appears).
    await expect(card.getByTestId('coordinator-resolved-marker')).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block owns teardown.
});
