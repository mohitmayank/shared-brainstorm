# shared-brainstorm

**Triggers:** `/shared-brainstorm` command, or when the user says "brainstorm with my team" / "get team input" / "ask the group".

## What this skill does

Routes plan-mode questions to a live web page where teammates can discuss. The team contributes free-text suggestions and comments; you (the AI) collect them, present them back to the **initiator** (the human running you) via the built-in `AskUserQuestion` tool, and record their final pick. The initiator never opens the web page.

## Flow

1. **Start a session**
   Call `startSession` with a brief description of what you're working on.
   ```
   startSession({ brief: "API rate-limiting strategy" })
   → { session_id, public_url, coordinator_url }
   ```
   Show the user the public URL so they can share it with the team. Teammates join as pending — the coordinator must approve each one. Example:
   ```
   Session started!
   Share link: https://abc123.trycloudflare.com
   (Teammates will need your approval to join)
   ```

   ### Output fields

   **`coordinator_url`** — a one-time URL the initiator (you, the human) can open in their own browser to drive the session from a coordinator view (see pending joiners, approve/kick participants, pick the final answer). Print this URL to the initiator on a line of its own — for example:

   ```
   Your coordinator link (only for the initiator):
   {coordinator_url}

   Share link for teammates:
   {public_url}   (approval required)
   ```

   **WARNING: do NOT include `coordinator_url` in the message you send to teammates.** Anyone who opens that URL becomes the session coordinator. Share only `public_url` with the team.

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

4. **Handle participant clarifications (CHATAI-01)**

   After each `awaitAnswer` call, **check `clarifications`** before presenting to the initiator:

   ```
   awaitAnswer({ ticket_id, timeout_s: 50 })
   → { suggestions: [...], comments: [...],
       clarifications: [{ participant_name, clarification_id, text, answer?, asked_at, answered_at? }],
       resolved: false }
   ```

   - If any clarification has `answer === undefined`, the participant is waiting for your response.
   - Answer each pending clarification **before** presenting to the initiator:

   ```
   answerClarification({
     ticket_id,
     clarification_id: "<the clarification_id from awaitAnswer>",
     text: "Your answer to the participant's question"
   })
   → { ok: true }
   ```

   - Your answer broadcasts in real-time to all connected clients — the waiting participant sees it immediately.
   - **Clarifications are separate from suggestions** — they are informational context only. Do not include clarification text in the suggestion tally; do not present them as answer options.
   - `answerClarification` still works after `recordAnswer` (terminal fallback) — you can answer late clarifications for context.

5. **Check resolved (stop-on-resolved guard)**

   After each `awaitAnswer` call, **check the `resolved` field before doing anything else**.

   **Important:** Check `resolved` is `true` BEFORE accessing `resolution.value` — when `resolved` is `false`, the `resolution` field is absent. (Pitfall 7 guard.)

   - **If `resolved` is `true`:** The question has already been answered by a teammate or coordinator via the browser. The answer is in `resolution.value`. Do the following:
     - Print the confirmation line to the terminal: `Team picked: {resolution.value} (chosen in browser by {resolution.picked_by})`
     - Proceed with `resolution.value` as the final answer.
     - **Do NOT call `AskUserQuestion`** — the initiator does not need to re-pick; the answer is already chosen.
     - **Do NOT call `recordAnswer`** — the answer is already recorded server-side. Calling `recordAnswer` after a browser pick would be a no-op at best and may return `{ ok: false, reason: 'already_resolved' }`, which means you lost a race — proceed with `resolution.value` regardless.

   - **If `resolved` is `false`:** Continue to step 6 (present to the initiator) as normal.

6. **Present to the initiator and get their pick**
   Use Claude Code's built-in `AskUserQuestion` to show the initiator what the team said. Guidelines:
   - **Option-style questions**: tally votes from suggestions; list each option with its tally; recommend the leader.
   - **Free-text questions, 0 suggestions**: ask the initiator to either wait longer or write the answer themselves.
   - **Free-text questions, 1 suggestion**: present it verbatim alongside "Override with my own".
   - **Free-text questions, 2+ suggestions**: present each verbatim, plus an AI synthesis that combines the team's points, plus "Override with my own".
   - Always include the participant's name when quoting their suggestion ("Alice: X").
   - Never edit a participant's words when presenting their verbatim suggestion.

7. **Record the answer**
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

   `recordAnswer` is reserved for **agent-driven answers only** (the agent's own synthesis or initiator override). If `recordAnswer` returns `{ ok: false, reason: 'already_resolved', resolution }`, you lost a race — use `resolution.value` and proceed, do not re-prompt the initiator.

   The decision is written to the transcript. The current question closes; you can now `askGroup` again.

8. **Stop the session**
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

## Environment

Set env vars in the MCP server's `env` block (e.g. `~/.claude.json`) when the initiator wants to tune behaviour. The server validates every value and falls back to defaults with a stderr warning if a value is malformed — it never refuses to start.

| Variable | Default | When to suggest setting it |
|----------|---------|----------------------------|
| `SHARED_BRAINSTORM_RATE_LIMIT_JOIN` | `5/min` | Throttle teammates rejoining (e.g. `1/min` if you suspect refresh loops). |
| `SHARED_BRAINSTORM_RATE_LIMIT_SUGGESTION` | `30/min` | Cap per-teammate suggestion velocity per-question. |
| `SHARED_BRAINSTORM_RATE_LIMIT_COMMENT` | `30/min` | Cap per-teammate comment velocity per-question. |
| `SHARED_BRAINSTORM_BIND` | auto (`127.0.0.1` with cloudflared, `0.0.0.0` on LAN) | Override the HTTP bind. IPv4/IPv6 only — hostnames are rejected. |
| `CLOUDFLARED_VERSION` | `2025.11.1` | Pin the cloudflared binary version when using the `npx -p cloudflared` fallback. Ignored when system `cloudflared` is on PATH. |
| `SHARED_BRAINSTORM_NO_CLIPBOARD` | unset | Set to `1` to skip auto-copying the invite text to the OS clipboard. |
| `SHARED_BRAINSTORM_NO_REDACT` | unset | Set to `1` to disable question-text redaction (see Redaction section above). |

Rate-limit format is `N/window`, where `window ∈ {sec, min, hour}` — e.g. `30/min`, `5/sec`, `100/hour`. Other window keys (`seconds`, `m`, `h`) trigger the fallback warning. See the project `README.md` "Environment variables" section for the canonical reference.
