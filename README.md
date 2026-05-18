# shared-brainstorm

Bring your team into your AI agent's planning loop. When your agent has a design question, share a link with your team — they answer in a live web page — and the agent uses their input as it plans, while you (the initiator) drive everything from the terminal.

## What you get

- One link + 6-digit code to share with your team. No accounts, no install on their side.
- Teammates open the link in a browser and type suggestions and comments.
- Your agent collects the team's input and asks *you* to confirm the final pick — right in the CLI.
- A transcript of every decision is saved to `~/.shared-brainstorm/sessions/`.

## Install

```bash
npx shared-brainstorm --install claude-code
```

Then restart Claude Code. Other agents:

```bash
npx shared-brainstorm --install codex
npx shared-brainstorm --install opencode
npx shared-brainstorm --install gemini-cli
```

For shareable links beyond your LAN, install `cloudflared` (free, zero-config tunnel):

```bash
# macOS
brew install cloudflare/cloudflare/cloudflared

# Linux
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
```

Skip `cloudflared` if your team is already on the same network.

## Use

Ask your agent to brainstorm with your team — for example:

> "Brainstorm the auth flow with my team."

Your agent will:

1. Spin up a session and hand you a share link + join code (auto-copied to your clipboard).
2. Post each question to the live page.
3. Show you the team's responses in the CLI and let you pick the final answer (or override with your own).

You can drive the whole brainstorm from the terminal; you never need to open the web page.

## Options

| Env var | Effect |
|---|---|
| `SHARED_BRAINSTORM_NO_CLIPBOARD=1` | Don't auto-copy the invite to your clipboard. The invite text is still printed. |

## Development

```bash
git clone https://github.com/mohitmayank/shared-brainstorm
cd shared-brainstorm
npm install
npm test
```

## Releasing

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

Pre-requisites for the person cutting a release:

- `npm login` — be authenticated against the `shared-brainstorm` npm package.
- `GITHUB_TOKEN` env var with `repo` scope (or use `gh auth login`) — needed for the GitHub release step.
- Clean git working tree on `main`.

## Contributing

PRs welcome. **By opening a pull request you agree to the project's [CLA](CONTRIBUTING.md).** You keep the copyright in your contribution; you just grant the project a broad license to ship it under AGPL today and under other licenses.

## License

[AGPL-3.0-or-later](LICENSE). You can use, modify, and redistribute this software freely — including running modified versions as a hosted service — as long as any such copy stays under AGPL, makes its source available, and gives credit back to this project.
