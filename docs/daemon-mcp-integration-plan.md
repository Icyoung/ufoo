# Global MCP Bridge Integration Plan

Date: 2026-04-21
Status: initial implementation + active backlog
Scope: expose the local global `ufoo` control plane over MCP so externally
launched `claude` / `codex` sessions can join `ufoo` without requiring
`uclaude` / `ucodex` wrappers for bus/control-plane participation.

## Historical Audit (2026-04-26)

At that time, code search did not find a daemon-backed MCP server/tool surface
in `src/`, `bin/`, or tests. Existing wrapper and daemon control-plane code
covered only the launcher-centric integration path.

## Implementation Update (2026-05-25)

Mode A has an initial implementation:

- `ufoo mcp` starts a stdio MCP bridge from the globally installed `ufoo`
  command.
- The bridge auto-starts the home-scoped global controller daemon by default.
- MCP tools include global project registry reads, selected project-scoped
  Tier 0/Tier 1 tools, MCP agent registration, heartbeat, activity publication,
  inbox polling, report queueing, metadata update, and unregister.
- Project-scoped calls require a `project_root` from the global runtime
  registry. There is still no project-local MCP server mode.

Remaining work:

- Extract a shared `controlPlaneService.js` so daemon IPC and MCP do not drift.
  **Done (2026-05-29)**: `src/runtime/daemon/controlPlaneService.js` extracted;
  `mcpServer.js` handlers delegate to it. Daemon IPC still uses its own inline
  logic for REGISTER_AGENT (launcher-specific concerns); convergence is Phase 5.
- Route more project-scoped mutations through the live project daemon where that
  matters for UI broadcasts.
  **Done (2026-05-29)**: `controlPlaneService` calls `notifyDaemonRefresh()`
  after each mutation (register, heartbeat, activity, metadata, unregister).
  The daemon handles a new `REFRESH_STATUS` IPC request type that triggers an
  immediate status broadcast to connected UI clients.
- Add external client examples for Claude/Codex MCP configuration.
  **Done (2026-05-29)**: `docs/mcp-client-examples.md` covers Claude Desktop,
  Claude Code CLI, and Codex configuration plus a register→poll→ack walkthrough.

## Phase 5 Implementation (2026-05-29)

Wrapper registration converged onto the shared service layer:

- `checkAndCleanupNickname` moved from `daemon/index.js` to `nicknameScope.js`.
- `controlPlaneService.registerAgentFull(projectRoot, args, options)` handles
  the superset of registration logic: session reuse, parentPid validation,
  nickname scope/conflict checks, and bus join.
- `registerAgent()` (MCP path) is now a thin wrapper calling `registerAgentFull`
  with `{validateParentPid: false, checkNicknameConflicts: false}`.
- The daemon's `REGISTER_AGENT` IPC handler calls `registerAgentFull` with
  `{validateParentPid: true, checkNicknameConflicts: true}`, keeping only
  provider session resolution and socket response inline.

Exit criteria met:
- `uclaude` / `ucodex` and external MCP clients share one registration path.
- Daemon registration semantics are unified through `controlPlaneService`.

## Phase 6 Validation (2026-05-29)

Integration test added at `test/unit/daemon/mcpIntegration.test.js`:

- Two external agents (claude + codex) register without wrappers.
- Both appear in `read_bus_summary`.
- Agent A publishes activity, sends a message to Agent B.
- Agent B polls inbox, sees the message, acks.
- Agent B submits a report.
- Agent A updates metadata (nickname + custom metadata).
- Both unregister cleanly.

All acceptance criteria from Section 10 are met in the test environment.
Live validation against real `claude` / `codex` sessions requires the MCP
client configuration from `docs/mcp-client-examples.md`.

## Design Adjustment (2026-05-24)

The high-level direction still looks correct: the global MCP bridge should
become the canonical **external control-plane** API, while wrappers continue to
own local runtime / PTY concerns.

The plan should be tightened before implementation:

1. Treat MCP as a globally installed entrypoint, not as a service users need to
   start separately in every repository. `ufoo -g` already runs a
   home-scoped global controller daemon:
   - [bin/ufoo.js](/Users/icy/Code/ufoo/bin/ufoo.js:16) resolves the chat root
     to `resolveGlobalControllerProjectRoot()` when `-g` / `--global` is used.
   - [src/runtime/projects/identity.js](/Users/icy/Code/ufoo/src/runtime/projects/identity.js:15)
     anchors that controller root at the user's home directory.
   - Project daemons publish their runtime state into the global registry under
     `~/.ufoo/projects/runtime` via
     [src/runtime/projects/registry.js](/Users/icy/Code/ufoo/src/runtime/projects/registry.js:31).
