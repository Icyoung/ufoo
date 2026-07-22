"use strict";

/**
 * Transport contract for native Agent Loop Provider adapters.
 *
 * Transports own wire-format conversion and turn execution only.
 * They must not decide Plan Mode, write leases, or tool batch policy.
 *
 * Required methods:
 * - resolveUrl(baseUrl) → string
 * - prepareMessages({ messages, systemPrompt?, prompt })
 * - runTurn(params) → Promise<turnResult>
 * - getToolCalls(turnResult) → array
 * - appendFinalAssistantMessage({ messages, turnResult })
 * - prepareToolCalls({ messages, turnResult?, toolCalls }) → pendingCalls|null
 * - appendToolResult({ messages?, collected?, call, toolResult })
 * - flushToolResults?({ messages, collected })  // Anthropic-style batch
 */

const TRANSPORT_NAMES = Object.freeze(["openai-chat", "anthropic-messages"]);

function assertTransport(transport = null, name = "") {
  if (!transport || typeof transport !== "object") {
    throw new Error(`missing transport${name ? `: ${name}` : ""}`);
  }
  const required = [
    "resolveUrl",
    "prepareMessages",
    "runTurn",
    "getToolCalls",
    "appendFinalAssistantMessage",
    "prepareToolCalls",
    "appendToolResult",
  ];
  for (const key of required) {
    if (typeof transport[key] !== "function") {
      throw new Error(`transport ${name || "?"} missing ${key}`);
    }
  }
  return transport;
}

module.exports = {
  TRANSPORT_NAMES,
  assertTransport,
};
