// Critical: workers: 1 is MANDATORY and must not be "optimised" away.
// mcpState in packages/server/src/mcp/state.ts is a module-level singleton.
// Multiple Playwright workers are separate processes — they would each import
// the server code into their own module graph — but they would still collide on
// the OS-level transcript directory and on the single-process assumption.
// See RESEARCH Pitfall 2 in .planning/phases/01-reliability-foundation/01-RESEARCH.md.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',

  // See comment at top of file — do not raise workers above 1.
  workers: 1,
  fullyParallel: false,

  // No retries — flake should fail loudly so we fix the root cause.
  retries: 0,

  // CI: terse 'dot' output; local: 'list' with one line per test.
  reporter: process.env['CI'] ? [['dot'], ['html', { open: 'never' }]] : 'list',

  use: {
    // Headless by default per decision D-05. HEADED=1 npm run test:e2e for local debug.
    headless: !process.env['HEADED'],

    // Capture trace on first failure. Trace viewer is the primary debugging tool.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Generous timeout because LAN transport boots Hono synchronously and
    // WS events should land in <100ms.
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },

  // Phase 1 scope is chromium-only per decision D-01. Adding Firefox/WebKit
  // later is a single config change.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
