/**
 * Phase 7 (CHAT-01): Session-level room chat e2e tests.
 *
 * Test 1: two participants + coordinator chat round-trip (all see each other's messages).
 * Test 2: coordinator chat message labeled "(host)".
 * Test 3: late-joiner sees full chat history from welcome.
 * Test 4: pending participant cannot post to chat (compose input hidden).
 */
import { test, expect } from './fixtures.js';
import { joinAndApprove } from './helpers.js';

test('two participants see each other\'s messages in room chat', async ({ session, browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const coordCtx = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();
  const coordPage = await coordCtx.newPage();

  try {
    // Open a question so the session is active

    // Join participant1
    await joinAndApprove(page1, coordPage, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Alice',
    });

    // Join participant2 (coordinator tab is already open)
    await page2.goto(session.public_url);
    await expect(page2.getByLabel(/display name/i)).toBeVisible();
    await page2.getByLabel(/display name/i).fill('Bob');
    await page2.getByRole('button', { name: /^continue$/i }).click();
    await expect(page2.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });
    await expect(
      coordPage.getByRole('button', { name: /approve bob/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordPage.getByRole('button', { name: /approve bob/i }).click();
    await expect(page2.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });
    await expect(page2.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 });

    // Both participants should see the chat panel
    await expect(page1.getByTestId('chat-panel')).toBeVisible({ timeout: 8_000 });
    await expect(page2.getByTestId('chat-panel')).toBeVisible({ timeout: 8_000 });

    // Alice posts a message
    await page1.getByTestId('chat-input').fill('Hello from Alice!');
    await page1.getByTestId('chat-send').click();

    // Bob sees Alice's message
    await expect(
      page2.getByTestId('chat-messages').getByText('Hello from Alice!'),
    ).toBeVisible({ timeout: 8_000 });

    // Assert data-actor attribute is 'participant'
    const aliceMsg = page2.locator('[data-testid^="chat-message-"]').first();
    await expect(aliceMsg).toHaveAttribute('data-actor', 'participant');
  } finally {
    await ctx1.close();
    await ctx2.close();
    await coordCtx.close();
  }
});

test('coordinator chat message is labeled (host)', async ({ session, browser }) => {
  const participantCtx = await browser.newContext();
  const coordCtx = await browser.newContext();
  const participantPage = await participantCtx.newPage();
  const coordPage = await coordCtx.newPage();

  try {

    await joinAndApprove(participantPage, coordPage, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Carol',
    });

    // Coordinator sends a message
    await expect(coordPage.getByTestId('chat-panel')).toBeVisible({ timeout: 8_000 });
    await coordPage.getByTestId('chat-input').fill('Welcome to the session!');
    await coordPage.getByTestId('chat-send').click();

    // Participant sees the message with (host) suffix
    await expect(
      participantPage.getByTestId('chat-messages').getByText('Welcome to the session!'),
    ).toBeVisible({ timeout: 8_000 });

    // The message row should contain "(host)"
    const hostMsg = participantPage.locator('[data-testid^="chat-message-"]').first();
    await expect(hostMsg.getByText(/\(host\)/)).toBeVisible({ timeout: 5_000 });
    await expect(hostMsg).toHaveAttribute('data-actor', 'coordinator');
  } finally {
    await participantCtx.close();
    await coordCtx.close();
  }
});

test('late-joiner sees full chat history from welcome', async ({ session, browser }) => {
  const ctx1 = await browser.newContext();
  const ctx3 = await browser.newContext();
  const coordCtx = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page3 = await ctx3.newPage();
  const coordPage = await coordCtx.newPage();

  try {

    // Participant1 joins and posts a message
    await joinAndApprove(page1, coordPage, {
      publicUrl: session.public_url,
      coordinatorUrl: session.coordinator_url,
      displayName: 'Eve',
    });

    await expect(page1.getByTestId('chat-panel')).toBeVisible({ timeout: 8_000 });
    await page1.getByTestId('chat-input').fill('Early chat message before Dave joins');
    await page1.getByTestId('chat-send').click();

    // Confirm message sent
    await expect(
      page1.getByTestId('chat-messages').getByText('Early chat message before Dave joins'),
    ).toBeVisible({ timeout: 5_000 });

    // Late-joiner Dave joins AFTER the message was already sent
    await page3.goto(session.public_url);
    await expect(page3.getByLabel(/display name/i)).toBeVisible();
    await page3.getByLabel(/display name/i).fill('Dave');
    await page3.getByRole('button', { name: /^continue$/i }).click();
    await expect(page3.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });
    await expect(
      coordPage.getByRole('button', { name: /approve dave/i }),
    ).toBeVisible({ timeout: 10_000 });
    await coordPage.getByRole('button', { name: /approve dave/i }).click();
    await expect(page3.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });
    await expect(page3.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 });

    // Dave sees the earlier message immediately (from welcome chat[] seed)
    await expect(
      page3.getByTestId('chat-messages').getByText('Early chat message before Dave joins'),
    ).toBeVisible({ timeout: 8_000 });
  } finally {
    await ctx1.close();
    await ctx3.close();
    await coordCtx.close();
  }
});

test('pending participant cannot post to chat (compose input hidden)', async ({
  session,
  browser,
}) => {
  const participantCtx = await browser.newContext();
  const coordCtx = await browser.newContext();
  const participantPage = await participantCtx.newPage();
  const coordPage = await coordCtx.newPage();

  try {

    // Coordinator opens their page
    await coordPage.goto(session.coordinator_url);
    await expect(coordPage.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

    // Participant navigates and submits name — but is NOT yet approved
    await participantPage.goto(session.public_url);
    await expect(participantPage.getByLabel(/display name/i)).toBeVisible();
    await participantPage.getByLabel(/display name/i).fill('Pending Pete');
    await participantPage.getByRole('button', { name: /^continue$/i }).click();

    // Participant is on the waiting screen — pending
    await expect(participantPage.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });

    // Pending participant has no chat-input (canPost=false for pending participants)
    // The chat panel may not even be visible on the waiting screen, but if it is,
    // the compose input must not be present.
    const chatInput = participantPage.getByTestId('chat-input');
    await expect(chatInput).toHaveCount(0);
  } finally {
    await participantCtx.close();
    await coordCtx.close();
  }
});
