---
name: ufoo-bus
description: >-
  Operate the local ufoo event bus: check and acknowledge pending messages,
  establish the correct wrapper or MCP subscriber, inspect status, resolve
  targets, send results, broadcast updates, and hand external Agents to
  $ufoo-bus-poll for host App-specific no-token wait and self-wake delivery.
  Use when asked to handle bus messages or perform local agent-to-agent routing.
---

# ufoo bus

Operate the project-local event bus without creating reply loops or competing
with automatic prompt injection.

## Establish the delivery mode and subscriber

Verify `.ufoo/bus/` exists. If it does not, initialize it:

```bash
ufoo init --targets bus --project "$(pwd)"
```

Use `UFOO_SUBSCRIBER_ID` as the only delivery-mode signal:

- Nonempty: this is a wrapper-managed Agent. The wrapper already registered
  the subscriber and the daemon can inject into its monitored shell. Reuse the
  value. Do not call MCP `register_agent`, run `ufoo bus join`, or arm resident
  polling.
- Absent: this is an externally hosted Agent. Reuse this session's
  MCP-registered subscriber or call MCP `register_agent` exactly once. Keep the
  returned value as `<subscriber-id>` for later MCP and CLI operations; do not
  export it as `UFOO_SUBSCRIBER_ID`. Invoke `$ufoo-bus-poll` once at session
  start to select the receive path supported by the host App.

Never choose a delivery mode from an Agent type such as `codex`, `cursor`, or
`claude-code`. Agents do not self-register with bare `ufoo bus join`.

## Handle pending messages

If a wrapper-managed Agent was explicitly asked for a manual inbox check, run:

```bash
ufoo bus check "<subscriber-id>"
```

For an external Agent, use MCP `poll_inbox` with its `project_root` and
caller-owned `<subscriber-id>` only when an explicit manual check is required.
If `$ufoo-bus-poll` woke the session with an emitted pending batch, handle that
batch directly. Do not run a second check for the same wake.

For every pending batch:

1. Read the sender from `[ufoo]<from:id(nickname)>`.
2. Execute each actionable task.
3. Acknowledge after handling:

   ```bash
   ufoo bus ack "<subscriber-id>"
   ```

   When a batch supplies a final sequence, prefer
   `ufoo bus ack "<subscriber-id>" --through <seq>` so later arrivals stay
   pending. For a `$ufoo-bus-poll` wake, run the exact `ack --through <seq>`
   line printed by the Cursor stream. A Codex App wait returns `last_seq`; pass
   it to MCP `ack_bus` as `through_seq`.
4. Reply only when the sender requested an answer, delegated work whose result
   is needed, or needs a discovered blocker or fact.

Do not reply to greetings, thanks, `ok`, `收到`, or other acknowledgement-only
messages. Acknowledge them locally and stop.

## Route messages

Inspect identities and nicknames before sending:

```bash
ufoo bus status
ufoo bus resolve "<subscriber-id>" <target>
```

For a wrapper-managed Agent, send to an exact subscriber ID, unique nickname,
or Agent type with:

```bash
ufoo bus send "<target>" "<substantive message>"
ufoo bus broadcast "<substantive message>"
```

For an external Agent, call MCP `dispatch_message` with its `project_root`,
caller-owned `subscriber`, `target`, and `message`. Use target `*` for a
broadcast. This preserves the registered sender identity instead of creating a
CLI-side identity.

Target resolution order is exact ID, nickname, agent type, then `*`.

After sending or broadcasting, continue the current task. Do not run
`ufoo bus check`, start another poll, sleep, or wait for a reply.
Wrapper-managed Agents receive follow-ups by direct injection; external Agents
keep their App-specific receive wait armed when idle.

## Delegate resident watching

For an externally hosted Agent with no `UFOO_SUBSCRIBER_ID`, invoke
`$ufoo-bus-poll` at session start and follow it end-to-end. This is its normal
receive path, not an Agent-type fallback. That skill selects pending MCP
`wait_for_message` for Codex App or monitored background stdout for Cursor.
Never invoke it when the environment variable is present.

Do not implement a timer, tick, sleep/check loop, or second resident mechanism
in this skill. Do not arm resident watching merely because a message was sent
and a reply is expected. After an App-specific wake, handle the delivered batch
using the rules above and leave re-arming or stream lifecycle to
`$ufoo-bus-poll`.

## Report delegated work

Use the shared report contract when bus work represents a task:

```bash
ufoo report start "<task>" --task <id> --agent "<subscriber-id>"
ufoo report progress "<detail>" --task <id> --agent "<subscriber-id>"
ufoo report done "<summary>" --task <id> --agent "<subscriber-id>"
ufoo report error "<reason>" --task <id> --agent "<subscriber-id>"
```

Use `--scope private` only for helper-internal reports.
