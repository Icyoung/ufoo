"use strict";

function replayTurnMessages(request, event) {
  const messages = [];
  const result = event.result;
  if (Array.isArray(result?.messages) && Number.isInteger(result.historyOffset)) {
    messages.push(...result.messages.filter(message => message.role !== "system").slice(result.historyOffset));
  } else {
    messages.push({ role: "user", content: request?.text });
    if (Array.isArray(result?.turnItems)) messages.push(...result.turnItems);
    else if (result?.text) messages.push({ role: "assistant", content: result.text });
    else messages.push({ role: "assistant", content: `Previous request ended ${event.type.split(".")[1]}: ${event.error || "no verified result"}` });
  }
  return messages;
}

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
    if (event.type === "task.cancelled" && event.error === "interaction_dismissed") continue;
    history.push(...replayTurnMessages(request, event));
  }
  return history;
}

function stripProviderSpecificFields(message, { stripResponsesContinuation = false, stripThinkingBlocks = false } = {}) {
  if (!message || typeof message !== "object") return message;
  let next = message;
  if (stripResponsesContinuation && Object.prototype.hasOwnProperty.call(next, "responsesContinuation")) {
    const { responsesContinuation: _ignored, ...rest } = next;
    next = rest;
  }
  if (stripThinkingBlocks && Array.isArray(next.content)) {
    const filtered = next.content
      .filter((block) => block && block.type !== "thinking" && block.type !== "redacted_thinking")
      .map((block) => {
        if (block && typeof block === "object" && (block.thoughtSignature || block.signatureModel)) {
          const { thoughtSignature: _ts, signatureModel: _sm, ...cleanBlock } = block;
          return cleanBlock;
        }
        return block;
      });
    next = { ...next, content: filtered };
  }
  if (stripThinkingBlocks && Object.prototype.hasOwnProperty.call(next, "reasoning_content")) {
    const { reasoning_content: _rc, ...rest } = next;
    next = rest;
  }
  return next;
}

function sanitizeHistoryForTransport(history = [], targetTransport = "") {
  const normalized = String(targetTransport || "").trim().toLowerCase();
  const stripResponsesContinuation = normalized !== "openai-responses" && normalized !== "codex-responses";
  const stripThinkingBlocks = normalized !== "anthropic-messages" && normalized !== "antigravity";
  if (!stripResponsesContinuation && !stripThinkingBlocks) return history;
  return history.map((msg) => stripProviderSpecificFields(msg, { stripResponsesContinuation, stripThinkingBlocks }));
}

module.exports = { replayHistory, replayTurnMessages, sanitizeHistoryForTransport };
