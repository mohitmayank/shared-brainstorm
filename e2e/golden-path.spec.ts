import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';
import { joinAndApprove } from './helpers.js';

test('golden path: 1 participant joins, suggests, AI records', async ({ session, browser }) => {
  // Step 1: Session is already started by the `session` fixture (in-process LAN transport).

  // Step 2: Create participant + coordinator contexts (v2.0.0 approval-gate model).
  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const page = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Step 3: Join and get approved via coordinator.
    await joinAndApprove(page, coordinator, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // Step 4: Ask a question in-process.
    const ticket = askGroup({ question: 'Where should we store refresh tokens?' });

    // Step 5: Wait for the question to appear in the browser.
    await expect(page.getByText(/Where should we store refresh tokens/)).toBeVisible({
      timeout: 8_000,
    });

    // Step 6: Fill the suggestion input (free-text, no pre-defined options) and submit.
    // The QuestionCard renders a plain text input with placeholder="Your answer" when no options.
    await page.getByPlaceholder('Your answer').fill('Keychain');
    await page.getByRole('button', { name: /submit/i }).click();

    // Step 7: awaitAnswer in-process — should resolve with Alice's suggestion.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 8 });
    expect(snap.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participant_name: 'Alice', value: 'Keychain' }),
      ]),
    );

    // Step 8: Record the answer in-process.
    const out = recordAnswer({ ticket_id: ticket.ticket_id, value: 'Keychain', source: 'suggestion' });
    expect(out.ok).toBe(true);

    // Step 9 (optional): Assert the browser DOM reflects the recorded answer.
    // Session.tsx renders a Decisions card with "question → answer" after recordAnswer.
    // The strong text "Keychain" appears as the decision value.
    await expect(page.getByText('Keychain').last()).toBeVisible({ timeout: 8_000 });
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block handles teardown.
});
