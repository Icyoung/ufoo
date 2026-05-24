# Daemon MCP Integration Plan

Date: 2026-04-21
Status: active-draft
Scope: expose daemon control-plane capabilities over MCP so externally launched `claude` / `codex` sessions can join `ufoo` without requiring `uclaude` / `ucodex` wrappers for the bus/control plane.

## Implementation Audit (2026-04-26)

This plan is not implemented yet. Code search did not find a daemon-backed MCP
server/tool surface in `src/`, `bin/`, or tests. Existing wrapper and daemon
control-plane code still covers the launcher-centric integration path.

## 1. Goal

Add a daemon-backed MCP surface that lets externally running agents integrate with:

- bus registration
- targeted/broadcast message delivery
- ack and inbox polling
- agent status / activity publication
- controller-facing read tools

without requiring `uclaude` / `ucodex` as the only entrypoint.

This does **not** mean deleting wrappers immediately. It means:

- wrappers become the default convenience launcher
- daemon MCP becomes the stable control-plane API
- native `claude` / `codex` sessions can self-register and participate in `ubus`

## 2. Why This Is Needed

Current integration is launcher-centric:

- [bin/uclaude.js](/Users/icy/Code/ufoo/bin/uclaude.js:1)
- [bin/ucodex.js](/Users/icy/Code/ufoo/bin/ucodex.js:1)
- [src/agents/launch/launcher.js](/Users/icy/Code/ufoo/src/agents/launch/launcher.js:437)

`uclaude` / `ucodex` currently do much more than "start a process":

- ensure `.ufoo` init
- ensure daemon is running
- register the agent over daemon socket
- inject env like `UFOO_SUBSCRIBER_ID` / `UFOO_NICKNAME`
- manage session reuse and pre-registration
- start notifier / ready detection / activity publication
- notify daemon when the child is ready
- clean up bus membership on exit

This means direct `claude` / `codex` usage currently misses the control-plane join path unless the wrapper is used.

## 3. Target Architecture

The target split should be:

### 3.1 Daemon MCP owns control-plane

Daemon MCP should expose stable APIs for:

- agent registration
- agent presence / heartbeat / activity updates
- inbox polling and ack
- message dispatch
- controller read tools
- optional rename / metadata update

### 3.2 Wrappers own local execution concerns

Wrappers should continue to own local process/session concerns:

- spawning the provider CLI
- PTY wrapping
- ready detection
- session reuse
- slash-command bootstrap like `/rename`
- local notifier integration

This distinction is important: MCP can replace the **control plane**, not every part of local terminal orchestration.

## 4. Can MCP Fully Replace `uclaude` / `ucodex`?

Short answer: **it can fully replace their control-plane role, but not every launcher/runtime role.**

### 4.1 MCP can replace these parts completely

- `register_agent`
- `dispatch_message`
- `ack_bus`
- `read_bus_summary`
- `read_prompt_history`
- `read_open_decisions`
- `publish_activity_state`
- `rename_agent`
- `resolve_target`

These are the parts that make an agent visible and operable inside `ufoo`.

### 4.2 MCP cannot fully replace these without another local shim

- PTY spawn and terminal lifecycle
- TTY / tmux pane detection
- session reuse probing
- child-process ready detection
- injecting text into a live terminal session
- process-exit cleanup hooks tied to the launched child

Those responsibilities live in [src/agents/launch/launcher.js](/Users/icy/Code/ufoo/src/agents/launch/launcher.js:307) and related runtime pieces because they are inherently local execution concerns.

### 4.3 Practical conclusion

Daemon MCP can make `uclaude` / `ucodex` **non-mandatory** for bus/control-plane participation.

It should not be sold as "100% replacement for wrappers" unless we also build a separate local runtime shim or MCP-aware launcher host.

## 5. What `uclaude` / `ucodex` Actually Provide Today

From [src/agents/launch/launcher.js](/Users/icy/Code/ufoo/src/agents/launch/launcher.js:437) onward, the wrapper flow today is:

1. Ensure project init
2. Ensure daemon is running
3. Register agent with daemon over socket
4. Receive:
   - subscriber id
   - nickname
   - session info
