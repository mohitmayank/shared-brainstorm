# Configuration

All runtime tuning is via environment variables. Set them in the MCP server's `env` block in your AI host's MCP config (e.g. `~/.claude.json` for Claude Code), or export them in the shell before running `npx shared-brainstorm`.

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

## Rate-limit format

`N/window` — integer count over a rolling window.

- `30/min` → 30 requests per 60 seconds.
- `5/sec` → 5 per second.
- `100/hour` → 100 per 3600 seconds.

The window keys are exactly `sec`, `min`, `hour` — `seconds` / `minutes` / `m` / `s` / `h` are not recognised and trigger the fallback warning.

## Bind override

`SHARED_BRAINSTORM_BIND` is mainly useful for two scenarios:

- LAN mode, but you want the server to listen on a specific interface — e.g. `SHARED_BRAINSTORM_BIND=192.168.1.42`.
- Cloudflared mode, but you want to verify locally on `0.0.0.0` first — e.g. `SHARED_BRAINSTORM_BIND=0.0.0.0`.

The value must be a literal IPv4 or IPv6 address. Hostnames (`localhost`, `host.docker.internal`) are rejected — the mode-default bind address is used and a stderr warning is emitted.

## Cloudflared version pin

`CLOUDFLARED_VERSION` only takes effect on the npm-wrapper path (`npx -p cloudflared cloudflared …`). If a system-installed `cloudflared` is on `PATH`, that binary is used unconditionally and this variable is ignored.

The npm `cloudflared` package downloads the latest binary on first invocation unless this env var is set; pinning here makes the tunnel spawn deterministic across machines and CI. To install a specific binary manually outside of shared-brainstorm:

```bash
npx -p cloudflared cloudflared bin install 2025.11.1
```

The pin currently shipped with shared-brainstorm is `2025.11.1`.
