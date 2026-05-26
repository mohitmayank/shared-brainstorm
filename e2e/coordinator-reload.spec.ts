// RESIL-02 SC1: coordinator full-tab reload resilience.
//
// Proves that the coordinator can close and reopen their tab (full page.reload())
// and cleanly resume control of the live session WITHOUT a server restart:
//   - The coordinator_url + sb_c cookie survive the reload.
//   - The SPA re-reads ?role=coordinator&token=X, re-POSTs /api/coordinator/join,
//     and the WS upgrade re-derives is_coordinator from the cookie.
//   - The `welcome` frame re-primes full session state (open question, participant
//     roster, decisions).
//   - The coordinator can IMMEDIATELY act after reload (override → resolves,
//     participant approval) — no manual intervention.
//
// Mirror pattern: coordinator-flow.spec.ts (coordinator setup + token),
//                 ws-reconnect.spec.ts (reload + state restore).

import { test, expect } from './fixtures.js';
import { askGroup, awaitAnswer } from '../packages/server/src/mcp/tools.js';
import { mcpState } from '../packages/server/src/mcp/state.js';

test('RESIL-02 SC1: coordinator tab reload — full session state restored, coordinator can act immediately', async ({
  session,
  browser,
}) => {
  test.setTimeout(40_000);

  // Two independent contexts: one participant, one coordinator.
  const participantCtx = await browser.newContext();
  const coordinatorCtx = await browser.newContext();
  const participant = await participantCtx.newPage();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // (a) Coordinator opens coordinator_url first so they can approve the participant.
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // (b) Participant joins via the Join form (v2.0.0 approval-gate model).
    await participant.goto(session.public_url);
    await expect(participant.getByLabel(/display name/i)).toBeVisible();
    await participant.getByLabel(/display name/i).fill('Alice');
    await participant.getByRole('button', { name: /^continue$/i }).click();

    // (c) Participant is pending — waiting screen visible.
    await expect(participant.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });

    // (d) Coordinator sees Alice in the pending roster; click Approve.
    await expect(
      coordinator.getByRole('button', { name: /approve alice/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordinator.getByRole('button', { name: /approve alice/i }).click();

    // (e) Participant is now approved.
    await expect(participant.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });
    await expect(participant.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 });

    // (f) Post a question via the in-process MCP tool.
    const ticket = askGroup({ question: 'Where should we store tokens?' }) as { ticket_id: string };

    // (g) Question lands on both tabs before we reload.
    const card = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(participant.getByText(/Where should we store tokens/)).toBeVisible({
      timeout: 10_000,
    });

    // (h) Participant submits a suggestion so the question card will show a roster
    //     entry after reload (verifies participant roster rebuild too).
    await participant.getByPlaceholder('Your answer').fill('HttpOnly cookie');
    await participant.getByRole('button', { name: /submit/i }).click();

    // Wait for the suggestion to appear in the coordinator card before reload.
    await expect(card.getByText(/HttpOnly cookie/)).toBeVisible({ timeout: 10_000 });

    // (i) SC1 trigger: RELOAD the coordinator tab.
    //     The sb_c cookie survives the reload; the ?role=coordinator&token= query
    //     params are part of coordinator_url and will be re-read after navigation.
    await coordinator.reload({ waitUntil: 'domcontentloaded' });

    // (j) After reload the coordinator tab must return to the coordinator page
    //     WITHOUT re-navigating — App.tsx uses the cookie + coordinator join path.
    //     If the URL still carries ?role=coordinator&token= the join is automatic.
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 15_000 });

    // (k) The open question must be visible on the coordinator tab after reload
    //     (welcome replay rebuilt questions[]).
    const cardAfterReload = coordinator.getByTestId(`coordinator-question-${ticket.ticket_id}`);
    await expect(cardAfterReload).toBeVisible({ timeout: 10_000 });
    await expect(cardAfterReload.getByText(/Where should we store tokens/)).toBeVisible();

    // (l) The suggestion submitted by Alice must also be present (participant
    //     roster + suggestion seeded from welcome).
    await expect(cardAfterReload.getByText(/HttpOnly cookie/)).toBeVisible({ timeout: 10_000 });

    // (m) SC1 act immediately: coordinator records the answer via override path.
    await cardAfterReload.getByTestId('coordinator-override-textarea').fill('Use HttpOnly cookies');
    await coordinator.getByTestId('coordinator-record-override').click();

    // (n) The browser-driven override resolves the long-poll (coordinator can act
    //     immediately after reload — no re-auth, no re-join, no error).
    const snap = await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 10 });
    expect(snap.resolved).toBe(true);

    // (o) Session decisions confirm the value round-tripped.
    const decisions = mcpState.manager!.sessionView().decisions;
    expect(decisions.some((d) => d.answer === 'Use HttpOnly cookies')).toBe(true);

    // (p) Coordinator card flips to resolved.
    await expect(cardAfterReload.getByTestId('coordinator-resolved-marker')).toBeAttached({
      timeout: 10_000,
    });
  } finally {
    await participantCtx.close();
    await coordinatorCtx.close();
  }

  // NOTE: Do NOT call stopSession() — the fixture's finally block owns teardown.
});

