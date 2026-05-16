"use strict";

/**
 * Generic agent activity tracker.
 *
 * Maps high-level lifecycle hooks and normalized provider stream events to the
 * canonical activity model (`starting`/`ready`/`working`/`idle`/`waiting_input`/`blocked`)
 * plus a short detail string (e.g. `thinking`, `tool bash`). Publishes through
 * an injected publisher so the same tracker can be reused by internal,
 * internal-pty, or future runner shapes.
 *
 * Design contract:
 *  - The tracker never reads PTY text or guesses state from prose. All state
 *    transitions come from explicit hook calls (`notify*`, `request*`,
 *    `mark*`) or from normalized provider events.
 *  - Detail is best-effort: callers can override it on `notifyTurnStart` /
 *    `markIdle` if they want a custom phrasing.
 *  - The tracker stays passive about `waiting_input` and `blocked`. They are
 *    intentionally exposed as explicit methods (`requestUserInput`,
 *    `markBlocked`) and have no auto-trigger from the provider stream — those
 *    states should only fire from structured runtime signals.
 */
function createActivityTracker({ publisher } = {}) {
  if (!publisher || typeof publisher.publish !== "function") {
    throw new Error("createActivityTracker requires a publisher with publish()");
  }

  let currentState = "";
  let currentDetail = "";
  let currentTurnId = "";

  function emit(state, detail = "", publishOptions = {}) {
    const normalizedDetail = String(detail || "");
    if (state === currentState && normalizedDetail === currentDetail) return false;
    const previous = currentState;
    const ok = publisher.publish(state, {
      detail: normalizedDetail,
      previous,
    }, publishOptions);
    if (!ok) return false;
    currentState = state;
    currentDetail = normalizedDetail;
    return true;
  }

  function compactToolName(name) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return "tool";
    if (trimmed.length <= 32) return trimmed;
    return `${trimmed.slice(0, 29)}...`;
  }

  function notifyStarting(detail = "runner") {
    emit("starting", detail);
  }

  function notifyReady(detail = "") {
    emit("ready", detail);
  }

  function notifyTurnStart(detail = "thinking") {
    emit("working", detail);
  }

  function markIdle(detail = "") {
    emit("idle", detail, { force: true });
  }

  function requestUserInput(reason = "") {
    emit("waiting_input", reason);
  }

  function clearUserInput(detail = "") {
    if (currentState !== "waiting_input") return;
    emit("idle", detail, { force: true });
  }

  function markBlocked(reason = "") {
    emit("blocked", reason);
  }

  function onProviderEvent(event = {}) {
    const type = event && typeof event === "object" ? String(event.type || "") : "";
    if (!type) return;

    if (type === "thread_started") {
      // Provider acknowledged the thread; wait for the first turn to flip to working.
      return;
    }

    if (type === "turn_started") {
      currentTurnId = String(event.turnId || event.turn_id || "");
      emit("working", "thinking");
      return;
    }

    if (type === "text_delta") {
      // First text delta on a turn that didn't emit turn_started still counts as working.
      if (currentState !== "working") {
        emit("working", "thinking");
      }
      return;
    }

    if (type === "tool_call") {
      emit("working", `tool ${compactToolName(event.name)}`);
      return;
    }

    if (type === "tool_result") {
      // Keep `tool <name>` until the next event (text_delta or another tool_call)
      // shifts the detail. This avoids a flap back to `thinking` for a single frame.
      return;
    }

    if (type === "turn_completed") {
      currentTurnId = "";
      emit("idle", "", { force: true });
      return;
    }

    if (type === "turn_failed") {
      currentTurnId = "";
      // Default policy: drop back to idle. Callers that want `blocked` semantics
      // for unrecoverable failures should call markBlocked() explicitly.
      emit("idle", "", { force: true });
    }
  }

  function getState() {
    return { state: currentState, detail: currentDetail, turnId: currentTurnId };
  }

  return {
    notifyStarting,
    notifyReady,
    notifyTurnStart,
    markIdle,
    requestUserInput,
    clearUserInput,
    markBlocked,
    onProviderEvent,
    getState,
  };
}

module.exports = { createActivityTracker };
