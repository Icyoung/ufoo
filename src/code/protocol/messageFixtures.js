"use strict";

/**
 * Golden / expected Provider message sequences derived from ledger call records.
 * Used for fixture tests only — does not replace TRANSPORTS materialization (yet).
 */

function materializeOpenAiMessages({
  assistantText = null,
  calls = [],
  results = [],
} = {}) {
  const messages = [];
  const toolCalls = calls.map((call) => ({
    id: call.callId,
    type: "function",
    function: {
      name: call.name,
      arguments: typeof call.argsJson === "string"
        ? call.argsJson
        : JSON.stringify(call.args == null ? {} : call.args),
    },
  }));

  if (toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls,
    });
  } else if (assistantText != null) {
    messages.push({ role: "assistant", content: assistantText });
  }

  for (const result of results) {
    messages.push({
      role: "tool",
      tool_call_id: result.callId,
      content: typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content == null ? {} : result.content),
    });
  }
  return messages;
}

function materializeAnthropicMessages({
  assistantBlocks = null,
  calls = [],
  results = [],
  assistantText = "",
} = {}) {
  const messages = [];
  let content = Array.isArray(assistantBlocks) ? assistantBlocks.slice() : null;
  if (!content) {
    content = [];
    if (assistantText) {
      content.push({ type: "text", text: String(assistantText) });
    }
    for (const call of calls) {
      content.push({
        type: "tool_use",
        id: call.callId,
        name: call.name,
        input: call.args == null ? {} : call.args,
      });
    }
  }
  if (content.length > 0) {
    messages.push({ role: "assistant", content });
  }

  if (results.length > 0) {
    messages.push({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: typeof result.content === "string"
          ? result.content
          : JSON.stringify(result.content == null ? {} : result.content),
        is_error: Boolean(result.isError),
      })),
    });
  }
  return messages;
}

/**
 * Build expected messages from a simplified fixture definition.
 * @param {{ provider: string, calls: object[], results?: object[], assistantText?: string }} def
 */
function materializeFromFixtureDef(def = {}) {
  const provider = String(def.provider || "openai").toLowerCase();
  const calls = Array.isArray(def.calls) ? def.calls : [];
  const results = Array.isArray(def.results) ? def.results : [];
  if (provider === "anthropic" || provider === "anthropic-messages") {
    return materializeAnthropicMessages({
      calls,
      results,
      assistantText: def.assistantText || "",
      assistantBlocks: def.assistantBlocks || null,
    });
  }
  return materializeOpenAiMessages({
    calls,
    results,
    assistantText: def.assistantText != null ? def.assistantText : null,
  });
}

module.exports = {
  materializeOpenAiMessages,
  materializeAnthropicMessages,
  materializeFromFixtureDef,
};
