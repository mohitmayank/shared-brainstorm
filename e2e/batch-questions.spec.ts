// BATCH-02 + BATCH-04 end-to-end: multi-question concurrent rendering,
// out-of-order answer/resolve, and single-question regression guard.
//
// Spec 1: single-question askGroup path is byte-identical (regression guard)
// Spec 2: batch two questions — participant answers Q2 before Q1;
//         coordinator resolves Q2 first; Q1 remains answerable throughout.

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';
import { joinAndApprove } from './helpers.js';

test('single-question askGroup path is byte-identical (regression guard)', async ({
  session,
  browser,
}) => {
  test.setTimeout(30_000);

  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Join and approve participant
    await joinAndApprove(participant, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // Single-question askGroup call
    const result = askGroup({ question: 'Single question: which DB?' }) as { ticket_id: string };

    // Verify result has ticket_id (string) and no 'tickets' field
    expect(typeof result.ticket_id).toBe('string');
    expect(result.ticket_id.length).toBeGreaterThan(0);
    expect('tickets' in result).toBe(false);

    // Wait for question card to appear on participant side
    await expect(participant.getByText(/Single question: which DB/)).toBeVisible({
      timeout: 10_000,
    });

    // batch-question-list wrapper always renders (contains the cards)
    await expect(participant.getByTestId('batch-question-list')).toBeAttached();

    // Single question — batch-hint MUST NOT be shown
    await expect(participant.getByTestId('batch-hint')).not.toBeAttached();

    // Coordinator side: single card, no batch-hint
    const card = coordinator.getByTestId(`coordinator-question-${result.ticket_id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(coordinator.getByTestId('batch-hint')).not.toBeAttached();
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }
});

test('batch two questions: participant answers Q2 before Q1; coordinator resolves Q2 first', async ({
  session,
  browser,
}) => {
  test.setTimeout(60_000);

  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Join and approve participant
    await joinAndApprove(participant, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // Batch askGroup with two questions
    const batchResult = askGroup({
      questions: [
        { question: 'What is Q1?' },
        { question: 'What is Q2?' },
      ],
    }) as { tickets: { question_id: string; ticket_id: string }[] };

    // Verify batch output shape
    expect(batchResult.tickets).toHaveLength(2);
    const q1ticket = batchResult.tickets[0]!;
    const q2ticket = batchResult.tickets[1]!;
    expect(typeof q1ticket.question_id).toBe('string');
    expect(typeof q1ticket.ticket_id).toBe('string');
    expect(typeof q2ticket.question_id).toBe('string');
    expect(typeof q2ticket.ticket_id).toBe('string');

    // Participant sees two question cards with batch-hint
    await expect(participant.getByTestId('batch-question-list')).toBeAttached({ timeout: 10_000 });
    await expect(participant.getByText(/What is Q1/)).toBeVisible({ timeout: 10_000 });
    await expect(participant.getByText(/What is Q2/)).toBeVisible({ timeout: 10_000 });
    await expect(participant.getByTestId('batch-hint')).toBeAttached({ timeout: 10_000 });
    await expect(participant.getByTestId('batch-hint')).toContainText(
      'Answer any of these in any order',
    );

    // Coordinator sees both cards with batch-hint
    await expect(
      coordinator.getByTestId(`coordinator-question-${q1ticket.ticket_id}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      coordinator.getByTestId(`coordinator-question-${q2ticket.ticket_id}`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(coordinator.getByTestId('batch-hint')).toBeAttached();
    await expect(coordinator.getByTestId('batch-hint')).toContainText(
      'Resolve each question independently',
    );

    // Participant submits answer to Q2 first (not Q1)
    // Find the Q2 card by locating the text "What is Q2?" and then getting the input within it
    const q2Card = participant.locator('.card', { hasText: 'What is Q2?' });
    await q2Card.getByPlaceholder('Your answer').fill('Answer for Q2');
    await q2Card.getByRole('button', { name: /submit/i }).click();

    // Q2 suggestion appears in coordinator's Q2 card
    const coordinatorQ2Card = coordinator.getByTestId(
      `coordinator-question-${q2ticket.ticket_id}`,
    );
    await expect(coordinatorQ2Card.getByText(/Answer for Q2/)).toBeVisible({ timeout: 10_000 });

    // Coordinator resolves Q2 (out of order — Q1 still open)
    await coordinatorQ2Card.getByRole('radio').first().check();
    await coordinatorQ2Card.getByTestId('coordinator-record-suggestion').click();

    // Q2 resolves: decision appears in the Decisions panel (question_resolved removes
    // Q2 from questions[] and adds it to decisions[]; the card folds into decisions)
    await expect(coordinator.getByText(/Answer for Q2/)).toBeVisible({ timeout: 10_000 });

    // Q1 card is still present and still has its submit form (unaffected by Q2 resolution)
    const coordinatorQ1Card = coordinator.getByTestId(
      `coordinator-question-${q1ticket.ticket_id}`,
    );
    await expect(coordinatorQ1Card).toBeVisible({ timeout: 10_000 });
    await expect(coordinatorQ1Card.getByTestId('coordinator-record-suggestion')).toBeVisible();

    // Participant's Q1 card is still open — submit form still present
    const participantQ1Card = participant.locator('.card', { hasText: 'What is Q1?' });
    await expect(participantQ1Card.getByPlaceholder('Your answer')).toBeVisible({ timeout: 10_000 });

    // Session status stays 'question_open' while Q1 is still open
    // (awaitAnswer for Q2 should resolve; awaitAnswer for Q1 still pending)
    const q2snap = await awaitAnswer({ ticket_id: q2ticket.ticket_id, timeout_s: 5 });
    expect(q2snap.resolved).toBe(true);

    // Verify Q2 decision is in the session view
    const decisionsAfterQ2 = mcpState.manager!.sessionView().decisions;
    expect(decisionsAfterQ2.some((d) => d.answer === 'Answer for Q2')).toBe(true);

    // Now participant submits answer for Q1
    await participantQ1Card.getByPlaceholder('Your answer').fill('Answer for Q1');
    await participantQ1Card.getByRole('button', { name: /submit/i }).click();

    // Q1 suggestion appears in coordinator's Q1 card
    await expect(coordinatorQ1Card.getByText(/Answer for Q1/)).toBeVisible({ timeout: 10_000 });

    // Coordinator resolves Q1
    await coordinatorQ1Card.getByRole('radio').first().check();
    await coordinatorQ1Card.getByTestId('coordinator-record-suggestion').click();

    // Q1 resolves: decision appears in the Decisions panel
    await expect(coordinator.getByText(/Answer for Q1/)).toBeVisible({ timeout: 10_000 });

    // awaitAnswer for Q1 resolves
    const q1snap = await awaitAnswer({ ticket_id: q1ticket.ticket_id, timeout_s: 10 });
    expect(q1snap.resolved).toBe(true);

    // Both decisions in the session
    const finalDecisions = mcpState.manager!.sessionView().decisions;
    expect(finalDecisions.some((d) => d.answer === 'Answer for Q1')).toBe(true);
    expect(finalDecisions.some((d) => d.answer === 'Answer for Q2')).toBe(true);

    // No more open questions remain
    const finalView = mcpState.manager!.sessionView();
    expect(finalView.questions).toHaveLength(0);
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }
});
