"use strict";

const { randomUUID } = require("crypto");
const { assertTransport } = require("./transportContract");

/**
 * OpenAI-compatible chat-completions transport adapter.
 * @param {{
 *   resolveUrl: Function,
 *   runTurn: Function,
 *   normalizeToolName: Function,
 *   normalizeToolCallArgs: Function,
 *   toJsonString: Function,
 *   clipText: Function,
 * }} deps
 */
function createOpenAiChatTransport(deps = {}) {
  const {
    resolveUrl,
    runTurn,
    normalizeToolName,
    normalizeToolCallArgs,
    toJsonString,
    clipText,
  } = deps;

  const transport = {
    name: "openai-chat",
    resolveUrl,
    prepareMessages({ messages, systemPrompt, prompt }) {
      const systemText = String(systemPrompt || "").trim();
      const hasSystem = messages.some((entry) => String(entry.role || "").trim() === "system");
      if (systemText && !hasSystem) {
        messages.unshift({ role: "system", content: systemText });
      }
      messages.push({ role: "user", content: String(prompt || "") });
    },
    runTurn,
    getToolCalls(turnResult) {
      return Array.isArray(turnResult.toolCalls)
        ? turnResult.toolCalls.filter((call) => call && call.function && typeof call.function === "object")
        : [];
    },
    appendFinalAssistantMessage({ messages, turnResult }) {
      const text = String(turnResult.text || "").trim();
      if (text) {
        messages.push({
          role: "assistant",
          content: text,
        });
      }
    },
    prepareToolCalls({ messages, toolCalls }) {
      const assistantToolCalls = [];
      for (const call of toolCalls) {
        const callId = String(call.id || `call_${randomUUID()}`);
        const name = normalizeToolName(call.function.name || "");
        const args = normalizeToolCallArgs(call.function.arguments || "");

        assistantToolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: name || String(call.function.name || ""),
            arguments: toJsonString(args),
          },
        });
      }

      if (assistantToolCalls.length === 0) return null;

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: assistantToolCalls,
      });

      return assistantToolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        args: normalizeToolCallArgs(toolCall.function.arguments),
        source: toolCall,
      }));
    },
    appendToolResult({ messages, call, toolResult }) {
      messages.push({
        role: "tool",
        tool_call_id: call.source.id,
        content: clipText(toJsonString(toolResult), 12000),
      });
    },
  };

  return assertTransport(transport, "openai-chat");
}

module.exports = {
  createOpenAiChatTransport,
};
