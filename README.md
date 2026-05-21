# shared-brainstorm

Get your team's input on your AI agent's design decisions — live in their browser, in seconds, with nothing to install.

Your AI plans alone, but real product decisions need your team. Your agent asks *"Postgres or DynamoDB?"* — your teammates weigh in on a live page — your agent plans with their answer.

→ [See it in action](https://github.com/mohitmayank/shared-brainstorm/blob/main/demo/index.html)

## What you get

- **Link-only join** — the host approves each joiner (no code). Teammates just open the link in any browser.
- Teammates submit suggestions, comments, and clarifying questions in real time.
- **Live presence indicators** and session status visible to all participants.
- **Batch questions** — the agent can post multiple questions at once; teammates answer in any order.
- **Talk-with-AI** — participants can ask the agent clarifying questions; the reply appears inline.
- **Per-room chat** — teammates can discuss freely alongside the suggestion stream.
- **Coordinator web UI** — drive the session from a browser tab alongside the CLI; approve, lock, and kick participants.
- A transcript of every decision saved to `~/.shared-brainstorm/sessions/`.

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

## How it works

Ask your agent to brainstorm with your team — for example:

> "Brainstorm the auth flow with my team."

Your agent will:

1. Spin up a session and hand you a share link (auto-copied to your clipboard).
2. Your teammates open the link — the host approves each one before they enter the session.
3. Post questions to the live page (one at a time, or a batch). Teammates submit suggestions and comments in real time.
4. Pick the final answer from the CLI or from the coordinator browser UI. Lock or kick participants as needed.

You can drive the whole session from the terminal; the coordinator browser UI is available for a more visual experience.

## Environment variables

All runtime tuning is via env vars. Set them in the MCP server's `env` block in your AI host's MCP config (e.g. `~/.claude.json` for Claude Code), or export them in the shell before running `npx shared-brainstorm`.

| Variable | Default | Accepted format | When to set it |
|----------|---------|-----------------|----------------|
| `SHARED_BRAINSTORM_RATE_LIMIT_JOIN` | `5/min` | `N/window` where `window ∈ {sec, min, hour}` | Loosen or tighten the per-IP rate limit on `POST /api/join`. |
| `SHARED_BRAINSTORM_RATE_LIMIT_SUGGESTION` | `30/min` | same | Loosen or tighten the per-cookie rate limit on `POST /api/suggestion`. |
| `SHARED_BRAINSTORM_RATE_LIMIT_COMMENT` | `30/min` | same | Loosen or tighten the per-cookie rate limit on `POST /api/comment`. |
| `SHARED_BRAINSTORM_BIND` | `127.0.0.1` in cloudflared mode, `0.0.0.0` in LAN mode | IPv4 dotted-quad or IPv6 address | Override the HTTP bind address. Hostnames like `localhost` are rejected with a stderr warning and the default for the active mode is used. |
| `CLOUDFLARED_VERSION` | `2025.11.1` | Semver-like version published at `github.com/cloudflare/cloudflared/releases` | Pin a different binary version when shared-brainstorm spawns `cloudflared` via the `cloudflared` npm wrapper. Ignored when `cloudflared` is already on PATH. |
| `SHARED_BRAINSTORM_NO_CLIPBOARD` | unset | `1`, `true`, `yes`, `on` | Don't auto-copy the invite to your clipboard. The invite text is still printed. |
| `SHARED_BRAINSTORM_NO_REDACT` | unset | `1`, `true`, `yes`, `on` | Disable best-effort question-text redaction. A loud one-line warning prints to stderr at server start when this is set. |

Malformed `*_RATE_LIMIT_*` and `SHARED_BRAINSTORM_BIND` values fall back to defaults with a stderr warning — the server never refuses to start because of a bad env-var value.

### Rate-limit format

`N/window` — integer count over a rolling window.

- `30/min` → 30 requests per 60 seconds.
- `5/sec` → 5 per second.
- `100/hour` → 100 per 3600 seconds.

The window keys are exactly `sec`, `min`, `hour` — `seconds` / `minutes` / `m` / `s` / `h` are not recognised and trigger the fallback warning.

### Bind override

`SHARED_BRAINSTORM_BIND` is mainly useful for two scenarios:

- LAN mode, but you want the server to listen on a specific interface — e.g. `SHARED_BRAINSTORM_BIND=192.168.1.42`.
- Cloudflared mode, but you want to verify locally on `0.0.0.0` first — e.g. `SHARED_BRAINSTORM_BIND=0.0.0.0`.

The value must be a literal IPv4 or IPv6 address. Hostnames (`localhost`, `host.docker.internal`) are rejected — the mode-default bind address is used and a stderr warning is emitted.

### Cloudflared version pin

`CLOUDFLARED_VERSION` only takes effect on the npm-wrapper path (`npx -p cloudflared cloudflared …`). If a system-installed `cloudflared` is on `PATH`, that binary is used unconditionally and this variable is ignored.

The npm `cloudflared` package downloads the latest binary on first invocation unless this env var is set; pinning here makes the tunnel spawn deterministic across machines and CI. To install a specific binary manually outside of shared-brainstorm:

```bash
npx -p cloudflared cloudflared bin install 2025.11.1
```

The pin currently shipped with shared-brainstorm is `2025.11.1`.

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
