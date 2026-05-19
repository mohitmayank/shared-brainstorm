# E2E Test Suite (Playwright)

Comprehensive end-to-end coverage replacing the legacy `docs/e2e-smoke-checklist.md`.

## Run

```bash
# Run all E2E specs (headless)
npm run test:e2e

# Run with a visible Chrome window (debug)
HEADED=1 npm run test:e2e

# Run a single spec
npx playwright test e2e/golden-path.spec.ts --config=e2e/playwright.config.ts
```

## Prerequisites

```bash
# Install all dependencies (includes @playwright/test)
npm install

# One-time: download Chromium binary (~150MB)
npx playwright install chromium

# Build the React SPA — Hono serves it at /; without it the browser hits 404
npm run build -w packages/web
```

## Typecheck

`npm run typecheck` covers `e2e/**/*.ts` via `e2e/tsconfig.json` (see Task 4 of Plan 01-04). TypeScript errors in fixtures or spec files surface at typecheck-time, not at Playwright-runtime — this closes the silent-failure window described in lesson #13.

Run `npm run typecheck` before committing changes to any `e2e/` file.

## Why workers: 1?

`mcpState` in `packages/server/src/mcp/state.ts` is a module-level singleton. Playwright workers run as separate processes — each would import the server code into its own module graph — but they would still collide on the OS-level transcript directory and on the single-process assumption.

Do not "optimise" `workers: 1` away without first re-architecting the singleton. See RESEARCH Pitfall 2 in `.planning/phases/01-reliability-foundation/01-RESEARCH.md`.

## Scenarios

Spec files land in Plans 05 and 06 of Phase 01:

| File | Scenario |
|------|----------|
| `golden-path.spec.ts` | Single participant joins, submits a suggestion, AI records the answer |
| `multi-participant.spec.ts` | Two participants, both submit suggestions |
| `ws-reconnect.spec.ts` | WebSocket disconnect, reconnect, and event replay |
| `session-stop.spec.ts` | `stopSession` writes transcript with `ended_reason: stop_session` |
| `signal-handling.spec.ts` | SIGINT writes transcript with `ended_reason: signal` (subprocess-based) |
