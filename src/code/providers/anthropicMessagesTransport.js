"use strict";

const { assertTransport } = require("./transportContract");
const {
  extractVisionPayload,
  stripVisionBase64,
  visionSummaryText,
  toAnthropicImageBlock,
} = require("./visionBlocks");

/**
 * Anthropic Messages API transport adapter.
 * @param {{
 *   resolveUrl: Function,
 *   runTurn: Function,
 *   toJsonString: Function,
 *   clipText: Function,
 * }} deps
 */
function createAnthropicMessagesTransport(deps = {}) {
  const {
    resolveUrl,
    runTurn,
    toJsonString,
    clipText,
  } = deps;

  const transport = {
    name: "anthropic-messages",
    resolveUrl,
    prepareMessages({ messages, prompt }) {
      messages.push({
        role: "user",
        content: String(prompt || ""),
      });
    },
    runTurn,
    getToolCalls(turnResult) {
      return Array.isArray(turnResult.toolCalls) ? turnResult.toolCalls : [];
    },
    appendFinalAssistantMessage({ messages, turnResult }) {
      const assistantContent = Array.isArray(turnResult.assistantContent)
        ? turnResult.assistantContent
        : [];
      if (assistantContent.length > 0) {
        messages.push({
          role: "assistant",
          content: assistantContent,
        });
      } else if (String(turnResult.text || "").trim()) {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: String(turnResult.text || ""),
            },
          ],
        });
      }
    },
    prepareToolCalls({ messages, turnResult, toolCalls }) {
      const assistantContent = Array.isArray(turnResult.assistantContent)
        ? turnResult.assistantContent
        : [];

      messages.push({
        role: "assistant",
        content: assistantContent,
      });

      return toolCalls.map((call) => ({
        name: call.name,
        args: call.args,
        source: call,
      }));
    },
    appendToolResult({ collected, call, toolResult }) {
      const vision = extractVisionPayload(toolResult);
      const isError = Boolean(!toolResult || toolResult.ok === false);
      if (vision) {
        const textPayload = stripVisionBase64(toolResult);
        collected.push({
          type: "tool_result",
          tool_use_id: String(call.source.id || ""),
          content: [
            {
              type: "text",
              text: clipText(
                `${visionSummaryText(vision, toolResult)}\n${toJsonString(textPayload)}`,
                12000,
              ),
            },
            toAnthropicImageBlock(vision),
          ],
          is_error: isError,
        });
        return;
      }
      collected.push({
        type: "tool_result",
        tool_use_id: String(call.source.id || ""),
        content: clipText(toJsonString(toolResult), 12000),
        is_error: isError,
      });
    },
    flushToolResults({ messages, collected }) {
      messages.push({
        role: "user",
        content: collected,
      });
    },
  };

  return assertTransport(transport, "anthropic-messages");
}

module.exports = {
  createAnthropicMessagesTransport,
};