5. Export env for child process
6. Start notifier / monitoring
7. Launch provider process with PTY or direct spawn
8. Detect ready state
9. Notify daemon of readiness
10. Clean bus membership on exit

For daemon MCP planning, the relevant subset is:

- registration
- metadata sync
- readiness / heartbeat / activity publication
- inbox read / ack
- send / receive over bus

## 6. MCP Surface Needed For Full Control-Plane Coverage

The minimum MCP API should cover the following tool groups.

### 6.1 Registration and presence

- `register_agent`
  Input:
  - `agent_type`
  - `nickname`
  - `launch_mode`
  - `host_name`
  - `host_session_id`
  - `capabilities`
  Output:
  - `subscriber_id`
  - `nickname`
  - `session_id`
  - `project_root`

- `update_agent_metadata`
  Input:
  - `subscriber_id`
  - `nickname`
  - `metadata`

- `publish_activity_state`
  Input:
  - `subscriber_id`
  - `activity_state`
  - `detail`
  - `since`

- `heartbeat_agent`
  Input:
  - `subscriber_id`

- `unregister_agent`
  Input:
  - `subscriber_id`

### 6.2 Bus delivery

- `dispatch_message`
- `broadcast_message`
- `poll_inbox`
- `ack_bus`
- `resolve_target`

### 6.3 Controller read tools

- `read_bus_summary`
- `read_prompt_history`
- `read_open_decisions`
- `list_agents`
- `read_project_registry`

These align closely with the existing tool registry in:

- [src/tools/registry.js](/Users/icy/Code/ufoo/src/tools/registry.js:1)
- [src/tools/schemaFixtures.js](/Users/icy/Code/ufoo/src/tools/schemaFixtures.js:1)

## 7. Recommended Integration Modes

There should be two supported external-integration modes.

### Mode A: External agent with manual MCP client

An already running `claude` or `codex` process connects to daemon MCP and:

- registers itself
- polls inbox
- acks bus
- publishes activity

This is the lowest-coupling mode and the main goal of this plan.

### Mode B: Wrapper remains, but uses daemon MCP internally

`uclaude` / `ucodex` keep handling PTY/session concerns, but stop using ad-hoc daemon socket JSON for control-plane registration.

Instead, they call the same daemon MCP endpoints as external clients.

This is the best long-term convergence point because it removes split registration logic.

## 8. What Should Not Be In V1

Do not try to expose all daemon powers immediately.

V1 should **not** include:

- unrestricted process management
- direct PTY injection APIs
- full daemon restart/stop/start over MCP
- high-risk cron/process mutation beyond existing controlled ops
- internal child management hooks

Reason: these are not required to remove the wrapper bottleneck for bus participation.

## 9. Detailed Execution Plan

## Phase 0: Capability audit and boundary freeze

Goal:
lock the exact line between control-plane MCP and launcher-only local runtime concerns.

Tasks:

1. Document wrapper-only responsibilities from:
   - `launcher.js`
   - `ptyRunner.js`
   - `notifier.js`
2. Mark which behaviors must remain local-only.
3. Freeze the V1 MCP scope around:
   - register
   - heartbeat
   - activity publish
   - inbox poll
   - ack
   - send
   - read tools

Exit criteria:

- one authoritative capability matrix exists
- no ambiguous overlap between daemon MCP and wrapper-only responsibilities

## Phase 1: Daemon MCP registration and presence API

Goal:
allow an external agent to become a first-class bus participant without wrapper launch.

Tasks:

1. Add daemon MCP server surface, likely under a new module like:
   - `src/runtime/daemon/mcpServer.js`
   - or `src/mcp/daemonServer.js`
2. Implement:
   - `register_agent`
   - `heartbeat_agent`
   - `publish_activity_state`
   - `update_agent_metadata`
   - `unregister_agent`
3. Reuse existing bus metadata storage instead of inventing parallel state.
4. Ensure daemon-side registration semantics match current socket registration:
   - stable subscriber ids
   - nickname scoping
   - activity defaults

Exit criteria:

- an external MCP client can register and appear in `ufoo bus status`
- nickname and activity state show up correctly in dashboard/status views

