"use strict";

/**
 * Drain Agent Loop mailbox into a turnDynamic block (never as user role).
 */

const { drainAgentMailbox, ensureMailbox } = require("./loopMailbox");

function formatAgentRuntimeEvents(events = []) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return "";
  const lines = ["Runtime events (Agent Loop mailbox; not user messages):"];
  for (const entry of list) {
    if (!entry) continue;
    if (entry.kind === "user") {
      lines.push(`- user_nudge: ${String(entry.text || "").slice(0, 400)}`);
      continue;
    }
    if (entry.kind === "runtime" && entry.event) {
      const ev = entry.event;
      const bits = [`type=${ev.type}`];
      if (ev.taskId) bits.push(`taskId=${ev.taskId}`);
      if (ev.taskRunId) bits.push(`taskRunId=${ev.taskRunId}`);
      if (ev.result && ev.result.summary) bits.push(`summary=${String(ev.result.summary).slice(0, 200)}`);
      if (ev.error && (ev.error.message || ev.error)) {
        bits.push(`error=${String(ev.error.message || ev.error).slice(0, 200)}`);
      }
      if (Array.isArray(ev.readyNodes) && ev.readyNodes.length) {
        bits.push(`readyNodes=[${ev.readyNodes.join(",")}]`);
      }
      lines.push(`- ${bits.join(" ")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Peek without drain — for inspect. Prefer drainForAgentTurn for consumption.
 */
function peekAgentMailboxText(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const box = ensureMailbox(state, "agentMailbox");
  return formatAgentRuntimeEvents(box.queue || []);
}

function drainAgentMailboxForTurn(executionState = null) {
  const events = drainAgentMailbox(executionState);
  return {
    events,
    text: formatAgentRuntimeEvents(events),
  };
}

module.exports = {
  formatAgentRuntimeEvents,
  peekAgentMailboxText,
  drainAgentMailboxForTurn,
};
