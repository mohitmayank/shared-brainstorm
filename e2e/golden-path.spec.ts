import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';

test('golden path: 1 participant joins, suggests, AI records', async ({ session, page }) => {
  // Step 1: Session is already started by the `session` fixture (in-process LAN transport).

  // Step 2: Navigate to the SPA.
  await page.goto(session.public_url);

  // Step 3: Wait for the Join form.
  await expect(page.getByLabel(/display name/i)).toBeVisible();

  // Fill display name and submit (no join code in v2.0.0 — approval-gate model).
  await page.getByLabel(/display name/i).fill('Alice');
  await page.getByRole('button', { name: /join session/i }).click();

  // Step 4: Wait for the in-session view to render (the "waiting" state message).
  await expect(
    page.getByText(/waiting for a question from the ai host/i),
  ).toBeVisible({ timeout: 8_000 });

  // Step 5: Ask a question in-process.
  const ticket = askGroup({ question: 'Where should we store refresh tokens?' });

  // Step 6: Wait for the question to appear in the browser.
  await expect(page.getByText(/Where should we store refresh tokens/)).toBeVisible({
    timeout: 8_000,
  });

  // Step 7: Fill the suggestion input (free-text, no pre-defined options) and submit.
  // The QuestionCard renders a plain text input with placeholder="Your answer" when no options.
  await page.getByPlaceholder('Your answer').fill('Keychain');
  await page.getByRole('button', { name: /submit/i }).click();

  // Step 8: awaitAnswer in-process — should resolve with Alice's suggestion.
  const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 8 });
  expect(snap.suggestions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ participant_name: 'Alice', value: 'Keychain' }),
    ]),
  );

  // Step 9: Record the answer in-process.
  const out = recordAnswer({ ticket_id: ticket.ticket_id, value: 'Keychain', source: 'suggestion' });
  expect(out.ok).toBe(true);

  // Step 10 (optional): Assert the browser DOM reflects the recorded answer.
  // Session.tsx renders a Decisions card with "question → answer" after recordAnswer.
  // The strong text "Keychain" appears as the decision value.
  await expect(page.getByText('Keychain').last()).toBeVisible({ timeout: 8_000 });

  // NOTE: Do NOT call stopSession() — the fixture's finally block handles teardown.
});
