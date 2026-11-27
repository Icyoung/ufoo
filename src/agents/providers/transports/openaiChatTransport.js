"use strict";

const { randomUUID } = require("crypto");
const { toChatMessages } = require("./toolHistory");
const { assertTransport } = require("./transportContract");
const {
  extractVisionPayload,
  stripVisionBase64,
  visionSummaryText,
  toOpenAiImagePart,
} = require("./visionBlocks");

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
    features: Object.freeze(["tool_calls", "streaming", "vision", "deferred_tools"]),
    resolveUrl,
    prepareMessages({ messages, systemPrompt, prompt, userContent }) {
      const systemText = String(systemPrompt || "").trim();
      const hasSystem = messages.some((entry) => String(entry.role || "").trim() === "system");
      if (systemText && !hasSystem) {
        messages.unshift({ role: "system", content: systemText });
      }
      if (Array.isArray(userContent) && userContent.length > 0) {
        const normalized = userContent.map((block) => {
          if (block && block.type === "image" && block.source && block.source.type === "base64" && block.source.data) {
            return {
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}`,
              },
            };
          }
          return block;
        });
        messages.push({ role: "user", content: normalized });
      } else {
        messages.push({ role: "user", content: String(prompt || "") });
      }
    },
    runTurn(options) {
      const messages = toChatMessages(options.messages);
      if (options.systemPrompt && !messages.some(message => message.role === "system")) {
        messages.unshift({ role: "system", content: options.systemPrompt });
      }
      return runTurn({ ...options, messages });
    },
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
    prepareToolCalls({ messages, turnResult, toolCalls }) {
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

      const text = String((turnResult && turnResult.text) || "").trim();
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: assistantToolCalls,
      });

      return assistantToolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        args: normalizeToolCallArgs(toolCall.function.arguments),
        source: toolCall,
      }));
    },
    appendToolResult({ messages, call, toolResult }) {
      const vision = extractVisionPayload(toolResult);
      const payload = vision ? stripVisionBase64(toolResult) : toolResult;
      messages.push({
        role: "tool",
        tool_call_id: call.source.id,
        content: clipText(toJsonString(payload), 12000),
      });
      if (vision) {
        const imagePart = toOpenAiImagePart(vision);
        messages.push({
          role: "user",
          content: [
            { type: "text", text: visionSummaryText(vision, toolResult) },
            imagePart,
          ],
        });
      }
    },
  };

  return assertTransport(transport, "openai-chat");
}

module.exports = {
  createOpenAiChatTransport,
};
