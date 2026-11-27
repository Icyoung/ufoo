---
name: ufoo-bus
description: >-
  Operate the local ufoo event bus through MCP cooperation tools: register
  external native CLIs, check and acknowledge pending messages, resolve targets,
  dispatch messages, and report delegated work status. Use when coordinating
  multiple agents in a ufoo workspace.
---

# ufoo bus

Operate the project-local event bus without creating reply loops.

## Establish subscriber identity

Verify `.ufoo/bus/` exists. If it does not, initialize it:

```bash
ufoo init --targets bus --project "$(pwd)"
```

- **Managed workers (`UFOO_LAUNCH_MODE=internal` — Claude SDK, Codex SDK, ACP, or `ucode`)**:
  The daemon already registered your identity (`UFOO_SUBSCRIBER_ID` + `UFOO_AGENT_HANDLE`) and delivers each turn directly through the SDK/ACP runtime. **Never** call `register_agent`, `poll_inbox`, `wait_for_message`, or `ack_bus`. Use MCP cooperation tools (`dispatch_message`, `report_agent_status`, `read_open_decisions`, `list_agents`) directly.
- **External native CLIs / IDEs (`claude`, `codex`, Cursor, Antigravity, etc.)**:
  Reuse this session's MCP-registered subscriber and `agent_handle`, or call MCP `register_agent` once (passing a stable `client_instance_id` when available). Keep `<agent-handle>` private: never send, log, or report it. Invoke `$ufoo-bus-poll` once at session start when resident waiting is needed (selecting pending MCP `wait_for_message` for Codex App or monitored stdout for Cursor). Never choose a delivery mode from an Agent type, and remember that Agents do not self-register with bare `ufoo bus join`.

## Handle pending messages

For managed workers (`UFOO_LAUNCH_MODE=internal`), each incoming bus task is delivered as a new turn and acknowledged automatically after execution.

For external CLIs, use MCP `poll_inbox` with `project_root`, `subscriber`, and `agent_handle` when checking messages manually. For each batch:

1. Read the sender from `[ufoo]<from:id(nickname)>`.
2. Execute each actionable task.
3. Acknowledge with MCP `ack_bus` passing `through_seq` (`last_seq`) and `agent_handle`.
4. Reply only when the sender requested an answer, delegated work whose result is needed, or needs a discovered blocker or fact.

Do not reply or report to greetings, thanks, `ok`, `收到`, receipts, repeated completion notices, unchanged status, or acknowledgement-only messages. Use the user's task language for substantive replies, progress, reports, and handoffs unless asked otherwise.

## Route messages

Call MCP `dispatch_message` with `project_root`, `subscriber`, `agent_handle`, `target`, and `message` (use `*` for broadcast). Target resolution order is exact ID, nickname, agent type, then `*`.

A successful send confirms durable queuing (`delivery_status: "queued"`), not completion. Continue the current task after sending; do not sleep or poll in a loop waiting for replies.

## Report delegated work

Call MCP `report_agent_status` with `project_root`, `subscriber`, `agent_handle`, `task_id`, `phase` (`start`, `progress`, `done`, `error`), and `summary`. Reuse the controller-assigned `task_id` across all reports.

Keep reports and handoffs to 1-4 concise lines (under 600 characters) covering outcome, changed files or branch/commit SHA, exact checks run, blockers, and next owner action.
