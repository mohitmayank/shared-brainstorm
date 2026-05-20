import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';

test('multi-participant: two participants both submit', async ({ session, browser }) => {
  // Step (a): Create two independent browser contexts (separate cookie jars).
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  try {
    // Step (b): Both navigate to the SPA.
    await Promise.all([alice.goto(session.public_url), bob.goto(session.public_url)]);

    // Wait for both Join forms to be visible.
    await Promise.all([
      expect(alice.getByLabel(/display name/i)).toBeVisible(),
      expect(bob.getByLabel(/display name/i)).toBeVisible(),
    ]);

    // Alice fills and submits the join form (no join code in v2.0.0).
    await alice.getByLabel(/display name/i).fill('Alice');
    await alice.getByRole('button', { name: /join session/i }).click();

    // Bob fills and submits the join form.
    await bob.getByLabel(/display name/i).fill('Bob');
    await bob.getByRole('button', { name: /join session/i }).click();

    // Step (c): Wait for both to be in-session.
    await Promise.all([
      expect(alice.getByText(/waiting for a question from the ai host/i)).toBeVisible({
        timeout: 8_000,
      }),
      expect(bob.getByText(/waiting for a question from the ai host/i)).toBeVisible({
        timeout: 8_000,
      }),
    ]);

    // Step (d): Ask a question in-process (once; both participants see it).
    const ticket = askGroup({ question: 'Migrations strategy?' });

    // Step (e): Wait for the question to appear in BOTH browsers.
    await Promise.all([
      expect(alice.getByText(/Migrations strategy/)).toBeVisible({ timeout: 8_000 }),
      expect(bob.getByText(/Migrations strategy/)).toBeVisible({ timeout: 8_000 }),
    ]);

    // Step (f): Both submit different suggestions concurrently.
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

    // Step (g): Bob also submits a comment.
    await bob.getByPlaceholder('Add a comment').fill('Or maybe Atlas?');
    await bob.getByRole('button', { name: /comment/i }).click();

    // Step (h): awaitAnswer in-process — snapshot must contain both participants.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 8 });

    // Step (i): Assert both participants' suggestions appear in the snapshot.
    const names = snap.suggestions.map((s) => s.participant_name).sort();
    expect(names).toEqual(['Alice', 'Bob']);

    const values = snap.suggestions.map((s) => s.value).sort();
    expect(values).toEqual(['Use Flyway', 'Use Prisma migrate'].sort());

    // Assert Bob's comment appears.
    expect(snap.comments.some((c) => c.participant_name === 'Bob' && /Atlas/.test(c.text))).toBe(
      true,
    );

    // Step (j): Resolve the question.
    const out = recordAnswer({
      ticket_id: ticket.ticket_id,
      value: 'Use Flyway',
      source: 'suggestion',
    });
    expect(out.ok).toBe(true);
  } finally {
    // Step (k): Explicit context cleanup so Playwright doesn't warn about leaked contexts.
    await aliceCtx.close();
    await bobCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block handles teardown.
});
