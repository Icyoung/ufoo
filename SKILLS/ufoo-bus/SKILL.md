---
name: ufoo-bus
description: >-
  Operate the local ufoo event bus: check and acknowledge pending messages,
  identify or join a subscriber, inspect status, resolve targets, send results,
  and broadcast updates. Use when asked to handle bus messages or perform local
  agent-to-agent routing.
---

# ufoo bus

Operate the project-local event bus without creating reply loops or competing
with automatic prompt injection.

## Establish the subscriber

Verify `.ufoo/bus/` exists. If it does not, initialize it:

```bash
ufoo init --targets bus --project "$(pwd)"
```

Prefer `UFOO_SUBSCRIBER_ID`, then recover the current identity:

```bash
ufoo bus whoami
```

Run `ufoo bus join` only when neither source yields an identity. Rejoining can
cause identity drift.

## Handle pending messages

Check messages only when this skill was invoked to do so:

```bash
ufoo bus check "$UFOO_SUBSCRIBER_ID"
```

For every pending batch:

1. Read the sender from `[ufoo]<from:id(nickname)>`.
2. Execute each actionable task.
3. Acknowledge after handling:

   ```bash
   ufoo bus ack "$UFOO_SUBSCRIBER_ID"
   ```

   When a batch supplies a final sequence, prefer
   `ufoo bus ack "$UFOO_SUBSCRIBER_ID" --through <seq>` so later arrivals stay
   pending.
4. Reply only when the sender requested an answer, delegated work whose result
   is needed, or needs a discovered blocker or fact.

Do not reply to greetings, thanks, `ok`, `收到`, or other acknowledgement-only
messages. Acknowledge them locally and stop.

## Route messages

Inspect identities and nicknames before sending:

```bash
ufoo bus status
ufoo bus resolve "$UFOO_SUBSCRIBER_ID" <target>
```

Send to an exact subscriber ID, unique nickname, or agent type:

```bash
ufoo bus send "<target>" "<substantive message>"
ufoo bus broadcast "<substantive message>"
```

Target resolution order is exact ID, nickname, agent type, then `*`.

After sending or broadcasting, continue the current task. Do not run
`ufoo bus check`, poll, sleep, or wait for a reply. Follow-up messages are
injected into the prompt/session automatically.

## Report delegated work

Use the shared report contract when bus work represents a task:

```bash
ufoo report start "<task>" --task <id> --agent "$UFOO_SUBSCRIBER_ID"
ufoo report progress "<detail>" --task <id> --agent "$UFOO_SUBSCRIBER_ID"
ufoo report done "<summary>" --task <id> --agent "$UFOO_SUBSCRIBER_ID"
ufoo report error "<reason>" --task <id> --agent "$UFOO_SUBSCRIBER_ID"
```

Use `--scope private` only for helper-internal reports.
