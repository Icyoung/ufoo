## Agent -> ufoo-agent Control Plane

Status: implemented

## Implementation Audit (2026-04-26)

This protocol is implemented. Group bootstrap tells workers to use direct
handoff for downstream delivery and private `ufoo report` updates for
controller observability. `promptRequest` injects private reports into
controller prompt context, and tests cover private report prompt injection plus
duplicate handoff prevention instructions.

### Goal

Allow group workers to report status, blockers, and handoff outcomes to `ufoo-agent` without causing duplicate downstream delivery.

### Problem

Workers already support direct handoff to the next agent.

If a worker both:

- hands off directly to the downstream agent, and
- sends the same intent to `ufoo-agent`

then `ufoo-agent` can mistakenly forward the same handoff a second time.

### Design

Split coordination into two planes.

1. Data plane

- Worker-to-worker delivery.
- Use direct handoff to the next agent.
- Ownership of delivery stays with the current worker.

2. Control plane

- Worker-to-`ufoo-agent` reporting.
- Use `ufoo report ... --scope private --controller ufoo-agent`.
- `ufoo-agent` observes state, blockers, and handoff outcomes.
- `ufoo-agent` does not re-deliver a handoff unless the worker explicitly asks for dispatch help.

### Contract

When a worker already delivered a handoff directly, it should report that fact instead of asking `ufoo-agent` to forward it.

Recommended report metadata:

```json
{
  "handoff": {
    "target": "architect",
    "status": "delivered"
  },
  "needs_dispatch": false
}
```

When a worker wants `ufoo-agent` to perform delivery or re-routing, it must say so explicitly:

```json
{
  "handoff": {
    "target": "architect",
    "status": "pending"
  },
  "needs_dispatch": true
}
```

### Runtime Rules

- `handoff.status=delivered` means the worker already completed downstream delivery.
- `needs_dispatch=false` means `ufoo-agent` must not forward that handoff again.
- `needs_dispatch=true` means `ufoo-agent` may decide whether to dispatch, re-route, or ask for clarification.

### Implementation

1. Group bootstrap tells workers to:
- use direct handoff for downstream delivery
- use private `ufoo report` for control-plane updates
- avoid asking `ufoo-agent` to forward an already delivered handoff

2. `ufoo-agent` prompt assembly adds controller-side instructions:
- private runtime reports are observability input
- reports with delivered handoff metadata must not cause duplicate dispatch
- only reports with `needs_dispatch=true` should be treated as dispatch requests

3. Private reports wake the controller:
- after a private report is recorded, daemon sends a best-effort `bus wake` to `ufoo-agent`
- this does not inject text into the current controller turn
- it only nudges the controller loop to process inbox sooner at a safe point

### Example

Direct handoff to architect, then private control-plane report:

```bash
ufoo bus send architect "Scoped brief complete. See assumptions A/B/C."

ufoo report done "Discovery brief delivered to architect" \
  --task discovery-brief \
  --scope private \
  --controller ufoo-agent \
  --meta '{"handoff":{"target":"architect","status":"delivered"},"needs_dispatch":false}'
```

Dispatch requested from controller:

```bash
ufoo report progress "Need controller to route scope challenge" \
  --task scope-review \
  --scope private \
  --controller ufoo-agent \
  --meta '{"handoff":{"target":"challenger","status":"pending"},"needs_dispatch":true}'
```
