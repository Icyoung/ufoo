# Delivery Queue Developer Guide

This document is the implementation guide for moving bus delivery callers to
the unified queue path.

`docs/` is not the repository source of truth for architecture. Keep public
package maps in `PROJECT.md` or `README.md` when source ownership changes.

## Source Of Truth

Use `src/coordination/bus/deliveryQueue.js` for all pending-message storage and
claim handling.

Do not add new code that renames `pending.jsonl` to `.processing.*` directly.
Consumers must use:

```js
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");

const queue = new DeliveryQueue(pendingFile);
const claim = queue.claimNext();
if (!claim) return;

try {
  await handle(claim.event);
  queue.completeClaim(claim);
} catch (err) {
  queue.restoreClaim(claim);
  throw err;
}
```

`claimNext()` recovers only recoverable `.processing.*` files before taking the
next event, writes the claimed event to a processing file, and removes it from
`pending.jsonl`. A processing file with a live owner pid is treated as an active
delivery claim and must not be recovered by another read or claim operation.
`completeClaim()` deletes the processing file. `restoreClaim()` puts the event
back into pending and then deletes the processing file.

## Queue Envelope

All queued events should be normalized with `normalizeQueueEnvelope()` unless
they go through `EventBus.send()` or `QueueManager.appendPending()`, which
already normalize.

The envelope fields are:

- `queue_type`: semantic lane, such as `agent_message`, `daemon_control`, or
  `report`.
- `delivery`: how the event should be consumed.
- `ack`: when the event can be considered handled.

Common modes:

- `inject`: daemon delivery scheduler injects into an idle terminal agent.
- `daemon_consume`: daemon-owned queue, consumed by daemon code.
- `self_consume`: agent process consumes its own queue.
- `notify_only`: wake or UI notification event, no message injection.

## Producers

Normal agent-to-agent messages should use `EventBus.send()`. It resolves scoped
nicknames, appends the event log, and appends per-target pending events.

Subscriber queues should be appended through `QueueManager.appendPending()`.
Mailbox acknowledgements should use `QueueManager.ackPending()`, which consumes
each pending event through `DeliveryQueue.claimNext()` and
`completeClaim()`. Do not acknowledge a mailbox by truncating `pending.jsonl`
from message/bus code.

Dedicated daemon/control lanes should use `DeliveryQueue.append()` with an
explicit envelope:

```js
const {
  DeliveryQueue,
  QUEUE_TYPES,
  normalizeQueueEnvelope,
} = require("../../coordination/bus/deliveryQueue");

const event = normalizeQueueEnvelope(rawEvent, {
  queueType: QUEUE_TYPES.REPORT,
  delivery: { mode: "daemon_consume", gate: "none", max_inflight: 1 },
  ack: { policy: "on_consume" },
});

new DeliveryQueue(pendingFile).append(event);
```

Do not use `appendJSONL()` for pending delivery queues. It is still fine for
append-only logs that are not delivery queues.

## Consumers

Use one claim per event. Complete only after the side effect has succeeded.
Restore when the side effect failed and the event should be retried.

Current consumers:

- `src/runtime/daemon/deliveryScheduler.js`: injects `agent_message` events into
  idle terminal-backed agents.
- `src/coordination/bus/queue.js`: acknowledges mailbox events through
  `QueueManager.ackPending()`.
- `src/runtime/daemon/index.js`: daemon bridge consumes its own subscriber
  queue.
- `src/runtime/daemon/reportControlBus.js`: report control lane consumes
  daemon-owned report events.
- `src/agents/launch/ptyRunner.js`: PTY runner self-consumes queued messages.
- `src/agents/internal/internalRunner.js`: internal runner self-consumes queued
  messages.
- `src/code/agent.js`: native ucode `ubus` consumes its own queued messages.
- `src/agents/launch/notifier.js`: transition helper for direct pending
  delivery.

## Idle-Gated Injection

External terminal agents should not receive injected input while they are busy.
The daemon delivery scheduler checks agent metadata and activity state before
claiming. If the agent is not `idle` or `ready`, the queue remains untouched and
delivery is retried on the next scheduler tick.

This is the preferred behavior for Codex, Claude Code, and other terminal
adapters that support notifier injection.

## Ordering

`DeliveryQueue` preserves FIFO for unsequenced events and sorts positive `seq`
values during recovery/restore. Duplicate positive sequence numbers keep the
first observed event. This keeps crash recovery deterministic without requiring
every producer to allocate a sequence.

## Migration Checklist

When migrating a caller:

1. Replace direct `pending.jsonl` rename/read/remove logic with
   `DeliveryQueue.claimNext()`.
2. Complete successful events with `completeClaim()`.
3. Restore retryable failures with `restoreClaim()`.
4. Drop invalid or unsupported events by completing their claim.
5. Normalize newly appended queue events with `normalizeQueueEnvelope()`.
6. Add a focused test for success, retry/restore, and empty queue behavior.

Useful checks:

```sh
npm test -- --runTestsByPath test/unit/bus/deliveryQueue.test.js
npm test -- --runTestsByPath test/unit/daemon/deliveryScheduler.test.js
npm test -- --runTestsByPath test/unit/daemon/reportControlBus.test.js
npm test -- --runTestsByPath test/unit/code/ucodeCoreAgent.test.js
```
