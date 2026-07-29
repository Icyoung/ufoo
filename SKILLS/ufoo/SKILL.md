---
name: ufoo
description: >-
  Coordinate a ufoo workspace across context decisions, durable memory, event-bus
  delivery, status, and initialization. Use at the start of an agent session in
  a ufoo project, or when asked to initialize, inspect, or coordinate the unified
  ufoo protocol.
---

# ufoo

Apply the unified workspace protocol. Use `$ufoo-bus`, `$ufoo-context`, or
`$ufoo-online` when the task needs the focused workflow.

## Resolve the bus delivery mode

Use the host Agent's inherited launch environment as the only delivery-mode
signal. Evaluate it before creating or mutating helper terminals. Do not infer
capabilities from the Agent type or subscriber prefix.

- If `UFOO_SUBSCRIBER_ID` is nonempty, the Agent was started by a ufoo wrapper
  and is already registered. Reuse that identity. Do not call MCP
  `register_agent`, run `ufoo bus join`, or start `ufoo bus poll`; the wrapper
  and daemon deliver follow-ups by direct prompt injection.
- If `UFOO_SUBSCRIBER_ID` is absent, the Agent is externally hosted. Reuse the
  subscriber and `agent_handle` already returned to this session, or call
  MCP `register_agent` once if none exists. When the host
  exposes a stable local session identifier, pass it as `client_instance_id`
  so a transport restart can recover the subscriber and rotate the handle.
  Keep the returned pair as session-local identity; never send or report the
  handle to another Agent. Invoke `$ufoo-bus-poll` to establish the receive
  path using this host App's own no-token wait and self-wake primitive. A
  Cursor-style dedicated listener terminal may export the returned value as
  `UFOO_SUBSCRIBER_ID` after registration so its CLI commands share the
  identity. That helper-local export does not change the already selected
  external delivery mode and must not be treated as wrapper evidence.

In the sections below, `<subscriber-id>` means the wrapper-provided
`UFOO_SUBSCRIBER_ID` or the subscriber returned by MCP. `<agent-handle>` means
the opaque capability returned with an external MCP registration.

## Synchronize workspace state

1. Read open decisions before related work:

   ```bash
   ufoo ctx decisions -s open
   ```

2. Read each relevant decision fully. Follow unresolved implications; never
   resolve a decision from its title alone.
3. Consume relevant shared memory before writing new memory.
4. Keep the default as no new decision and no new memory entry.

## Handle delivered messages

Treat these prompt prefixes as work inputs:

- `[ufoo]<from:id(nickname)>` — event-bus delivery from direct injection or the
  resident external-Agent stream.
- `[manual]<to:id(nickname)>` — manual work directed to this agent.

For each received bus task:

1. Execute it immediately within the current authority.
2. Acknowledge it only after handling. A wrapper-managed Agent uses:

   ```bash
   ufoo bus ack "<subscriber-id>"
   ```

   An external Agent calls MCP `ack_bus` with `project_root`, `subscriber`,
   `agent_handle: "<agent-handle>"`, and the delivered sequence boundary.
3. Reply only with a requested answer, delegated result, or fact the sender
   needs to continue. Do not reply with greetings or bare acknowledgements.
4. Emit a concise runtime report for delegated work. A wrapper-managed Agent
   uses:

   ```bash
   ufoo report done "<summary>" --agent "<subscriber-id>"
   ```

   An external Agent calls MCP `report_agent_status` with the same subscriber
   and handle.
After sending or broadcasting, continue the current task. Do not start an
ad-hoc check or poll, sleep, or wait for a reply. A wrapper-managed Agent
receives follow-ups by direct injection; an external Agent leaves its existing
App-specific `$ufoo-bus-poll` receive wait armed when idle.

## Preserve shared knowledge

Record a decision only for architecture, meaningful trade-offs, cross-agent
contracts, or precedent that constrains future work:

```bash
ufoo ctx decisions new "<title>"
```

Store only durable project facts in shared memory:

```bash
ufoo memory add "<title>" --body "<durable fact>" --tags <tags>
ufoo memory list
ufoo memory show <memory-id>
ufoo memory edit <memory-id>
```

Do not use decisions or memory as progress logs, scratchpads, or transient
status storage.

## Inspect unified status

Run:

```bash
ufoo status
```

Summarize unread messages, open decisions, and any immediate action needed.

## Initialize workspace state

Initialize only the required targets:

```bash
ufoo init --targets context,bus --project "$(pwd)"
```

Initialization does not choose or create an Agent identity. Establish identity
only through the delivery-mode branch above.
