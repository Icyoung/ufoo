# Pure Internal Agent Activity State Plan

## Context

ufoo already defines a canonical agent activity state model:

- `starting`
- `ready`
- `working`
- `idle`
- `waiting_input`
- `blocked`

`internal-pty`, terminal, and tmux agents can use `ActivityDetector` to infer state from PTY output. That approach is useful, but it is inherently heuristic because it reads rendered terminal output and prompt patterns.

Pure `internal` agents were introduced to avoid that limitation. They run through provider/thread events instead of terminal rendering, so they should use deterministic runtime events to report state.

## Current Behavior

Pure `internal` currently reports only coarse queue-level state:

- Runner startup writes `ready`.
- If there is at least one runnable event, it writes `working`.
- After all runnable events finish, it writes `idle`.

This means pure `internal` does not currently report the full canonical state model precisely:

| State | Current pure internal behavior |
| --- | --- |
| `starting` | Not reliably emitted by `internalRunner`; startup quickly becomes `ready`. |
| `ready` | Means the runner loop is up, not necessarily that provider/thread initialization has been validated. |
| `working` | Means a queued event is being processed, but does not distinguish model call, streaming, tool call, or tool execution. |
| `idle` | Means the runnable queue batch has completed. |
| `waiting_input` | Not emitted by pure `internal`. |
| `blocked` | Not emitted by pure `internal`. |

The provider/thread layer already exposes better signals:

- `thread_started`
- `turn_started`
- `text_delta`
- `tool_call`
- `tool_result`
- `turn_completed`
- `turn_failed`

The missing piece is mapping these normalized events into `activity_state` and persistent state details.

## Goals

1. Make pure `internal` state detection event-driven, not queue-inferred.
2. Preserve the existing canonical state names.
3. Report useful detail for the current phase, for example:
   - `model`
   - `responding`
   - `tool bash`
   - `waiting for approval`
4. Ensure same-state detail changes are visible to daemon status, chat dashboard, and internal agent view.
5. Avoid PTY-style text/prompt heuristics in pure `internal`.

## Non-Goals

- Do not add new canonical states unless a separate compatibility review approves it.
- Do not make pure `internal` parse terminal output.
- Do not change dashboard symbols or user-facing meanings of existing states in this slice.

## Proposed Design

### 1. Add an Internal Activity Tracker

Add `src/agent/internalActivityTracker.js`.

The tracker should consume explicit runtime events and publish canonical state:

| Runtime event | State | Detail |
| --- | --- | --- |
| `runner_starting` | `starting` | `runner` |
| `thread_ready` | `ready` | provider/model summary |
| `queue_event_started` | `working` | `queued message` |
| `model_started` or `turn_started` | `working` | `model` |
| `text_delta` | `working` | `responding` |
| `tool_call` | `working` | `tool <name>` |
| `tool_call_started` | `working` | `running tool <name>` |
| `tool_call_finished` | `working` | `tool <name> done` or `tool <name> failed` |
| `turn_completed` | `idle` | empty or `turn complete` |
| `turn_failed` recoverable | `idle` | failure summary |
| `turn_failed` unrecoverable | `blocked` | failure summary |
| explicit input request | `waiting_input` | reason |
| waiting timeout | `blocked` | timeout reason |

The tracker owns timers such as `waiting_input -> blocked`.

### 2. Persist Activity Detail

Extend activity persistence from only:

- `activity_state`
- `activity_since`

to also include:

- `activity_detail`
- `activity_phase`
- `activity_turn_id`

The status API should include these fields in `active_meta`, so chat and dashboard do not need transient fallbacks for durable state detail.

### 3. Allow Same-State Detail Updates

`createActivityStatePublisher.publish()` currently skips all updates when `state === lastState`.

For pure `internal`, this loses important transitions such as:

- `working · model`
- `working · responding`
- `working · tool bash`

Change the dedupe key from only `state` to a stable activity key:

