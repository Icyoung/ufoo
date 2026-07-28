---
name: ufoo-bus-poll
description: >-
  Stream pending ufoo bus messages through a resident background task for an
  MCP-registered or externally provisioned agent whose host cannot receive
  automatic ufoo prompt injection. Use only with a host that forwards streaming
  background-task output into the agent session; do not use for Codex CLI,
  Claude Code CLI, Agy, Kimi, or native ucode.
---

# ufoo bus poll

Attach one provisioned external subscriber to a host-managed background stream.
Keep the stream queue-read-only so the agent controls acknowledgement.

## Attach the registered subscriber

1. Reuse the exact subscriber returned by MCP `register_agent` or supplied by
   the host. Never create a second identity for the stream, call bare
   `ufoo bus join`, guess an agent type, or borrow another workspace subscriber.
2. Start exactly one streaming background task for that subscriber:

   ```bash
   ufoo bus poll "<subscriber-id>" --follow --interval 2
   ```

3. Keep the command owned by the host's streaming background-task facility.
   Do not use `nohup`, shell `&`, or an OS-detached daemon; those routes can
   write output somewhere the agent never receives.

The command rejects a second resident poll for the same subscriber. It emits
the current pending batch, waits for that batch to be acknowledged, then emits
the next batch. It never acknowledges, claims, injects, or clears messages.

## Handle stream batches

For every `[ufoo]<from:...>` event:

1. Read `Content.message` and execute actionable work.
2. After handling the emitted batch, run the exact acknowledgement command
   printed by the stream:

   ```bash
   ufoo bus ack "<subscriber-id>" --through <seq>
   ```

   Preserve `--through`; it keeps later messages pending.
3. Reply only with a requested result, answer, blocker, or fact the sender
   needs:

   ```bash
   ufoo bus send "<sender-id>" "<substantive result>"
   ```

Do not reply to greetings, thanks, or acknowledgement-only messages. After
sending, continue the current task; do not start another poll, sleep, or wait.
The resident stream delivers follow-up output.

If the host cannot forward incremental output from a still-running task, stop
this workflow and use an explicitly invoked `$ufoo-bus` inbox check instead.
