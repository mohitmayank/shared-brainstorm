# shared-brainstorm — prompt fragment

When the user runs `/shared-brainstorm` or asks to "brainstorm with the team":

1. Call `start_session({ brief: "<topic>" })` and share the returned URL + join code.
2. For each question:
   - Call `ask_group({ question, options?, recommendation? })` to get a `ticket_id`
   - Loop `await_answer({ ticket_id, timeout_s: 50 })` until `status !== "pending"`
3. Use the chosen answer verbatim in your plan.
4. Call `stop_session` when done.

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
