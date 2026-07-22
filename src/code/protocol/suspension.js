"use strict";

/**
 * Unified suspension / resume entry for ask_user and plan checkpoints.
 *
 * UI clients (Ink, readline) should call submitUserInteractionAnswer instead of
 * parsing answers and appending tool results themselves.
 *
 * Lifecycle: running → suspending → suspended → resuming → running | failed
 */

const {
  hasPendingUserInteraction,
  getPendingUserInteraction,
  parseUserInteractionInput,
} = require("../context/userInteraction");

const INTERACTION_EVENTS = Object.freeze([
  "interaction_requested",
  "interaction_rejected",
  "interaction_resuming",
  "assistant_delta",
  "interaction_resolved",
  "interaction_failed",
]);

function emit(onEvent, type, payload = {}) {
  if (typeof onEvent !== "function") return;
  try {
    onEvent({ type, ...payload, timestamp: new Date().toISOString() });
  } catch {
    // UI observer errors must not alter protocol state.
  }
}

/**
 * Application-layer answer submission shared by Ink and readline.
 *
 * @returns {Promise<object>} normalized resume result + display hints
 */
async function submitUserInteractionAnswer(answerText = "", state = {}, options = {}) {
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : null;
  const text = String(answerText == null ? "" : answerText);
  const trimmed = text.trim();

  if (!state || typeof state !== "object") {
    emit(onEvent, "interaction_failed", { error: "missing session state" });
    return {
      ok: false,
      code: "MISSING_STATE",
      error: "missing session state",
      waitingUserInteraction: false,
      shouldEchoSummary: false,
      events: ["interaction_failed"],
    };
  }

  if (!hasPendingUserInteraction(state.executionState)) {
    emit(onEvent, "interaction_rejected", { code: "NO_PENDING_INTERACTION" });
    return {
      ok: true,
      idempotent: true,
      code: "ALREADY_RESOLVED",
      error: "",
      summary: "",
      waitingUserInteraction: false,
      shouldEchoSummary: false,
      events: ["interaction_rejected"],
    };
  }

  // Slash commands while suspended: defined behavior — reject (except empty).
  if (/^\//.test(trimmed) && !/^\/(exit|quit)\b/i.test(trimmed)) {
    const error = "Answer the pending question first (slash commands are paused while waiting)";
    emit(onEvent, "interaction_rejected", { code: "SUSPENDED_BLOCKS_SLASH", error });
    return {
      ok: false,
      code: "SUSPENDED_BLOCKS_SLASH",
      error,
      waitingUserInteraction: true,
      shouldEchoSummary: false,
      events: ["interaction_rejected"],
    };
  }

  const pending = getPendingUserInteraction(state.executionState);
  const parsed = parseUserInteractionInput(pending, trimmed);
  if (!parsed.ok) {
    emit(onEvent, "interaction_rejected", {
      code: parsed.code || "INVALID_ANSWER",
      error: parsed.error || "Invalid reply",
    });
    return {
      ok: false,
      code: parsed.code || "INVALID_ANSWER",
      error: parsed.error || "Invalid reply",
      waitingUserInteraction: true,
      shouldEchoSummary: false,
      events: ["interaction_rejected"],
    };
  }

  emit(onEvent, "interaction_resuming", {
    interactionId: pending && pending.id ? pending.id : "",
    kind: pending && pending.kind ? pending.kind : "",
  });

  const { resumeAfterUserInteraction } = require("../agent");
  let sawStreamText = false;
  const userOnDelta = typeof options.onDelta === "function" ? options.onDelta : null;
  const result = await resumeAfterUserInteraction(trimmed, state, {
    ...options,
    onDelta: (delta) => {
      const chunk = String(delta || "");
      if (chunk && /[^\s]/.test(chunk)) sawStreamText = true;
      emit(onEvent, "assistant_delta", { text: chunk });
      if (userOnDelta) return userOnDelta(delta);
      return undefined;
    },
  });

  if (!result || result.ok === false) {
    emit(onEvent, "interaction_failed", {
      error: (result && result.error) || "resume failed",
      code: (result && result.code) || "",
    });
    return {
      ...(result || {}),
      ok: false,
      error: (result && result.error) || "resume failed",
      shouldEchoSummary: false,
      events: ["interaction_resuming", "interaction_failed"],
    };
  }

  if (result.waitingUserInteraction) {
    emit(onEvent, "interaction_requested", {
      interactionId: result.interactionId || "",
    });
    return {
      ...result,
      shouldEchoSummary: true,
      echoSummaryText: "Still waiting for your reply.",
      events: ["interaction_resuming", "interaction_requested"],
    };
  }

  emit(onEvent, "interaction_resolved", {
    interactionId: (pending && pending.id) || "",
    streamed: Boolean(result.streamed),
  });

  const streamedVisible = Boolean(result.streamed && (sawStreamText || options.streamVisible));
  return {
    ...result,
    shouldEchoSummary: Boolean(result.summary) && !streamedVisible,
    echoSummaryText: result.summary || "",
    events: ["interaction_resuming", "assistant_delta", "interaction_resolved"].filter(
      (name, index, all) => all.indexOf(name) === index
    ),
  };
}

module.exports = {
  INTERACTION_EVENTS,
  submitUserInteractionAnswer,
};
