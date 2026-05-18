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