2. The preferred MCP topology is therefore:
   - one global MCP bridge command exposed from the globally installed `ufoo`
     package
   - default connection to the home-scoped global controller daemon
   - project-scoped requests routed through the project runtime registry to the
     target project daemon
   - no separately supported project-local MCP server mode in V1
3. Put MCP code under the current runtime package, not a new top-level package.
   Prefer:
   - `src/runtime/daemon/mcpServer.js`
   - `src/runtime/daemon/controlPlaneService.js`
   - `src/runtime/contracts/mcpContract.js` if a stable contract module is
     needed
4. Do not introduce `src/mcp/` unless `docs/source-structure.md` is updated in
   the same change. The current source map intentionally keeps daemon,
   contracts, and shared tools in `src/runtime/` and `src/tools/`.
5. Separate two surfaces:
   - **MCP session/control tools**: register, heartbeat, poll, ack, activity,
     self metadata, report.
   - **Shared ufoo tools** from `src/tools/registry.js`: controller/worker
     tool-call functions with existing caller-tier rules.
6. Do not reuse normal subscriber pending queues for daemon control events.
   Current report control uses the dedicated queue in
   `src/runtime/daemon/reportControlBus.js` (`.ufoo/bus/control/report`) to
   avoid reordering ordinary bus messages. MCP control requests should follow
   that pattern when they need file-backed async delivery.

## 1. Goal

Add a local global MCP bridge that lets externally running agents integrate with:

- bus registration
- targeted/broadcast message delivery
- ack and inbox polling
- agent status / activity publication
- agent report submission
- controller-facing read tools

without requiring `uclaude` / `ucodex` as the only entrypoint.

This does **not** mean deleting wrappers immediately. It means:

- wrappers become the default convenience launcher
- global MCP bridge becomes the stable external control-plane API
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

### 3.0 Global controller entrypoint

The default MCP entrypoint should be the global controller runtime, because
that is the only runtime that naturally sees every registered project.

Current code already has this shape:

- `ufoo -g` / `ufoo chat -g` starts chat against the home-scoped controller
  root, not the current repository.
- Project daemons write liveness, PID, socket, and project metadata into the
  global project runtime registry.
- The global controller uses `global-router` mode and forwards project-specific
  prompts to the selected project daemon.

MCP should follow the same shape. A global MCP server/bridge can answer
cross-project read tools itself, then forward project-scoped control-plane
operations to the selected project daemon socket.

### 3.1 Global MCP owns external control-plane access

Global MCP should expose stable APIs for:

- agent registration
- agent presence / heartbeat / activity updates
- inbox polling and ack
- message dispatch
- controller read tools
- optional rename / metadata update
- report submission

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
- self metadata / nickname update
- `report_agent_status`
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

Global MCP can make `uclaude` / `ucodex` **non-mandatory** for bus/control-plane participation.

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

For global MCP planning, the relevant subset is:

- registration
- metadata sync
- readiness / heartbeat / activity publication
- inbox read / ack
- send / receive over bus
- report submission

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

### 6.2 Bus delivery and report control

- `dispatch_message`
- `broadcast_message`
- `poll_inbox`
- `ack_bus`
- `resolve_target`
- `report_agent_status`
  Input:
  - `subscriber_id`
  - `task_id`
  - `phase` (`start` / `progress` / `done` / `error`)
  - `message`
  - `scope` (`public` / `private`)
  Output:
  - `status`: `queued`
  - `request_id`
  - normalized `report`

`report_agent_status` should share the same normalization and queue semantics
as `ufoo report`, which currently uses:

- [src/runtime/daemon/reportControlBus.js](/Users/icy/Code/ufoo/src/runtime/daemon/reportControlBus.js:1)
- [src/coordination/report/store.js](/Users/icy/Code/ufoo/src/coordination/report/store.js:1)

It should not write into another subscriber's normal
`.ufoo/bus/queues/<subscriber>/pending.jsonl`; control events need their own
queue so ordinary bus FIFO order is never disturbed.

When called through the global MCP entrypoint, report and bus operations must
resolve a project context first. The target project daemon should remain the
writer for project-local report stores, bus queues, and activity state.

### 6.3 Controller read tools

- `read_bus_summary`
- `read_prompt_history`
- `read_open_decisions`
- `list_agents`
- `read_project_registry`

