# Development

shared-brainstorm is an npm-workspaces monorepo with three packages:

- `packages/server` — the MCP server, HTTP/WebSocket layer, and session logic. This is the only package published to npm.
- `packages/web` — the React SPA served to participants, bundled into the server on publish.
- `packages/shared` — TypeScript types and Zod wire schemas shared by both.

## Getting started

```bash
git clone https://github.com/mohitmayank/shared-brainstorm
cd shared-brainstorm
npm install
npm test
```

## Common commands

```bash
npm test           # run the full Vitest suite across all packages
npm run test:e2e   # Playwright end-to-end tests
npm run typecheck  # strict TypeScript check
npm run lint       # ESLint
npm run format     # Prettier
npm run build      # build server + web bundle
```

Source files follow the package layout above; tests are co-located with the modules they cover (`*.test.ts`).
