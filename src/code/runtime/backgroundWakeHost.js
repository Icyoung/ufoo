"use strict";

const { createRuntimeHooks, formatWakeEvent } = require("../../agents/runtime/tasks/hooks");
const { createRuntimeStore } = require("../../agents/runtime/context/runtimeStore");
const { createBackgroundHookSource } = require("../../agents/capabilities/coding/backgroundHooks");
const { hasPendingUserInteraction } = require("../context/userInteraction");

/** A coding host outlives individual native loops and binds wakes to an exact session. */
function createUcodeWakeHost({ state, canDeliver = () => true, deliver, onError = () => {} }) {
  let hooks = null;
  let identity = "";
  let closed = false;
  let timer = null;
  function current() {
    if (closed || !state.sessionId || !state.workspaceRoot) return null;
    const next = JSON.stringify([state.workspaceRoot, state.sessionId]);
    if (next === identity) return hooks;
    hooks?.close();
    hooks = null;
    hooks = createRuntimeHooks({
      store: createRuntimeStore({ workspaceRoot: state.workspaceRoot, namespace: "ucode-hooks", sessionId: state.sessionId }),
      sources: { background: createBackgroundHookSource(state.workspaceRoot) },
      canDeliver: () => !closed && next === JSON.stringify([state.workspaceRoot, state.sessionId]) && !hasPendingUserInteraction(state.executionState) && canDeliver(),
      deliver: (event, claim) => deliver(event, claim, formatWakeEvent(event)), onError,
    });
    identity = next;
    hooks.start();
    return hooks;
  }
  Object.defineProperty(state, "runtimeHooks", { configurable: true, enumerable: false, get: current });
  const api = {
    get hooks() { return current(); },
    async tick() { return current()?.tick(); },
    start() {
      if (timer || closed) return;
      current();
      timer = setInterval(() => { try { current(); } catch (error) { onError(error); } }, 500);
      timer.unref?.();
    },
    close() { closed = true; clearInterval(timer); hooks?.close(); },
  };
  return api;
}

module.exports = { createUcodeWakeHost };
