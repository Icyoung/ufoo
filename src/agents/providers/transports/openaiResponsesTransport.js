"use strict";

const { randomUUID } = require("crypto");
const { assertTransport } = require("./transportContract");
const {
  extractVisionPayload,
  stripVisionBase64,
  visionSummaryText,
  toOpenAiImagePart,
} = require("./visionBlocks");
const { attachResponsesReasoningItems } = require("./responsesProtocol");

/**
 * OpenAI Responses transport adapter.
 *
 * The loop keeps the public, provider-neutral message projection in the same
 * shape as the Chat transport. The versioned continuation field carries the
 * ordered Responses items needed to rebuild a later stateless request.
 */
function createOpenAiResponsesTransport(deps = {}) {
  const {
    resolveUrl,
    runTurn,
    normalizeToolName,
    normalizeToolCallArgs,
    toJsonString,
    clipText,
  } = deps;
  const appendContinuation = (message, result) => attachResponsesReasoningItems(message,
    Array.isArray(result?.outputItems) ? { output: result.outputItems } : result?.response, result?.responsesRequest);

  const transport = {
    name: "openai-responses",
    features: Object.freeze(["tool_calls", "streaming", "vision", "deferred_tools"]),
    resolveUrl,
    prepareMessages({ messages, prompt, userContent }) {
      messages.push({
        role: "user",
        content: Array.isArray(userContent) && userContent.length > 0 ? userContent : String(prompt || ""),
      });
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
        messages.push(appendContinuation({
          role: "assistant",
          content: text,
        }, turnResult));
      }
    },
    prepareToolCalls({ messages, turnResult, toolCalls }) {
      const assistantToolCalls = [];
      for (const call of toolCalls) {
        const source = call && call.function && typeof call.function === "object"
          ? call.function
          : {};
        const callId = String(call.id || `call_${randomUUID()}`);
        const name = normalizeToolName(source.name || "");
        const args = normalizeToolCallArgs(source.arguments || "");
        assistantToolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: name || String(source.name || ""),
            arguments: toJsonString(args),
          },
        });
      }

      if (assistantToolCalls.length === 0) return null;
      const text = String((turnResult && turnResult.text) || "").trim();
      const assistantMessage = {
        role: "assistant",
        content: text || null,
        tool_calls: assistantToolCalls,
      };
      messages.push(appendContinuation(assistantMessage, turnResult));

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
        messages.push({
          role: "user",
          content: [
            { type: "text", text: visionSummaryText(vision, toolResult) },
            toOpenAiImagePart(vision),
          ],
        });
      }
    },
  };

  return assertTransport(transport, "openai-responses");
}

module.exports = {
  createOpenAiResponsesTransport,
};
