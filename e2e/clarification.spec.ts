/**
 * Phase 7 (CHATAI-01/CHATAI-02): Clarification round-trip e2e tests.
 *
 * Test 1: participant asks a clarifying question, AI answers, reply appears.
 * Test 2: CHATAI-02 — clarification never appears as a radio option in coordinator pick.
 */
import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, answerClarification } from '../packages/server/src/mcp/tools.js';
import { joinAndApprove } from './helpers.js';

test('clarification round-trip: participant asks, AI answers, reply appears', async ({
  session,
  browser,
}) => {
  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const page = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    await joinAndApprove(page, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // Ask a question in-process
    const ticket = askGroup({ question: 'Pick a logging approach' }) as { ticket_id: string };
    const questionId = await page
      .locator('[data-testid^="clarify-thread-"]')
      .first()
      .getAttribute('data-testid')
      .then((attr) => attr?.replace('clarify-thread-', '') ?? '');

    // Wait for clarify-thread to appear
    await expect(
      page.getByTestId(`clarify-thread-${questionId}`),
    ).toBeVisible({ timeout: 8_000 });

    // Participant types a clarification
    await page.getByTestId(`clarify-input-${questionId}`).fill('What about structured logging?');
    await page.getByTestId(`clarify-submit-${questionId}`).click();

    // awaitAnswer should surface the clarification
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 8 });
    expect(snap.clarifications).toHaveLength(1);
    expect(snap.clarifications[0]!.text).toBe('What about structured logging?');
    expect(snap.clarifications[0]!.answer).toBeUndefined();

    const clId = snap.clarifications[0]!.clarification_id;

    // Pending indicator visible
    await expect(
      page.getByTestId(`clarify-pending-${clId}`),
    ).toBeVisible({ timeout: 5_000 });

    // AI answers
    answerClarification({
      ticket_id: ticket.ticket_id,
      clarification_id: clId,
      text: 'Use structured logging (JSON lines)',
    });

    // Pending indicator disappears
    await expect(
      page.getByTestId(`clarify-pending-${clId}`),
    ).toBeHidden({ timeout: 5_000 });

    // Answer text appears
    await expect(
      page.getByText('Use structured logging (JSON lines)'),
    ).toBeVisible({ timeout: 5_000 });

    // AI label visible
    await expect(page.getByText(/AI:/)).toBeVisible({ timeout: 3_000 });
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }
});

test('CHATAI-02: clarification never appears as a radio option in coordinator pick set', async ({
  session,
  browser,
}) => {
  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const page = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    await joinAndApprove(page, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Bob',
    });

    // Ask a question with options
    const ticket = askGroup({
      question: 'Which logging library?',
      options: [{ label: 'Winston' }, { label: 'Pino' }],
    }) as { ticket_id: string };

    // Wait for the question to appear on the participant side
    await expect(page.getByText('Which logging library?')).toBeVisible({ timeout: 8_000 });

    const questionId = await page
      .locator('[data-testid^="clarify-thread-"]')
      .first()
      .getAttribute('data-testid')
      .then((attr) => attr?.replace('clarify-thread-', '') ?? '');

    // Participant posts a clarification
    await page.getByTestId(`clarify-input-${questionId}`).fill('Does Pino support async logs?');
    await page.getByTestId(`clarify-submit-${questionId}`).click();

    // Wait for clarification to appear on coordinator side
    await expect(
      coordinator.getByTestId(`clarify-thread-${questionId}`),
    ).toBeVisible({ timeout: 8_000 });

    // CHATAI-02: no radio button inside the clarify-thread on the coordinator side
    const radioInsideThread = coordinator
      .getByTestId(`clarify-thread-${questionId}`)
      .locator('input[type="radio"]');
    await expect(radioInsideThread).toHaveCount(0);

    // The read-only note is visible
    await expect(coordinator.getByTestId('clarify-readonly-note')).toBeVisible();

    // Suggestions radio group is still separate (the two option labels are there as radios)
    await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 5 });
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }
});
