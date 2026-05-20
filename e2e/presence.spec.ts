// Phase 5 (PRES-01, PRES-03): session-status pill + AI-side copy indicators.
//
// PRES-01: every participant sees a status pill driven by server session_status.
// PRES-03: "AI is thinking…" empty-state when waiting; "Coordinator is picking"
//          caption for participants when status is 'choosing'.
//
// PRES-02 activity assertions (typing indicator) are stubbed as test.todo() —
// the 'typing' ClientCommand and server-side handler are wired in Plan 03.

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
      const ticket = askGroup({ question: 'Which approach?' });

      // Wait for the question card to arrive on the coordinator
      const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
      await expect(card).toBeVisible({ timeout: 10_000 });

      // Participant submits a suggestion so a record action is possible
      await expect(participant.getByText(/Which approach/)).toBeVisible({ timeout: 10_000 });
      await participant.getByPlaceholder('Your answer').fill('Option A');
      await participant.getByRole('button', { name: /submit/i }).click();

      // Coordinator selects the suggestion radio and clicks "Record this"
      // This triggers onPicking('start') → sends 'picking' WS command
      await card.getByRole('radio').first().check();
      await coordinator.getByTestId('coordinator-record-suggestion').click();

      // Participant sees the "Coordinator is picking" caption
      const pickingCaption = participant.getByTestId('presence-coordinator-picking');
      await expect(pickingCaption).toBeVisible({ timeout: 10_000 });
      await expect(pickingCaption).toContainText('Coordinator is picking the final answer');
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

  // PRES-02: typing indicator — wired in Plan 03 when the 'typing' ClientCommand
  // and server-side ephemeral presence handler are added.
  test.skip('PRES-02 activity line shows when participant typing', () => {
    // Stub: implement in Plan 03 after 'typing' ClientCommand and server-side
    // ephemeral presence handler are wired. The 'typing' WS command, ws.ts case,
    // and applyEphemeralFrame 'presence' branch are not yet in the codebase.
  });
});