```text
state + detail + phase + turn_id
```

If the state is unchanged but the detail or phase changed, update `activity_detail`, refresh `activity_since` only when the phase meaningfully changes, and emit `activity_state_changed`.

### 4. Wire `internalRunner` to Tracker Events

Replace the current coarse writes:

- `setActivityState("ready")`
- `setActivityState("working")`
- `setActivityState("idle")`

with tracker events:

- Before provider/thread runtime creation: `runner_starting`
- After thread runtime is available: `thread_ready`
- Before handling each runnable event: `queue_event_started`
- Inside `handleThreadedEvent()`:
  - `thread_started` or `turn_started` -> `model_started`
  - `text_delta` -> `text_delta`
  - `tool_call` -> `tool_call`
  - `tool_result` -> `tool_call_finished`
  - `turn_completed` -> `turn_completed`
  - `turn_failed` -> `turn_failed`

`handleThreadedEvent()` should accept an activity observer/tracker instead of calling publisher directly.

### 5. Define `waiting_input` for Pure Internal

Pure `internal` should only emit `waiting_input` from explicit, structured signals:

- Provider event indicates approval/user input required.
- Tool runtime returns a structured `requires_user_input` result.
- Controller loop returns a payload that cannot continue without user input.
- Interactive agent-view session has an open multi-line input request.

Do not infer `waiting_input` from arbitrary response text.

When `waiting_input` lasts beyond a configured timeout, emit:

- `blocked`
- detail: `waiting_input timeout`

### 6. Keep UI Read-Only

Chat UI and internal agent view should display state and detail from daemon status:

- `activity_state`
- `activity_since`
- `activity_detail`
- `activity_phase`

UI should not infer canonical state. It can keep transient state only as a short bridge while waiting for daemon status refresh.

## Implementation Phases

### Phase 1: Persistence and Publisher

- Extend `writeActivityState()` to accept detail/phase/turn id.
- Extend `createActivityStatePublisher()` dedupe key.
- Extend `daemon/status.js` active metadata fields.
- Add tests for same-state detail updates.

### Phase 2: Tracker

- Add `internalActivityTracker`.
- Unit test event-to-state mapping.
- Unit test waiting timeout behavior.

### Phase 3: Internal Runner Integration

- Replace coarse queue-level state writes with tracker events.
- Wire thread/provider events from `handleThreadedEvent()`.
- Preserve current stream forwarding behavior.
- Add tests for:
  - startup -> ready
  - event start -> working
  - text delta -> working/responding
  - tool call -> working/tool detail
  - turn completed -> idle
  - turn failed -> idle or blocked

### Phase 4: UI and Status

- Show durable `activity_detail` in internal agent view.
- Prefer daemon status detail over transient detail.
- Keep transient detail only as a short-lived bridge.

## Acceptance Criteria

- Pure `internal` startup emits `starting`, then `ready` only after provider/thread runtime is available.
- Sending a message emits `working` immediately.
- Model streaming updates detail to `responding`.
- Tool calls update detail to `tool <name>` without losing `working`.
- Turn completion reliably returns to `idle`.
- Provider failure does not leave the agent stuck in `working`.
- `waiting_input` is only emitted from structured runtime/tool signals.
- `waiting_input` timeout transitions to `blocked`.
- `activity_detail` survives daemon status refresh and is visible in chat/internal agent view.
- `internal-pty` and terminal/tmux behavior remains unchanged.

## Risk Notes

- Same-state updates may increase bus status events. Deduping by `state/detail/phase/turn_id` should keep this bounded.
- Some providers may not emit all event types. The tracker should degrade gracefully:
  - no `turn_started`: use first `text_delta` as `working/responding`
  - no `tool_result`: keep `working/tool <name>` until `turn_completed`
  - no structured input-required event: do not guess `waiting_input`
- `blocked` semantics should be conservative. It is worse to mark an active turn blocked than to leave it `working` with a clear detail.