test('RESIL-02 SC1b: coordinator reload with existing decisions — decisions panel persists after reload', async ({
  session,
  browser,
}) => {
  test.setTimeout(40_000);

  const coordinatorCtx = await browser.newContext();
  const coordinator = await coordinatorCtx.newPage();

  try {
    // (a) Coordinator opens coordinator_url — no participant needed for override.
    await coordinator.goto(session.coordinator_url);
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // (b) Post a question and resolve it via override (no participant required).
    const ticket1 = askGroup({ question: 'First question before reload?' }) as { ticket_id: string };
    const card1 = coordinator.getByTestId(`coordinator-question-${ticket1.ticket_id}`);
    await expect(card1).toBeVisible({ timeout: 10_000 });
    await card1.getByTestId('coordinator-override-textarea').fill('Decision A');
    await coordinator.getByTestId('coordinator-record-override').click();
    await expect(card1.getByTestId('coordinator-resolved-marker')).toBeAttached({ timeout: 10_000 });

    // The awaitAnswer call drains the ticket so the session can host another question.
    await awaitAnswer({ ticket_id: ticket1.ticket_id, timeout_s: 10 });

    // (c) Post a second question that will be open at reload time.
    const ticket2 = askGroup({ question: 'Open question at reload time?' }) as {
      ticket_id: string;
    };
    const card2 = coordinator.getByTestId(`coordinator-question-${ticket2.ticket_id}`);
    await expect(card2).toBeVisible({ timeout: 10_000 });

    // (d) RELOAD the coordinator tab — session has 1 decision + 1 open question.
    await coordinator.reload({ waitUntil: 'domcontentloaded' });
    await expect(coordinator.getByTestId('coordinator-page')).toBeVisible({ timeout: 15_000 });

    // (e) Open question must be restored.
    const card2AfterReload = coordinator.getByTestId(`coordinator-question-${ticket2.ticket_id}`);
    await expect(card2AfterReload).toBeVisible({ timeout: 10_000 });
    await expect(card2AfterReload.getByText(/Open question at reload time/)).toBeVisible();

    // (f) Act immediately on the restored question — no reload friction.
    await card2AfterReload.getByTestId('coordinator-override-textarea').fill('Decision B');
    await coordinator.getByTestId('coordinator-record-override').click();
    await expect(card2AfterReload.getByTestId('coordinator-resolved-marker')).toBeAttached({
      timeout: 10_000,
    });

    const snap = await awaitAnswer({ ticket_id: ticket2.ticket_id, timeout_s: 10 });
    expect(snap.resolved).toBe(true);

    const decisions = mcpState.manager!.sessionView().decisions;
    expect(decisions.some((d) => d.answer === 'Decision B')).toBe(true);
  } finally {
    await coordinatorCtx.close();
  }
});
