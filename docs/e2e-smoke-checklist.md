# E2E Smoke Checklist (Superseded)

This manual checklist is replaced by the automated Playwright E2E suite at `e2e/`.

Run the suite locally:

```bash
npm run test:e2e            # headless
HEADED=1 npm run test:e2e   # headed (Chrome window, slow-mo)
```

Scenarios covered:
- `e2e/golden-path.spec.ts` — one participant joins, suggests, AI records.
- `e2e/multi-participant.spec.ts` — two participants, both submit.
- `e2e/ws-reconnect.spec.ts` — WS disconnect + reconnect + replay.
- `e2e/session-stop.spec.ts` — `stopSession` writes transcript with `ended_reason: stop_session` (asserted via `TranscriptV2.parse`).
- `e2e/signal-handling.spec.ts` — SIGINT to the bin shim writes transcript with `ended_reason: signal`.

See `e2e/README.md` for prerequisites and the rationale for the `workers: 1` constraint.

Historical note: this checklist (pre-Phase-14) referenced a coordinator preview/approve role that has been removed. Do not follow the legacy steps. (See `tasks/lessons.md` lesson #16.)
