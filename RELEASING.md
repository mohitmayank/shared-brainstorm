# Releasing

The `shared-brainstorm` npm package (in `packages/server`) is the only thing published; the rest is private workspace code that gets bundled in.

```bash
npm run release
```

This runs [`release-it`](https://github.com/release-it/release-it), which will:

1. Run `npm run typecheck` and `npm test`.
2. Prompt you for the next version (patch/minor/major or custom).
3. Build the server + web bundle.
4. Commit the version bump, tag it `v<version>`, and push to GitHub.
5. Publish to npm.
6. Create a GitHub release with auto-generated notes.

## Pre-requisites for the person cutting a release

- `npm login` — be authenticated against the `shared-brainstorm` npm package.
- `GITHUB_TOKEN` env var with `repo` scope (or use `gh auth login`) — needed for the GitHub release step.
- Clean git working tree on `main`.
