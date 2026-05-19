# shared-brainstorm

**Triggers:** `/shared-brainstorm` command, or when the user says "brainstorm with my team" / "get team input" / "ask the group".

## What this skill does

Routes plan-mode questions to a live web page where teammates can discuss. The team contributes free-text suggestions and comments; you (the AI) collect them, present them back to the **initiator** (the human running you) via the built-in `AskUserQuestion` tool, and record their final pick. The initiator never opens the web page.

## Flow

1. **Start a session**
   Call `startSession` with a brief description of what you're working on.
   ```
   startSession({ brief: "API rate-limiting strategy" })
   → { session_id, public_url, join_code }
   ```
   Show the user the public URL and join code so they can share both with the team. Example:
   ```
   Session started!
   Share link: https://abc123.trycloudflare.com
   Join code: 426193
   ```

2. **Ask a question**
   ```
   askGroup({
     question: "Should we use token buckets or sliding window?",
     options: [
       { label: "Token bucket", description: "Simple, good for bursty traffic" },
       { label: "Sliding window", description: "More precise, slightly more memory" }
     ],
     recommendation: "Token bucket — simpler to implement correctly"
   })
   → { ticket_id }
   ```
   The question broadcasts immediately to everyone in the room. `options` is optional — omit for free-text questions.

3. **Collect the team's input (long-poll)**
   ```
   awaitAnswer({ ticket_id, timeout_s: 50 })
   → { suggestions: [{ participant_name, value, rationale?, at }],
       comments:    [{ participant_name, text, at }],
       resolved:    false }
   ```
   `awaitAnswer` is a **long-poll**: it returns as soon as a new suggestion or comment arrives, OR when `timeout_s` elapses (whichever first). This keeps the loop snappy — when a teammate types, you'll usually see it within ~100ms.

   Recommended polling pattern:
   - Call `awaitAnswer({ ticket_id, timeout_s: 50 })`.
   - When it returns with new content, decide whether the discussion has settled. Heuristic: if you just got 1 new item, call again with `timeout_s: 5` to see if more is on the way; if that returns with zero new content, the discussion is settled — present to the initiator. If the snapshot keeps growing, keep polling.
   - If you've waited the full long timeout twice in a row with no new content, present whatever you have (or nothing if empty — let the initiator decide whether to wait more).

   The ticket stays open across polls.

4. **Present to the initiator and get their pick**
   Use Claude Code's built-in `AskUserQuestion` to show the initiator what the team said. Guidelines:
   - **Option-style questions**: tally votes from suggestions; list each option with its tally; recommend the leader.
   - **Free-text questions, 0 suggestions**: ask the initiator to either wait longer or write the answer themselves.
   - **Free-text questions, 1 suggestion**: present it verbatim alongside "Override with my own".
   - **Free-text questions, 2+ suggestions**: present each verbatim, plus an AI synthesis that combines the team's points, plus "Override with my own".
   - Always include the participant's name when quoting their suggestion ("Alice: X").
   - Never edit a participant's words when presenting their verbatim suggestion.

5. **Record the answer**
   ```
   recordAnswer({
     ticket_id,
     value: "<the chosen answer>",
     source: "suggestion" | "synthesis" | "override"
   })
   → { ok: true }
   ```
   `source` provenance:
   - `'suggestion'` — initiator picked a participant's verbatim suggestion.
   - `'synthesis'` — initiator picked your synthesised answer.
   - `'override'` — initiator wrote a new answer that wasn't on the menu.

   The decision is written to the transcript. The current question closes; you can now `askGroup` again.

6. **Stop the session**
   When done, call `stopSession`. The full transcript (every event, every question, every suggestion/comment, every decision) is written to `~/.shared-brainstorm/sessions/`.

## Fallback

If `startSession` fails (cloudflared unavailable, port conflict, etc.), fall back to the built-in `AskUserQuestion` tool to ask questions interactively instead. Inform the user that team brainstorm mode is unavailable.

## Notes

- Do not redact or summarise participant suggestions when presenting them — use them verbatim. Synthesis is allowed only as an additional option, never as a replacement.
- The initiator drives the brainstorm from their terminal. They do NOT open the web page; the web page is just the team's input surface.
- Sessions auto-stop if the MCP client disconnects.
- Set `SHARED_BRAINSTORM_NO_CLIPBOARD=1` in the MCP server's env (e.g., `~/.claude.json`) to suppress the auto-copy of `invite_text` to the OS clipboard. `invite_text` is still returned; only the side effect is skipped.

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