These align closely with the existing tool registry in:

- [src/tools/registry.js](/Users/icy/Code/ufoo/src/tools/registry.js:1)
- [src/tools/schemaFixtures.js](/Users/icy/Code/ufoo/src/tools/schemaFixtures.js:1)

The current registry is tiered. MCP should preserve those tier rules rather
than exposing every tool uniformly.

Recommended V1 exposure:

| Tier | MCP exposure | Tools |
|---|---|---|
| Tier 0 read | Worker and controller MCP clients | `read_bus_summary`, `read_prompt_history`, `read_open_decisions`, `list_agents`, `read_project_registry` |
| Tier 1 coordination | Authenticated worker/controller MCP clients, with caller identity checks | `route_agent`, `dispatch_message`, `ack_bus`, `remember`, `recall`, `search_memory`, `search_history`, `edit_memory`, `forget` |
| Tier 2 orchestration | Not V1 for external worker MCP clients | `launch_agent`, `rename_agent`, `close_agent`, `manage_cron` |

The initial Mode A implementation exposes only the narrow Tier 1 subset needed
for bus participation: `dispatch_message` and `ack_bus`. Memory and routing
tools remain behind later phase gates.

`rename_agent` in the shared registry is a controller orchestration operation.
It should not be confused with an external MCP client updating its own display
nickname; that belongs in `update_agent_metadata`.

## 7. Recommended Integration Modes

There should be one supported external-integration mode in V1.

### Mode A: Global MCP bridge

A globally configured MCP client starts the globally installed `ufoo` MCP
bridge command. The bridge connects to the home-scoped global controller daemon,
reads the project registry, and routes project-scoped requests to the selected
project daemon.

This should be the default integration mode for Codex, Claude, and other MCP
clients because it matches `ufoo -g` and avoids per-repository MCP server
configuration.

An already running `claude`, `codex`, or other MCP-capable process can use this
same global bridge to:

- register itself into a selected project
- polls inbox
- acks bus
- publishes activity

This is the lowest-coupling workflow and the main goal of this plan.

Wrappers remain runtime launch helpers. Later, `uclaude` / `ucodex` can keep
handling PTY/session concerns while calling the same global MCP-backed service
layer internally.

Do not add a separately documented project-local MCP deployment mode.

## 8. What Should Not Be In V1

Do not try to expose all daemon powers immediately.

V1 should **not** include:

- unrestricted process management
- direct PTY injection APIs
- full daemon restart/stop/start over MCP
- high-risk cron/process mutation beyond existing controlled ops
- internal child management hooks
- controller-only Tier 2 orchestration tools to arbitrary worker sessions

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
   - report
   - read tools

Exit criteria:

- one authoritative capability matrix exists
- no ambiguous overlap between global MCP and wrapper-only responsibilities
- runtime topology is explicit: global MCP bridge is the only V1 MCP
  deployment mode; project daemons are routed backends, not standalone MCP
  servers

## Phase 1: Global MCP bridge and daemon service layer

Goal:
add the global MCP entrypoint and extract daemon control-plane operations into
a service that can be reused by IPC and MCP.

Tasks:

1. Add a global MCP bridge command from the installed `ufoo` package.
2. Connect the bridge to the home-scoped global controller daemon by default.
3. Load project runtime rows from `src/runtime/projects/registry.js`.
4. Add routing helpers that forward project-scoped operations to target project
   daemon sockets.
5. Extract daemon operations into `src/runtime/daemon/controlPlaneService.js`
   so socket IPC and MCP call the same implementation.

Exit criteria:

- one globally configured MCP server can see the project registry
- a project-scoped MCP request can be routed to a live project daemon
- there is no project-local MCP server mode exposed to users

## Phase 2: MCP registration and presence API

Goal:
allow an external agent to become a first-class bus participant without wrapper launch.

Tasks:

1. Add global MCP server surface under the current runtime packages:
   - `src/runtime/daemon/mcpServer.js`
   - `src/runtime/daemon/controlPlaneService.js`
   - optional stable contracts in `src/runtime/contracts/`
2. Implement:
   - `register_agent`
   - `heartbeat_agent`
   - `publish_activity_state`
   - `update_agent_metadata`
   - `unregister_agent`
   - `report_agent_status`
3. Reuse existing bus metadata storage instead of inventing parallel state.
4. Ensure daemon-side registration semantics match current socket registration:
   - stable subscriber ids
   - nickname scoping
   - activity defaults

