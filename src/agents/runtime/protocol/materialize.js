"use strict";

/**
 * Materialize Provider tool-result messages from a resolved ledger turn.
 * Business branches must resolve on the ledger; they must not hand-write
 * unpaired tool results.
 */

const { listCalls } = require("./toolCallLedger");

/**
 * Clip helper kept local so protocol does not depend on nativeRunner.
 */
function clipText(value = "", maxChars = 12000) {
  const text = String(value == null ? "" : value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function toJsonString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {object} ledger
 * @param {{
 *   transport: object,
 *   messages: object[],
 *   pendingById: Record<string, object>,
 * }} opts
 * @returns {{ appended: number, flushed: boolean }}
 */
function materializeResolvedToolResults(ledger, {
  transport = null,
  messages = [],
  pendingById = {},
} = {}) {
  if (!ledger || !transport || typeof transport.appendToolResult !== "function") {
    return { appended: 0, flushed: false };
  }

  const collected = [];
  let appended = 0;
  for (const call of listCalls(ledger)) {
    if (call.state !== "resolved") continue;
    const pending = pendingById[call.callId];
    if (!pending) continue;
    transport.appendToolResult({
      messages,
      collected,
      call: pending,
      toolResult: call.resultPayload,
    });
    appended += 1;
  }

  let flushed = false;
  if (
    collected.length > 0
    && typeof transport.flushToolResults === "function"
  ) {
    transport.flushToolResults({ messages, collected });
    flushed = true;
  }
  return { appended, flushed };
}

/**
 * Append a single resume answer as a tool result (idempotent via ledger resolve).
 */
function materializeAnswerToolResult(messages = [], resume = null, answer = {}, {
  clip = clipText,
} = {}) {
  const call = resume && resume.call ? resume.call : null;
  if (!call || !call.source) return { ok: false, error: "missing deferred tool call" };
  const transportName = String(resume.transport || "openai-chat");
  const content = clip(toJsonString(answer), 12000);
  if (transportName === "anthropic-messages") {
    messages.push({
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: String(call.source.id || resume.toolCallId || ""),
        content,
        is_error: false,
      }],
    });
  } else {
    messages.push({
      role: "tool",
      tool_call_id: String(call.source.id || resume.toolCallId || ""),
      content,
    });
  }
  return { ok: true };
}

module.exports = {
  materializeResolvedToolResults,
  materializeAnswerToolResult,
  clipText,
  toJsonString,
};
