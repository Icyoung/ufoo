"use strict";

/** Derive full conversation inputs from accepted requests and terminal events. */
function replayHistory(events = [], excludeTask = "") {
  const requests = new Map();
  const terminal = new Map();
  for (const event of events) {
    if (event.type === "request.accepted") requests.set(event.taskRunId, event.request);
    if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(event.type)) terminal.set(event.taskRunId, event);
  }
  const history = [];
  for (const [id, request] of requests) {
    const event = terminal.get(id);
    if (id === excludeTask || !event) continue;
    const result = event.result;
    if (Array.isArray(result?.messages) && Number.isInteger(result.historyOffset)) {
      history.push(...result.messages.filter(message => message.role !== "system").slice(result.historyOffset));
    } else {
      history.push({ role: "user", content: request.text });
      if (Array.isArray(result?.turnItems)) history.push(...result.turnItems);
      else if (result?.text) history.push({ role: "assistant", content: result.text });
      else history.push({ role: "assistant", content: `Previous request ended ${event.type.split(".")[1]}: ${event.error || "no verified result"}` });
    }
  }
  return history;
}

module.exports = { replayHistory };
