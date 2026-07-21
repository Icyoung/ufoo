"use strict";

/**
 * Typed mailboxes for Agent Loop vs TaskLoop.
 * Task mailbox schema has no user-event type (runtime isolation).
 */

const { isRuntimeEvent } = require("./runtimeEvents");

const AGENT_EVENT_KINDS = Object.freeze(["user", "runtime"]);
const TASK_EVENT_KINDS = Object.freeze([
  "graph_yield",
  "tool_result",
  "control",
  "advance",
  "model_turn",
]);

function emptyMailbox() {
  return { queue: [], seq: 0 };
}

function ensureMailbox(store = null, key = "mailbox") {
  const target = store && typeof store === "object" ? store : {};
  if (!target[key] || typeof target[key] !== "object") {
    target[key] = emptyMailbox();
  }
  if (!Array.isArray(target[key].queue)) target[key].queue = [];
  if (!Number.isFinite(target[key].seq)) target[key].seq = 0;
  return target[key];
}

function enqueue(mailbox = null, event = {}) {
  const box = mailbox && typeof mailbox === "object" ? mailbox : emptyMailbox();
  if (!Array.isArray(box.queue)) box.queue = [];
  box.seq = (Number(box.seq) || 0) + 1;
  const entry = {
    id: `evt_${box.seq}`,
    enqueuedAt: new Date().toISOString(),
    ...event,
  };
  box.queue.push(entry);
  return entry;
}

function drain(mailbox = null, { max = 0 } = {}) {
  const box = mailbox && typeof mailbox === "object" ? mailbox : emptyMailbox();
  if (!Array.isArray(box.queue) || box.queue.length === 0) return [];
  if (!max || max >= box.queue.length) {
    const all = box.queue.slice();
    box.queue = [];
    return all;
  }
  const taken = box.queue.splice(0, Math.max(1, Math.floor(max)));
  return taken;
}

function peek(mailbox = null) {
  const box = mailbox && typeof mailbox === "object" ? mailbox : emptyMailbox();
  return Array.isArray(box.queue) && box.queue.length > 0 ? box.queue[0] : null;
}

function enqueueAgentUser(executionState = null, text = "") {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const mailbox = ensureMailbox(state, "agentMailbox");
  return enqueue(mailbox, {
    kind: "user",
    text: String(text || "").trim(),
  });
}

function enqueueAgentRuntime(executionState = null, runtimeEvent = {}) {
  if (!isRuntimeEvent(runtimeEvent)) {
    throw new Error("enqueueAgentRuntime requires a runtime event");
  }
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const mailbox = ensureMailbox(state, "agentMailbox");
  return enqueue(mailbox, {
    kind: "runtime",
    event: runtimeEvent,
  });
}

function enqueueTaskEvent(executionState = null, taskRunId = "", event = {}) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  if (!state.taskMailboxes || typeof state.taskMailboxes !== "object") {
    state.taskMailboxes = {};
  }
  const id = String(taskRunId || "").trim();
  if (!id) throw new Error("taskRunId required");
  const kind = String(event.kind || "").trim();
  if (!TASK_EVENT_KINDS.includes(kind)) {
    throw new Error(`invalid task mailbox event kind: ${kind}`);
  }
  if (!state.taskMailboxes[id]) state.taskMailboxes[id] = emptyMailbox();
  return enqueue(state.taskMailboxes[id], event);
}

function drainAgentMailbox(executionState = null, options = {}) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  return drain(ensureMailbox(state, "agentMailbox"), options);
}

function drainTaskMailbox(executionState = null, taskRunId = "", options = {}) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const id = String(taskRunId || "").trim();
  if (!state.taskMailboxes || !state.taskMailboxes[id]) return [];
  return drain(state.taskMailboxes[id], options);
}

module.exports = {
  AGENT_EVENT_KINDS,
  TASK_EVENT_KINDS,
  emptyMailbox,
  ensureMailbox,
  enqueue,
  drain,
  peek,
  enqueueAgentUser,
  enqueueAgentRuntime,
  enqueueTaskEvent,
  drainAgentMailbox,
  drainTaskMailbox,
};