Exit criteria:

- an external MCP client can register and appear in `ufoo bus status`
- nickname and activity state show up correctly in dashboard/status views
- report submission returns `queued` and daemon consumption records the report
  without touching ordinary subscriber pending queues

## Phase 3: Bus delivery and inbox API

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
4. Keep daemon control queues separate from normal subscriber inbox queues.

Exit criteria:

- external MCP client can receive targeted work
- execute it
- reply back
- ack correctly
- stop generating unread-bus noise after ack

## Phase 4: Expose controller read tools over MCP

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
4. Keep Tier 1 and Tier 2 tools behind explicit caller-tier gates; do not
   expose controller-only orchestration tools to worker MCP sessions in V1.

Exit criteria:

- external `claude` / `codex` can fully reason over bus/controller state without shelling out to `ufoo bus` or reading files directly

## Phase 5: Converge wrappers onto global MCP service layer

Goal:
stop having separate socket-specific registration logic for wrappers and MCP clients.

Tasks:

1. Refactor `AgentLauncher.registerWithDaemon()` to target the same MCP-backed service layer.
2. Keep wrapper process-management behavior unchanged.
3. Remove duplicated control-plane serialization logic if it exists.

Exit criteria:

- `uclaude` / `ucodex` and external MCP clients share one registration/service path
- daemon registration semantics are unified

## Phase 6: External integration validation

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
   - report submission
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

1. A raw `claude` session can register via global MCP and participate in `ubus`.
2. A raw `codex` session can register via global MCP and participate in `ubus`.
3. Both appear in the same control-plane views as wrapper-launched agents.
4. `ufoo-agent` can route to them using the same bus metadata.
5. `uclaude` / `ucodex` still work unchanged during transition.
6. No MCP endpoint is required for PTY spawn/injection in V1.
7. Report/control events use a dedicated control queue and do not reorder
   ordinary bus inbox messages.
8. A globally configured MCP client can route to at least two registered
   projects without per-repository MCP configuration.

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

If global MCP exposes high-privilege process control too early, the control-plane surface becomes too broad and hard to secure.

### 11.4 Queue-ordering risk

Daemon control traffic must not be implemented by filtering ordinary
subscriber `pending.jsonl` files. A selective consumer that renames and rewrites
a normal inbox can reorder messages written concurrently by the bus. Use a
dedicated control queue, as report control does today.

### 11.5 Tool-tier leakage risk

The shared tool registry includes worker-safe reads and coordination tools, but
also controller-only orchestration tools. MCP session identity must map to the
same caller-tier checks used by the controller loop; otherwise external worker
sessions could gain launch/close/cron powers accidentally.

### 11.5.1 Caller identity and transport authentication

Network-facing authentication tokens are deferred while the MCP bridge remains a
local stdio bridge. If the bridge is exposed over SSE, WebSocket, TCP, or another
network transport, authenticated client identity is required before enabling
project-scoped tools.

Local mode still needs caller binding at the MCP session layer: a client should
only poll, ack, update metadata, report for, or unregister subscriber ids it
registered or otherwise owns. The daemon socket path also must remain protected
by private filesystem permissions, such as a user-only `.ufoo/run` directory or
equivalent socket permission hardening.

### 11.6 Global/project split-brain risk

If global MCP and daemon IPC grow separate routing or registration
semantics, a client may appear healthy in the global controller but write
reports, bus acks, or activity state into the wrong project. Global MCP should
be a routing entrypoint; the target project daemon should still own
project-local mutable state.

## 12. Recommended V1 Delivery

The smallest useful shippable version is:

1. global MCP bridge command
2. project registry read/routing
3. registration + heartbeat
4. bus send/poll/ack
5. activity publishing
6. report submission
7. Tier 0 controller read tools
8. tightly gated Tier 1 coordination tools where caller identity is clear

This is enough to make wrappers non-mandatory for collaboration.

It is not enough to replace wrappers as launch/runtime managers, and the project should state that clearly.

## 13. Final Conclusion

Yes, global MCP can cover the **full control-plane capability set** currently provided by `uclaude` / `ucodex`.

No, global MCP alone does **not** fully replace all wrapper/runtime behavior.

The right target is:

- wrappers remain optional launch helpers
- global MCP becomes the default external control-plane entrypoint
- project daemons remain the owners of project-local bus/report/activity state
- direct `claude` / `codex` sessions can register with `ufoo`, use `ubus`, and be routed by the controller without needing `uclaude` / `ucodex`
