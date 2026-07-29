---
name: ufoo-bus-poll
description: >-
  Establish no-token idle bus monitoring and self-wake for an externally
  hosted, MCP-registered Agent with no wrapper-provided UFOO_SUBSCRIBER_ID.
  Select the host App's native wake mechanism: pending MCP wait_for_message for
  Codex App or monitored background stdout for Cursor. Do not use for
  wrapper-managed Agents.
---

# ufoo bus poll

Attach one subscriber to the host App's own wait primitive. Keep queue reads
non-mutating so the Agent acknowledges only after handling work.

This is the standard receive channel for an external MCP Agent. It is not an
ad-hoc reply wait and is not selected by Agent type. The runtime permits only
one active receive wait per subscriber.

## Preserve the token boundary

Keep idle checks inside a pending tool call or host background task. Do not
implement a model-driven timer, repeated chat turn, or fixed
`AGENT_LOOP_TICK_*`. Waiting must not invoke the LLM until a message arrives or
the host's maximum pending-call window ends.

## Attach the subscriber

1. Inspect the host Agent's inherited `UFOO_SUBSCRIBER_ID` before starting or
   mutating any helper terminal. If it is nonempty, stop this workflow: the
   ufoo wrapper already registered the Agent and direct injection is its receive
   path. Do not call MCP `register_agent` or arm a poll.
2. When the variable is absent, reuse the exact subscriber already returned to
   this session by MCP `register_agent`, or call `register_agent` once. Do not
   call bare `ufoo bus join` or borrow another subscriber. Keep the returned
   value as the external Agent's identity.
3. Select the receive mechanism from the host App's actual wake capability,
   never from Agent type:

   - Codex App: use the pending MCP workflow below.
   - Cursor with `notify_on_output`: use the monitored stdout workflow below.
   - Another App: use its documented pending-tool or output-notification
     primitive. If neither exists, automatic self-wake is unavailable; use an
     explicit `$ufoo-bus` check or a user-approved scheduled fallback.

Agent type and subscriber prefix are not capability signals. An externally
hosted MCP subscriber named `codex:*`, `claude-code:*`, or any other type is
eligible because the Agent's inherited environment—not its name—selected this
delivery mode. A variable exported later inside a dedicated helper terminal
does not reclassify the host Agent as wrapper-managed.

## Use Codex App pending MCP wait

Codex App does not resume the current task when a background shell or PTY later
prints stdout. Keep the wait inside one foreground MCP tool call instead:

1. When active work is complete and the inbox should remain armed, call MCP
   `wait_for_message` with:

   - `project_root`: the registered project root
   - `subscriber`: the caller-owned MCP subscriber
   - `after_seq`: `0` for the first wait, then the last returned `last_seq`
   - `timeout_seconds`: `600`
2. Leave that tool call pending. Do not background it and do not start
   `ufoo bus poll --follow`; while the tool is pending, internal queue checks do
   not invoke the model or consume model tokens.
3. If it returns `status: "message"`, handle every returned message, then call
   MCP `ack_bus` with `through_seq: <last_seq>`. This preserves messages that
   arrived after the returned batch.
4. If it returns `status: "timeout"`, no message was received. If monitoring is
   still required, immediately call `wait_for_message` again with the same
   `after_seq`. The timeout return is the only periodic model wake.
5. After handling a message batch and completing any active work, re-arm one
   wait with the returned `last_seq`. Advance the cursor only after `ack_bus`
   succeeds; if acknowledgement fails, resolve that failure before re-arming.
   On cancellation or an explicit stop, leave it disarmed.

Never run two pending waits for the same subscriber.

## Configure Cursor wake-on-output

1. Check for an existing `ufoo bus poll ... --follow` process for the literal
   MCP subscriber. Keep one healthy process; the CLI rejects a duplicate
   receive lease.
2. Start this command through Cursor's monitored background shell. Bind the
   MCP-returned subscriber inside that dedicated terminal, then launch the
   resident poll:

   ```bash
   export UFOO_SUBSCRIBER_ID="<mcp-subscriber-id>"
   exec ufoo bus poll "$UFOO_SUBSCRIBER_ID" --follow --interval 30
   ```

   Use `30` seconds by default; accept `15`–`120` when the user requests a
   different latency. Do not use `nohup`, shell `&`, or an OS-detached daemon.
   This terminal-local export gives its CLI commands a stable sender/subscriber
   identity. It must happen only after the host Agent was classified as
   external and registered through MCP; it is not evidence of wrapper launch
   or direct-injection support.
3. Start the monitored task with
   `block_until_ms: 0`.
4. Configure `notify_on_output` with:

   - pattern: `\[ufoo\]`
   - reason: `ufoo bus pending`
5. Inspect the terminal once to confirm the process started. Idle success is
   a running task with no output; do not wait for a heartbeat.
6. If pending output appears during startup, handle it as the first stream
   batch. Do not run a parallel foreground `ufoo bus check`.

Empty intervals emit nothing, so they neither wake Cursor nor consume model
tokens. Match the general `[ufoo]` protocol prefix rather than a specific
`<from:...>` shape so every message delivered by ufoo can wake the session.
Startup and lifecycle checks also emit nothing; process health comes from the
host task state and the single-subscriber lease.

This process wakes only its own Cursor session. A peer that must react while
unattended needs its own armed poll or another real wake channel.

## Handle delivered batches

For Codex App, read the structured `messages` returned by `wait_for_message`.
For Cursor, handle every `[ufoo]<from:...>` event in the emitted batch.

1. Read each event's `data.message` or printed `Content.message`, then execute
   actionable work.
2. Acknowledge only after handling:

   - Codex App: MCP `ack_bus` with the returned `last_seq` as `through_seq`.
   - Cursor: run the exact command printed by the stream:

   ```bash
   ufoo bus ack "<subscriber-id>" --through <seq>
   ```

   Preserve the sequence boundary so later messages stay pending.
3. Reply only with a requested result, answer, blocker, or fact the sender
   needs. Use MCP `dispatch_message` with the same `project_root`,
   caller-owned subscriber, sender ID as `target`, and substantive result as
   `message`.

Do not reply to greetings, thanks, or acknowledgement-only messages. After
sending, continue the current task. Keep the existing Cursor stream running, or
re-arm one Codex App wait only after active work is complete.

## Stop resident watching

When the user asks to stop:

1. Codex App: cancel the pending `wait_for_message` call and do not re-arm it.
2. Cursor: stop the tracked poll process or matching terminal task and consume
   its shell-completion notification.
3. Confirm that the App-specific receive wait stopped.
