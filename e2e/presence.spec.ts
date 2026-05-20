// Phase 5 (PRES-01, PRES-03): session-status pill + AI-side copy indicators.
//
// PRES-01: every participant sees a status pill driven by server session_status.
// PRES-03: "AI is thinking…" empty-state when waiting; "Coordinator is picking"
//          caption for participants when status is 'choosing'.
//
// PRES-02 activity assertions (typing indicator + "submitted a suggestion") are
// real end-to-end assertions, wired in Plan 03 (the 'typing' ClientCommand and
// server-side handler), exercised across two participant browser contexts below.

import { test, expect } from './fixtures.js';
import { askGroup, stopSession } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';
import { joinAndApprove } from './helpers.js';

test.describe('presence indicators', () => {
  test("PRES-01 status pill shows 'Waiting for the AI host' on join", async ({
    session,
    browser,
  }) => {
    test.setTimeout(30_000);

    const participantCtx = await browser.newContext();
    const coordinatorCtx = await browser.newContext();
    const participant = await participantCtx.newPage();
    const coordinator = await coordinatorCtx.newPage();

    try {
      await joinAndApprove(participant, coordinator, {
        publicUrl: session.public_url,
        coordinatorUrl: session.coordinator_url,
        displayName: 'Alice',
      });

      // Participant is now approved — status pill must show the 'waiting' state
      const pill = participant.getByTestId('session-status');
      await expect(pill).toBeVisible({ timeout: 10_000 });
      await expect(pill).toHaveAttribute('data-status', 'waiting');
      await expect(pill).toContainText('Waiting for the AI host');
    } finally {
      await participantCtx.close();
      await coordinatorCtx.close();
    }
  });

  test("PRES-01 status pill shows 'Session ended' after session_ended", async ({
    session,
    browser,
  }) => {
    test.setTimeout(30_000);

    const participantCtx = await browser.newContext();
    const coordinatorCtx = await browser.newContext();
    const participant = await participantCtx.newPage();
    const coordinator = await coordinatorCtx.newPage();

    try {
      await joinAndApprove(participant, coordinator, {
        publicUrl: session.public_url,
        coordinatorUrl: session.coordinator_url,
        displayName: 'Bob',
      });

      // Stop the session — this emits session_ended + setSessionStatus('done')
      // The fixture's finally block will also call stopSession, but calling it
      // here first lets us assert the 'done' pill state.
      await stopSession();

      const pill = participant.getByTestId('session-status');
      await expect(pill).toHaveAttribute('data-status', 'done', { timeout: 10_000 });
      await expect(pill).toContainText('Session ended');
    } finally {
      await participantCtx.close();
      await coordinatorCtx.close();
      // Fixture's finally block calls stopSession; guard against double-stop
      if (mcpState.manager) {
        await stopSession().catch(() => {});
      }
    }
  });

  test('PRES-03 AI is thinking copy visible when waiting', async ({
    session,
    browser,
  }) => {
    test.setTimeout(30_000);

    const participantCtx = await browser.newContext();
    const coordinatorCtx = await browser.newContext();
    const participant = await participantCtx.newPage();
    const coordinator = await coordinatorCtx.newPage();

    try {
      await joinAndApprove(participant, coordinator, {
        publicUrl: session.public_url,
        coordinatorUrl: session.coordinator_url,
        displayName: 'Carol',
      });

      // Empty-state (no question posted) must show the PRES-03 AI-thinking copy
      const emptyCta = participant.getByTestId('join-empty-cta');
      await expect(emptyCta).toBeVisible({ timeout: 10_000 });
      await expect(emptyCta).toContainText('AI is thinking…');
    } finally {
      await participantCtx.close();
      await coordinatorCtx.close();
    }
  });

  test('PRES-03 Coordinator is picking caption visible on participant when choosing', async ({
    session,
    browser,
  }) => {
    test.setTimeout(30_000);

    const participantCtx = await browser.newContext();
    const coordinatorCtx = await browser.newContext();
    const participant = await participantCtx.newPage();
    const coordinator = await coordinatorCtx.newPage();

    try {
      await joinAndApprove(participant, coordinator, {
        publicUrl: session.public_url,
        coordinatorUrl: session.coordinator_url,
        displayName: 'Dave',
      });

      // Post a question so there is a ticket to pick
      const ticket = askGroup({ question: 'Which approach?' }) as { ticket_id: string };

      // Wait for the question card to arrive on the coordinator
      const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
      await expect(card).toBeVisible({ timeout: 10_000 });

      // Participant submits a suggestion so a record action is possible
      await expect(participant.getByText(/Which approach/)).toBeVisible({ timeout: 10_000 });
      await participant.getByPlaceholder('Your answer').fill('Option A');
      await participant.getByRole('button', { name: /submit/i }).click();

      // Coordinator selects the suggestion radio. This triggers onPicking('start')
      // → 'picking' WS command → server sets session_status='choosing'. The "picking"
      // window is exactly between selecting a suggestion and recording it, so the
      // caption must be asserted HERE, before "Record this" resolves the question
      // (recordAnswer transitions choosing → resolved, clearing the caption).
      await card.getByRole('radio').first().check();

      // Participant sees the "Coordinator is picking" caption while status is 'choosing'
      const pickingCaption = participant.getByTestId('presence-coordinator-picking');
      await expect(pickingCaption).toBeVisible({ timeout: 10_000 });
      await expect(pickingCaption).toContainText('Coordinator is picking the final answer');

      // Recording the answer ends the picking window — the caption clears.
      await coordinator.getByTestId('coordinator-record-suggestion').click();
      await expect(pickingCaption).toBeHidden({ timeout: 10_000 });
    } finally {
      await participantCtx.close();
      await coordinatorCtx.close();
    }
  });

  test('PRES-03 Coordinator is picking caption NOT shown on coordinator page', async ({
    session,
    browser,
  }) => {
    test.setTimeout(30_000);

    const participantCtx = await browser.newContext();
    const coordinatorCtx = await browser.newContext();
    const participant = await participantCtx.newPage();
    const coordinator = await coordinatorCtx.newPage();

    try {
      await joinAndApprove(participant, coordinator, {
        publicUrl: session.public_url,
        coordinatorUrl: session.coordinator_url,
        displayName: 'Eve',
      });

      // The coordinator page must NEVER show the "Coordinator is picking" caption —
      // it is a participant-only UI element (rendered in Session.tsx, not Coordinator.tsx)
      await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });
      await expect(coordinator.getByTestId('presence-coordinator-picking')).toHaveCount(0);
    } finally {
      await participantCtx.close();
      await coordinatorCtx.close();
    }
  });

  // PRES-02: typing indicator — promoted from stub in Plan 03.
  test('PRES-02 activity line shows when participant is typing and clears on submit', async ({
    session,
    browser,
  }) => {
    test.setTimeout(30_000);

    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const coordinatorCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    const coordinator = await coordinatorCtx.newPage();

    try {
      // Step (a): Coordinator opens coordinator URL first so they can approve both participants.
      await coordinator.goto(session.coordinator_url);
      await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

      // Step (b): Both participants navigate and submit join forms.
      await Promise.all([alice.goto(session.public_url), bob.goto(session.public_url)]);
      await Promise.all([
        expect(alice.getByLabel(/display name/i)).toBeVisible(),
        expect(bob.getByLabel(/display name/i)).toBeVisible(),
      ]);
      await alice.getByLabel(/display name/i).fill('Alice');
      await alice.getByRole('button', { name: /^continue$/i }).click();
      await bob.getByLabel(/display name/i).fill('Bob');
      await bob.getByRole('button', { name: /^continue$/i }).click();

      // Step (c): Wait for both to reach the waiting screen, then approve.
      await Promise.all([
        expect(alice.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 }),
        expect(bob.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 }),
      ]);

      await expect(
        coordinator.getByRole('button', { name: /approve alice/i }),
      ).toBeVisible({ timeout: 10_000 });
      await coordinator.getByRole('button', { name: /approve alice/i }).click();

      await expect(
        coordinator.getByRole('button', { name: /approve bob/i }),
      ).toBeVisible({ timeout: 10_000 });
      await coordinator.getByRole('button', { name: /approve bob/i }).click();

      // Step (d): Wait for both to be in the session.
      await Promise.all([
        expect(alice.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 }),
        expect(bob.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 }),
      ]);

      // Step (e): Post a question so there is a suggestion input.
      const { askGroup } = await import('../packages/server/src/mcp/tools.js');
      askGroup({ question: 'Which database?' });

      // Step (f): Wait for the question to appear on both pages.
      await Promise.all([
        expect(alice.getByText(/Which database/)).toBeVisible({ timeout: 10_000 }),
        expect(bob.getByText(/Which database/)).toBeVisible({ timeout: 10_000 }),
      ]);

      // Step (g): Get Alice's participant id from the page (data-testid on presence-activity spans).
      // Alice types in the suggestion box — Bob's page should show the typing indicator.
      await alice.getByPlaceholder('Your answer').type('Po');

      // Step (h): Bob sees Alice's typing indicator.
      // We need Alice's participant id to find the correct testid on Bob's page.
      // The activity spans use data-testid="presence-activity-{participant_id}".
      // We can find the element that contains the text "is writing…" on Bob's page.
      await expect(bob.getByText(/is writing…/)).toBeVisible({ timeout: 10_000 });

      // Step (i): Alice submits a suggestion — Bob sees "submitted a suggestion".
      await alice.getByPlaceholder('Your answer').fill('Postgres');
      await alice.getByRole('button', { name: /submit/i }).click();

      await expect(bob.getByText(/submitted a suggestion/)).toBeVisible({ timeout: 10_000 });

      // Step (j): Alice does NOT see her own activity line (self-suppressed).
      // Alice's activity line span for herself should not exist (only rendered for other participants).
      // The "is writing…" text should not be on Alice's page.
      await expect(alice.getByText(/is writing…/)).toHaveCount(0);
    } finally {
      await aliceCtx.close();
      await bobCtx.close();
      await coordinatorCtx.close();
    }
  });
});