## Phase 2: Bus delivery and inbox API

Goal:
let externally running agents actually participate in collaboration.

Tasks:

1. Implement:
   - `dispatch_message`
   - `broadcast_message`
   - `poll_inbox`
   - `ack_bus`
   - `resolve_target`
2. Preserve current bus semantics:
   - pending queue behavior
   - ack semantics
   - targeted vs broadcast delivery
3. Ensure messages produced by MCP clients are indistinguishable from wrapper-launched agents in bus events.

Exit criteria:

- external MCP client can receive targeted work
- execute it
- reply back
- ack correctly
- stop generating unread-bus noise after ack

## Phase 3: Expose controller read tools over MCP

Goal:
let external agents access the same control-plane reads that `ufoo-agent` and loop runtime already use.

Tasks:

1. Expose read-only MCP tools matching current registry:
   - `read_bus_summary`
   - `read_prompt_history`
   - `read_open_decisions`
   - `list_agents`
   - `read_project_registry`
2. Reuse existing handlers where possible.
3. Make sure payload shapes match internal tool schemas.

Exit criteria:

- external `claude` / `codex` can fully reason over bus/controller state without shelling out to `ufoo bus` or reading files directly

## Phase 4: Converge wrappers onto daemon MCP

Goal:
stop having separate socket-specific registration logic for wrappers and MCP clients.

Tasks:

1. Refactor `AgentLauncher.registerWithDaemon()` to target the same MCP-backed service layer.
2. Keep wrapper process-management behavior unchanged.
3. Remove duplicated control-plane serialization logic if it exists.

Exit criteria:

- `uclaude` / `ucodex` and external MCP clients share one registration/service path
- daemon registration semantics are unified

## Phase 5: External integration validation

Goal:
prove that direct `claude` / `codex` sessions can integrate without wrappers for the control plane.

Tasks:

1. Create a minimal sample integration script for Claude.
2. Create a minimal sample integration script for Codex.
3. Validate:
   - register
   - send/receive
   - ack
   - activity publish
   - rename/metadata update
   - controller read tools
4. Confirm they show up correctly in:
   - bus status
   - dashboard
   - routing context

Exit criteria:

- two externally launched agents can collaborate over `ufoo` without `uclaude` / `ucodex`

## 10. Acceptance Criteria

The plan should be considered successful only if all are true:

1. A raw `claude` session can register via daemon MCP and participate in `ubus`.
2. A raw `codex` session can register via daemon MCP and participate in `ubus`.
3. Both appear in the same control-plane views as wrapper-launched agents.
4. `ufoo-agent` can route to them using the same bus metadata.
5. `uclaude` / `ucodex` still work unchanged during transition.
6. No daemon-only MCP endpoint is required for PTY spawn/injection in V1.

## 11. Risks

### 11.1 False promise risk

If this is described as "replace wrappers entirely", users will expect PTY/session management and auto `/ubus` injection behavior to work without local runtime support. That is not realistic for V1.

### 11.2 Split-brain registration risk

If wrappers keep using one registration path and MCP clients use another, bugs will appear in:

- nickname handling
- activity state
- stale subscriber cleanup
- status/dashboard rendering

This is why wrapper convergence should be an explicit later phase.

### 11.3 Security boundary risk

If daemon MCP exposes high-privilege process control too early, the control-plane surface becomes too broad and hard to secure.

## 12. Recommended V1 Delivery

The smallest useful shippable version is:

1. registration + heartbeat
2. bus send/poll/ack
3. activity publishing
4. controller read tools

This is enough to make wrappers non-mandatory for collaboration.

It is not enough to replace wrappers as launch/runtime managers, and the project should state that clearly.

## 13. Final Conclusion

Yes, daemon MCP can cover the **full control-plane capability set** currently provided by `uclaude` / `ucodex`.

No, daemon MCP alone does **not** fully replace all wrapper/runtime behavior.

The right target is:

- wrappers remain optional launch helpers
- daemon MCP becomes the canonical control-plane interface
- direct `claude` / `codex` sessions can register with `ufoo`, use `ubus`, and be routed by the controller without needing `uclaude` / `ucodex`
