import { test, expect } from './fixtures.js';
import { readFileSync, existsSync } from 'node:fs';
import { askGroup, awaitAnswer, recordAnswer, stopSession } from '../packages/server/src/mcp/tools.js';
import { TranscriptV2 } from '../packages/shared/src/transcript.js';

test('session-stop: stopSession writes transcript with ended_reason=stop_session', async ({
  session,
  page,
}) => {
  // (a) Reproduce the golden-path flow inline.
  // Navigate to the session URL and join as Alice.
  await page.goto(session.public_url);

  // Wait for the join form to appear.
  await page.waitForSelector('#name');
  await page.fill('#name', 'Alice');
  await page.fill('#code', session.join_code);
  await page.click('button[type="submit"]');

  // Wait for the in-session DOM (welcome received — heading changes from "shared-brainstorm" to
  // something showing session state, or the join form disappears).
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return !form || !(form as HTMLElement).offsetParent;
  }, { timeout: 10_000 });

  // Ask a question via in-process MCP tool.
  const ticket = askGroup({ question: 'Where to host?' });
  expect(ticket.ticket_id).toMatch(/^sb_t_/);

  // Wait for the question to appear in the DOM.
  await page.waitForSelector('[data-testid="question-text"], .question-text, h2, .card h2', {
    timeout: 5_000,
  }).catch(() => {
    // If no matching selector, wait briefly and continue; the test assertion below will catch it.
  });

  // Submit a suggestion from the participant's browser.
  const suggestionInput = page.locator('input[type="text"], textarea').first();
  const hasInput = await suggestionInput.count() > 0;
  if (hasInput) {
    await suggestionInput.fill('Vercel');
    const submitBtn = page.locator('button').filter({ hasText: /submit|suggest/i }).first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
    }
  }

  // Poll for discussion snapshot; timeout_s=5 so the spec stays fast.
  await awaitAnswer({ ticket_id: ticket.ticket_id, timeout_s: 5 });

  // Record the answer from the AI host side.
  const out = recordAnswer({
    ticket_id: ticket.ticket_id,
    value: 'Vercel',
    source: 'suggestion',
  });
  expect(out.ok).toBe(true);

  // (b) Stop the session and capture the transcript path.
  const stop = await stopSession();
  expect(stop.ok).toBe(true);
  expect(stop.transcript_path).toMatch(/\.json$/);
  expect(existsSync(stop.transcript_path)).toBe(true);
  // Confirm the transcript lives inside the fixture's isolated tmp dir (no
  // pollution of the developer's real ~/.shared-brainstorm/sessions/).
  expect(stop.transcript_path).toContain(session.transcriptDir);

  // (c) Parse and assert via Zod — schema mismatch throws (primary assertion per D-08).
  const raw = readFileSync(stop.transcript_path, 'utf8');
  const parsed = TranscriptV2.parse(JSON.parse(raw));

  // Key field assertions.
  expect(parsed.brief).toBe('e2e test'); // matches the fixture's `brief`
  expect(parsed.ended_reason).toBe('stop_session');
  expect(parsed.participants.length).toBeGreaterThanOrEqual(1);
  expect(parsed.questions.length).toBeGreaterThanOrEqual(1);

  // The question should be resolved (answered).
  const q = parsed.questions[0];
  expect(q?.status).toBe('resolved');

  // The resolution value should be 'Vercel'.
  expect(q?.resolution?.value).toBe('Vercel');

  // (d) Do NOT call stopSession() again — the fixture teardown handles the
  // "already stopped" case correctly because mcpState.manager is now null
  // (stopSession() clears it), so the guard `if (mcpState.manager)` in
  // fixtures.ts correctly skips the duplicate call.
});
