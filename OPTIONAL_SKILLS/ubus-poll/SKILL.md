---
name: ubus-poll
description: |
  Explicitly start a resident ufoo bus stream in an agent host that has been
  configured to deliver streaming background-task output. Install by name only.
---

# /ubus-poll - Resident Bus Stream

This is an opt-in session-start skill. Run it only in a host where a human has
configured this fallback. Do not install or invoke it for Codex CLI, Claude
Code CLI, Agy, Kimi, or native ucode; those runtimes already have their own
ufoo delivery path.

## Start once per agent session

Reuse the provisioned subscriber identity. Never create a second identity just
for the poll process.

```bash
SUBSCRIBER="${UFOO_SUBSCRIBER_ID:-}"
test -n "$SUBSCRIBER" || {
  echo "ubus-poll requires a provisioned UFOO_SUBSCRIBER_ID"
  exit 1
}
```

Identity provisioning is a host/human setup step. Do not guess an agent type,
call bare `ufoo bus join`, or borrow the workspace's current subscriber.

Use the agent host's **streaming background-task** facility to start:

```bash
ufoo bus poll "$SUBSCRIBER" --follow --interval 2
```

The command must remain owned by that facility. Do not use `nohup`, shell `&`,
or an OS-detached daemon: those routes can put output in a log that never
reaches the agent. The command rejects a second resident poll for the same
subscriber.

The poll is deliberately queue-read-only. It emits current pending events at
startup, waits for that batch to be acknowledged, then emits the next pending
batch. It does not ack, claim, inject, or clear messages itself.

## When background output arrives

For every `[ufoo]<from:...>` event:

1. Read `Content.message` and execute actionable work.
2. After handling the emitted batch, run the exact `ack --through <seq>`
   command printed by the poll stream. For example:

   ```bash
   ufoo bus ack "$SUBSCRIBER" --through 42
   ```

   `--through` preserves any later message that was not in the displayed batch.

3. Reply to the sender only for a requested result, an answer, or information
   they need to continue:

   ```bash
   ufoo bus send "<sender-id>" "<substantive result>"
   ```

Ack-only messages, greetings, and thanks need no reply.

After sending, do not poll, sleep, or wait for a reply. Keep working; this
resident stream will emit any follow-up.

## Host requirement

This flow works only when the agent host forwards incremental output from a
still-running background task into the agent session. If it only returns output
after process exit, use an explicitly invoked `/ubus` instead.
