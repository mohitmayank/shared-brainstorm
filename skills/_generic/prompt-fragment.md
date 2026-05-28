# shared-brainstorm — prompt fragment

When the user runs `/shared-brainstorm` or asks to "brainstorm with the team":

1. Call `start_session({ brief: "<topic>" })` and share the returned URL with teammates.
   - `start_session` also returns `coordinator_url` — a one-time URL the initiator (the human) uses to drive the session (see suggestions live, approve participants, pick the final answer). It opens automatically in the initiator's default browser when the session starts; still print it on a line of its own as a fallback:
     ```
     Your coordinator link (only for the initiator):
     {coordinator_url}

     Share link for teammates:
     {public_url}   (approval required)
     ```
   - **WARNING: do NOT include `coordinator_url` in the message you send to teammates.** Anyone who opens that URL becomes the session coordinator. Share only `public_url` with the team.
2. For each question:
   - Call `ask_group({ question, options?, recommendation? })` to get a `ticket_id`
   - Loop `await_answer({ ticket_id, timeout_s: 50 })` until activity or timeout
   - After each return, **check `resolved`**:
     - If `resolved` is `true`: stop polling immediately — the answer was picked in the browser. Use `resolution.value` as the final answer. Do NOT call `record_answer` (the pick is already recorded server-side; calling it would return `{ ok: false, reason: 'already_resolved' }`).
     - If `resolved` is `false`: continue polling, or when discussion has settled, present the suggestions to the user and call `record_answer` with their pick.
3. Use the chosen answer verbatim in your plan.
4. Call `stop_session` when done.

Optional — while planning, you may also push short narration lines to the team:

- `stream_planning({ text: "<one concise sentence>" })` → `{ ok: true, streamed: true|false }`.
- Audience (off/coordinator/everyone) is set by the coordinator from the web UI; default is off. While off, every call returns `streamed: false` — stop narrating until you next see `streamed: true`. One sentence per call (not verbose output / code). Text is redacted best-effort and never written to the transcript.
- Globally disable with `SHARED_BRAINSTORM_NO_STREAM=1` (tool becomes a permanent soft no-op).

If `start_session` fails, fall back to asking the user directly.

MCP server config:
```json
{
  "mcpServers": {
    "shared-brainstorm": {
      "command": "npx",
      "args": ["-y", "shared-brainstorm"]
    }
  }
}
```

## Redaction

Question text passed to `askGroup` is scrubbed for paths, env-var assignments, and high-entropy tokens before broadcast — but this is **best-effort defence-in-depth, not a security guarantee**. The regex + entropy heuristics will miss novel secret formats, custom URL schemes, and many natural-language disclosures. Treat question text as if your participants can read it verbatim.

To disable redaction entirely, set `SHARED_BRAINSTORM_NO_REDACT=1` in the MCP server `env` block:

```json
{
  "mcpServers": {
    "shared-brainstorm": {
      "command": "shared-brainstorm",
      "env": { "SHARED_BRAINSTORM_NO_REDACT": "1" }
    }
  }
}
```

When disabled, a one-line warning prints to stderr at server start.

## Environment

Tune behaviour via env vars in the MCP server's `env` block. Malformed values fall back to defaults with a stderr warning.

- `SHARED_BRAINSTORM_RATE_LIMIT_JOIN` (default `5/min`) — per-IP throttle on `POST /api/join`.
- `SHARED_BRAINSTORM_RATE_LIMIT_SUGGESTION` (default `30/min`) — per-cookie throttle on `POST /api/suggestion`.
- `SHARED_BRAINSTORM_RATE_LIMIT_COMMENT` (default `30/min`) — per-cookie throttle on `POST /api/comment`.
- `SHARED_BRAINSTORM_BIND` (default auto: `127.0.0.1` cloudflared / `0.0.0.0` LAN) — HTTP bind override. IPv4/IPv6 only; hostnames are rejected.
- `CLOUDFLARED_VERSION` (default `2025.11.1`) — pin the cloudflared binary version on the `npx -p cloudflared` fallback path. Ignored when system `cloudflared` is on PATH.
- `SHARED_BRAINSTORM_NO_CLIPBOARD=1` — skip auto-copy of the invite text.
- `SHARED_BRAINSTORM_NO_REDACT=1` — disable question-text redaction.
- `SHARED_BRAINSTORM_NO_STREAM=1` — globally disable `stream_planning` (the tool becomes a permanent soft no-op; no UI, no broadcast, no buffer).

Rate-limit format is `N/window` where `window ∈ {sec, min, hour}`. See the project `README.md` "Environment variables" section for the canonical reference.
