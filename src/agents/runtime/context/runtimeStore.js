"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { withFileLock } = require("./fileLock");

const copy = (value) => JSON.parse(JSON.stringify(value));
const validId = (value) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(String(value || ""));

function trimTornAppend(fd) {
  let end = fs.fstatSync(fd).size;
  if (!end) return;
  const last = Buffer.alloc(1);
  fs.readSync(fd, last, 0, 1, end - 1);
  if (last[0] === 10) return;
  while (end > 0) {
    const start = Math.max(0, end - 4096);
    const tail = Buffer.alloc(end - start);
    fs.readSync(fd, tail, 0, tail.length, start);
    const newline = tail.lastIndexOf(10);
    if (newline >= 0) { fs.ftruncateSync(fd, start + newline + 1); return; }
    end = start;
  }
  fs.ftruncateSync(fd, 0);
}

function projectEvent(state, event) {
  state.sequence = event.sequence;
  if (event.type === "runtime.opened") state.owner = event.owner;
  if (event.type === "runtime.opened" && !state.profile) state.profile = event.owner.profile;
  if (event.type === "runtime.opened" && !state.capabilities) state.capabilities = event.owner.capabilities;
  if (event.type === "runtime.closed") state.owner = null;
  if (event.type === "runtime.binding") state.binding = event.binding;
  if (event.type === "capability.state_committed") state.capabilityState[event.capabilityId] = { version: event.version, value: event.value };
  if (event.type === "command.started") state.commands[event.commandId] = { ...event, status: "uncertain" };
  if (event.type === "command.resolved") Object.assign(state.commands[event.commandId], { status: "resolved", result: event.result });
  if (event.type === "request.accepted") {
    state.requests[event.request.requestId] = event.taskRunId;
    state.tasks[event.taskRunId] = { taskRunId: event.taskRunId, request: event.request, status: "queued", effects: {}, sequence: event.sequence };
  }
  const task = state.tasks[event.taskRunId];
  if (!task) return;
  if (event.type === "task.started") Object.assign(task, { status: "running", attemptId: event.attemptId });
  if (event.type === "tool.started") task.effects[event.toolCallId] = { toolName: event.toolName, status: "uncertain" };
  if (event.type === "tool.completed") delete task.effects[event.toolCallId];
  if (event.type === "task.paused") Object.assign(task, { status: "waiting_user", result: event.result, interactionId: event.result.interactionId });
  if (event.type === "interaction.answered") {
    const callId = task.result?.executionState?.pendingUserInteraction?.resume?.toolCallId;
    if (callId) delete task.effects[callId];
    Object.assign(task, { status: "queued", answer: event.answer, answeredInteractionId: event.interactionId });
  }
  if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(event.type)) {
    const result = event.result ? { text: event.result.text, usage: event.result.usage, toolCallsExecuted: event.result.toolCallsExecuted,
      streamed: event.result.streamed } : null;
    // Full terminal transcripts remain in the journal; projections carry only summaries.
    Object.assign(task, { status: event.type.split(".")[1], result, error: event.error || "", interactionId: "" });
  }
  task.sequence = event.sequence;
}

/** Append-only truth; snapshot is a replaceable projection. No await under the lock. */
function createRuntimeStore({ workspaceRoot, namespace = "runtime", sessionId, redact = (value) => value } = {}) {
  if (!validId(namespace) || !validId(sessionId)) throw new Error("invalid runtime store identity");
  const directory = path.join(path.resolve(workspaceRoot), ".ufoo", "agent", namespace, "runtimes", sessionId);
  const journal = path.join(directory, "events.jsonl");
  const projection = path.join(directory, "snapshot.json");
  let cache = null;
  function journalStamp() {
    try { const stat = fs.statSync(journal); return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
    catch (error) { if (error.code === "ENOENT") return "missing"; throw error; }
  }
  function readEvents() {
    const stamp = journalStamp();
    if (cache && cache.stamp === stamp) return cache.events;
    if (stamp === "missing") { cache = { stamp, events: [], state: null }; return cache.events; }
    const text = fs.readFileSync(journal, "utf8");
    const lines = text.split("\n");
    // A torn final append is never interpreted as a committed event.
    lines.pop();
    const events = lines.filter(Boolean).map((line, index) => {
      const event = JSON.parse(line);
      if (event.sequence !== index + 1) throw new Error("runtime journal sequence mismatch");
      return event;
    });
    cache = { stamp, events, state: null }; return events;
  }
  function replay(events) {
    if (cache && cache.events === events && cache.state) return copy(cache.state);
    const state = { version: 1, sessionId, namespace, sequence: 0, owner: null, profile: "", requests: {}, tasks: {}, commands: {}, capabilityState: {} };
    events.forEach((event) => projectEvent(state, event));
    if (cache && cache.events === events) cache.state = copy(state);
    return state;
  }
  function transaction(mutator) {
    return withFileLock(journal, () => {
      const events = readEvents();
      const state = replay(events);
      const additions = mutator(copy(state)) || [];
      if (!Array.isArray(additions)) throw new Error("runtime transaction must return events");
      if (!additions.length) return state;
      fs.mkdirSync(directory, { recursive: true });
      const committed = additions.map((event, index) => ({ ...redact(event), sequence: state.sequence + index + 1, eventId: randomUUID(), time: new Date().toISOString() }));
      const fd = fs.openSync(journal, "a+", 0o600);
      try { trimTornAppend(fd); fs.writeSync(fd, committed.map((event) => JSON.stringify(event)).join("\n") + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      committed.forEach((event) => projectEvent(state, event));
      events.push(...committed);
      cache = { stamp: journalStamp(), events, state: copy(state) };
      const temporary = `${projection}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(temporary, projection);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return state;
    });
  }
  return Object.freeze({ directory, journal,
    read: () => replay(readEvents()),
    events: ({ after = 0 } = {}) => copy(readEvents().filter((event) => event.sequence > after)),
    transaction,
    append: (event) => transaction(() => [event]),
  });
}

module.exports = { createRuntimeStore, projectEvent };
