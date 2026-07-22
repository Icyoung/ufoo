"use strict";

/**
 * Ordered Agent Loop events for UI clients (R8).
 * Distinct from runtime/runtimeEvents.js (TaskRun wakeup mail).
 */

const LOOP_EVENT_TYPES = Object.freeze([
  "thinking_delta",
  "assistant_delta",
  "tool_start",
  "tool_result",
  "artifact_persisted",
  "interaction_requested",
  "interaction_rejected",
  "interaction_resuming",
  "interaction_resolved",
  "interaction_failed",
  "plan_transition",
  "task_run_transition",
  "final_assistant_message",
  "final_summary",
  "error",
]);

function createLoopEvent(type = "", payload = {}, {
  sessionId = "",
  runId = "",
  sequence = 0,
  eventId = "",
} = {}) {
  const eventType = String(type || "").trim();
  if (!LOOP_EVENT_TYPES.includes(eventType)) {
    throw new Error(`unknown loop event type: ${type}`);
  }
  return {
    eventId: String(eventId || `le_${Date.now().toString(36)}_${sequence}`),
    sequence: Number(sequence) || 0,
    sessionId: String(sessionId || ""),
    runId: String(runId || ""),
    type: eventType,
    payload: payload && typeof payload === "object" ? payload : {},
    timestamp: new Date().toISOString(),
  };
}

/**
 * UI display policy: whether to echo a final summary after streaming.
 * Prefer final_summary / final_assistant_message events when present.
 */
function resolveSummaryDisplayPolicy({
  streamed = false,
  sawVisibleText = false,
  finalEventType = "",
} = {}) {
  const finalType = String(finalEventType || "").trim();
  if (finalType === "final_assistant_message" || finalType === "final_summary") {
    return { echoSummary: true, reason: "explicit_final_event" };
  }
  if (streamed && sawVisibleText) {
    return { echoSummary: false, reason: "already_streamed" };
  }
  return { echoSummary: true, reason: "fallback_summary" };
}

function createLoopEventLog({ sessionId = "", runId = "" } = {}) {
  const events = [];
  let sequence = 0;
  const seen = new Set();

  function push(type, payload = {}) {
    sequence += 1;
    const event = createLoopEvent(type, payload, {
      sessionId,
      runId,
      sequence,
    });
    if (seen.has(event.eventId)) return null;
    seen.add(event.eventId);
    events.push(event);
    return event;
  }

  function replayFrom(sequenceCheckpoint = 0) {
    const min = Number(sequenceCheckpoint) || 0;
    return events.filter((e) => e.sequence > min);
  }

  return {
    push,
    replayFrom,
    list: () => events.slice(),
    get sequence() { return sequence; },
  };
}

module.exports = {
  LOOP_EVENT_TYPES,
  createLoopEvent,
  createLoopEventLog,
  resolveSummaryDisplayPolicy,
};
