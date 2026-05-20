// COORD-04 regression: a full brainstorm must still complete via the CLI/MCP
// path WITHOUT ever opening the coordinator tab. Phase 3 added the coordinator
// surface as a *peer* of the CLI, not a replacement — the terminal-only flow
// (askGroup → awaitAnswer → recordAnswer through the unchanged MCP tools) must
// keep resolving questions exactly as before.
//
// This spec deliberately:
//   - uses ONLY a participant browser tab (the share-link join flow), and
//   - never navigates to session.coordinator_url, and
//   - never sets or references the sb_c coordinator cookie.
// The coordinator surface is simply never touched. If a future change couples
// the CLI resolution path to the coordinator UI, this spec fails.

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer, recordAnswer } from '../packages/server/src/mcp/tools.js';

test('CLI-only regression: full brainstorm resolves via MCP recordAnswer, no coordinator tab (COORD-04)', async ({
  session,
  browser,
}) => {
  test.setTimeout(30_000);

  const participantCtx = await browser.newContext();
  const participant = await participantCtx.newPage();

  try {
    // Participant joins via the Join form — the only browser surface this spec
    // touches. (coordinator_url is intentionally NOT referenced anywhere below.)
    await participant.goto(session.public_url);
    await expect(participant.getByLabel(/display name/i)).toBeVisible();
    await participant.getByLabel(/display name/i).fill('Alice');
    // No join code in v2.0.0 — approval-gate model.
    await participant.getByRole('button', { name: /join session/i }).click();
    await expect(
      participant.getByText(/waiting for a question from the ai host/i),
    ).toBeVisible({ timeout: 10_000 });

    // CLI path: ask the question in-process.
    const ticket = askGroup({ question: 'Which migration tool?' });
    await expect(participant.getByText(/Which migration tool/)).toBeVisible({ timeout: 10_000 });

    // Participant submits a suggestion.
    await participant.getByPlaceholder('Your answer').fill('Use Flyway');
    await participant.getByRole('button', { name: /submit/i }).click();

    // awaitAnswer returns the snapshot containing that suggestion.
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 10 });
    expect(snap.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ participant_name: 'Alice', value: 'Use Flyway' }),
      ]),
    );

    // The AI host resolves the question through the unchanged MCP recordAnswer
    // tool — the terminal-only path, no coordinator browser involved.
    const out = recordAnswer({
      ticket_id: ticket.ticket_id,
      value: 'Use Flyway',
      source: 'suggestion',
    });
    expect(out.ok).toBe(true);

    // The participant tab reflects the resolved decision.
    await expect(participant.getByText('Use Flyway').last()).toBeVisible({ timeout: 10_000 });
  } finally {
    await participantCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block owns teardown.
});
