import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';

test('multi-participant: two participants both submit', async ({ session, browser }) => {
  // Step (a): Create two independent participant contexts and one coordinator context.
  // The coordinator is needed to approve both Alice and Bob (v2.0.0 approval-gate model).
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // Step (b): Coordinator opens their URL first so they are ready to approve.
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Step (c): Both participants navigate to the SPA.
    await Promise.all([alice.goto(session.public_url), bob.goto(session.public_url)]);

    // Wait for both Join forms to be visible.
    await Promise.all([
      expect(alice.getByLabel(/display name/i)).toBeVisible(),
      expect(bob.getByLabel(/display name/i)).toBeVisible(),
    ]);

    // Alice fills and submits the join form. v2.0.0: button is "Continue", no join code.
    await alice.getByLabel(/display name/i).fill('Alice');
    await alice.getByRole('button', { name: /^continue$/i }).click();

    // Bob fills and submits the join form.
    await bob.getByLabel(/display name/i).fill('Bob');
    await bob.getByRole('button', { name: /^continue$/i }).click();

    // Both participants land on the waiting-for-approval screen.
    await Promise.all([
      expect(alice.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 }),
      expect(bob.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 }),
    ]);

    // Step (d): Coordinator approves Alice then Bob.
    await expect(
      coordinator.getByRole('button', { name: /approve alice/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordinator.getByRole('button', { name: /approve alice/i }).click();

    await expect(
      coordinator.getByRole('button', { name: /approve bob/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordinator.getByRole('button', { name: /approve bob/i }).click();

    // Step (e): Wait for both to be in-session (waiting screen gone, empty CTA visible).
    await Promise.all([
      expect(alice.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 }),
      expect(bob.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 }),
    ]);

    // Step (f): Ask a question in-process (once; both participants see it).
    const ticket = askGroup({ question: 'Migrations strategy?' });

    // Step (g): Wait for the question to appear in BOTH browsers.
    await Promise.all([
      expect(alice.getByText(/Migrations strategy/)).toBeVisible({ timeout: 8_000 }),
      expect(bob.getByText(/Migrations strategy/)).toBeVisible({ timeout: 8_000 }),
    ]);

    // Step (h): Both submit different suggestions concurrently.
    await Promise.all([
      (async () => {
        await alice.getByPlaceholder('Your answer').fill('Use Flyway');
        await alice.getByRole('button', { name: /submit/i }).click();
      })(),
      (async () => {
        await bob.getByPlaceholder('Your answer').fill('Use Prisma migrate');
        await bob.getByRole('button', { name: /submit/i }).click();
      })(),
    ]);

    // Step (i): Bob also submits a comment.
    await bob.getByPlaceholder('Add a comment').fill('Or maybe Atlas?');
    await bob.getByRole('button', { name: /comment/i }).click();

    // Step (j): awaitAnswer in-process — snapshot must contain both participants.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 8 });

    // Step (k): Assert both participants' suggestions appear in the snapshot.
    const names = snap.suggestions.map((s) => s.participant_name).sort();
    expect(names).toEqual(['Alice', 'Bob']);

    const values = snap.suggestions.map((s) => s.value).sort();
    expect(values).toEqual(['Use Flyway', 'Use Prisma migrate'].sort());

    // Assert Bob's comment appears.
    expect(snap.comments.some((c) => c.participant_name === 'Bob' && /Atlas/.test(c.text))).toBe(
      true,
    );

    // Step (l): Resolve the question.
    const out = recordAnswer({
      ticket_id: ticket.ticket_id,
      value: 'Use Flyway',
      source: 'suggestion',
    });
    expect(out.ok).toBe(true);
  } finally {
    // Step (m): Explicit context cleanup so Playwright doesn't warn about leaked contexts.
    await aliceCtx.close();
    await bobCtx.close();
    await coordinatorCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block handles teardown.
});
