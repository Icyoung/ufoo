"use strict";

const { createOpenAiChatTransport } = require("./transports/openaiChatTransport");

/** Adapt the legacy controller JSON envelope to the shared tool protocol. */
function createControllerJsonTransport({ invoke } = {}) {
  return { ...createOpenAiChatTransport({
    resolveUrl: () => "controller://local",
    normalizeToolName: (name) => String(name || "").trim().toLowerCase(),
    normalizeToolCallArgs: (args) => typeof args === "string" ? JSON.parse(args || "{}") : args || {},
    toJsonString: JSON.stringify,
    clipText: (text) => text,
    async runTurn() {
      const result = await invoke();
      if (!result || result.ok !== true) throw Object.assign(new Error(result && result.error || "ufoo-agent loop failed"), { code: "provider_error" });
      const payload = result.payload || {};
      const call = payload.tool_call;
      return {
        text: call ? "" : JSON.stringify(payload),
        toolCalls: call ? [{ id: call.tool_call_id || call.toolCallId || call.id,
          function: { name: call.name, arguments: call.arguments || call.args || {} } }] : [],
        usage: { input: result.meta && result.meta.input_tokens, output: result.meta && result.meta.output_tokens },
      };
    },
  }), features: Object.freeze(["tool_calls"]) };
}

module.exports = { createControllerJsonTransport };
