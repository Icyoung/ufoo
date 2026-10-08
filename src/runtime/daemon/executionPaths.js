"use strict";

const fs = require("fs");
const path = require("path");
const { createRuntimeStore } = require("../../agents/runtime");

/** Persist one executor per conversation. Old controller transcripts stay on their path. */
function createExecutionPathSelector(projectRoot) {
  const store = createRuntimeStore({ workspaceRoot: projectRoot, namespace: "controller-path", sessionId: "paths" });
  return function select({ sessionId = "main-default", requestedMode, mode }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,100}$/.test(sessionId)) throw new Error("invalid session identity");
    let selected;
    store.transaction((state) => {
      const value = state.capabilityState["execution-path"]?.value || { sessions: {} };
      selected = Object.hasOwn(value.sessions, sessionId) ? value.sessions[sessionId] : "";
      if (selected) {
        if (requestedMode && requestedMode !== selected) throw Object.assign(new Error(`session uses ${selected}; use /session new before changing its executor`), { code: "session_path_pinned" });
        return [];
      }
      const oldHistory = path.join(projectRoot, ".ufoo", "agent", "ufoo-agent.history.jsonl");
      const newHistory = path.join(projectRoot, ".ufoo", "agent", "main", "runtimes", sessionId, "events.jsonl");
      selected = sessionId === "main-default" && fs.existsSync(oldHistory) && !fs.existsSync(newHistory) ? "legacy" : mode;
      value.sessions[sessionId] = selected;
      return [{ type: "capability.state_committed", capabilityId: "execution-path", version: 1, value }];
    });
    return selected;
  };
}

module.exports = { createExecutionPathSelector };
