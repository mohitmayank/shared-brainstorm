/**
 * Shared e2e helpers for the Phase 4 approval-gate join model.
 *
 * v2.0.0 removed the 6-digit join code. Participants now:
 *  1. Fill a display name and click "Continue".
 *  2. Land on a "Waiting for approval" screen (join-waiting testid).
 *  3. Wait for the coordinator to click Approve in the coordinator tab.
 *  4. Transition to the approved session view (join-empty-cta testid).
 *
 * `joinAndApprove` encapsulates steps 1–4 so individual specs do not each
 * repeat the full approval dance.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export interface JoinAndApproveOpts {
  /** The public-facing session URL for participants. */
  publicUrl: string;
  /** The coordinator URL (includes ?role=coordinator&token=…). */
  coordinatorUrl: string;
  /** The display name the participant will fill in. */
  displayName: string;
}

/**
 * Drives the complete participant-join + coordinator-approval flow.
 *
 * @param participantPage  - Playwright Page for the participant browser context.
 * @param coordinatorPage  - Playwright Page for the coordinator browser context.
 * @param opts             - URLs and display name.
 *
 * After this function resolves the participant page is showing the approved
 * session view (data-testid="join-empty-cta" is visible).
 */
export async function joinAndApprove(
  participantPage: Page,
  coordinatorPage: Page,
  { publicUrl, coordinatorUrl, displayName }: JoinAndApproveOpts,
): Promise<void> {
  // (a) Coordinator opens coordinator_url first so they are ready to approve.
  await coordinatorPage.goto(coordinatorUrl);
  await expect(coordinatorPage.getByTestId('coordinator-page')).toBeVisible({ timeout: 10_000 });

  // (b) Participant navigates to the public URL.
  await participantPage.goto(publicUrl);
  await expect(participantPage.getByLabel(/display name/i)).toBeVisible();
  await participantPage.getByLabel(/display name/i).fill(displayName);

  // v2.0.0: button is "Continue", not "Join session" — no join code required.
  await participantPage.getByRole('button', { name: /^continue$/i }).click();

  // (c) Participant lands on the waiting-for-approval screen.
  await expect(participantPage.getByTestId('join-waiting')).toBeVisible({ timeout: 10_000 });
  await expect(participantPage.getByText(/waiting for approval/i)).toBeVisible();

  // (d) Coordinator sees the joiner in the pending roster; click Approve.
  await expect(
    coordinatorPage.getByRole('button', { name: new RegExp(`approve ${displayName}`, 'i') }),
  ).toBeVisible({ timeout: 10_000 });
  await coordinatorPage.getByRole('button', { name: new RegExp(`approve ${displayName}`, 'i') }).click();

  // (e) Participant's waiting screen disappears (WS delivers approval event).
  await expect(participantPage.getByTestId('join-waiting')).toBeHidden({ timeout: 10_000 });

  // (f) Participant sees the empty-state CTA — they are now in the session.
  await expect(participantPage.getByTestId('join-empty-cta')).toBeVisible({ timeout: 10_000 });
  await expect(participantPage.getByText(/you're in!/i)).toBeVisible();
}
