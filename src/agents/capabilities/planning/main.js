"use strict";

const { buildCoreToolSpecs } = require("../../../code/tools/specs");
const { runCoreToolAsync } = require("../../../code/tools/executor");
const { getPendingUserInteraction } = require("../../../code/context/userInteraction");

/** Main planning delegates durable execution; it never adopts a child's model focus. */
function createMainPlanningCapability() {
  const { function: tool } = buildCoreToolSpecs().find((spec) => spec.function.name === "ask_user");
  return { id: "planning", version: "1", requires: { providerFeatures: ["deferred_tools"] }, requestedPermissions: ["interaction.request"],
    promptSections: ["Decompose complex objectives into independently verifiable tasks. Record explicit objectives and acceptance criteria. Keep dependent tasks queued until their inputs have been verified; use manage_tasks and delegate_task for execution."],
    tools: [{ name: tool.name, description: tool.description, inputSchema: tool.parameters,
      permissions: ["interaction.request"], deferable: true,
      handler: (args, context) => runCoreToolAsync({ ...context, tool: tool.name, args }) }],
    policy: {
      validateBatch(calls) { return calls.some((call) => call.name === "ask_user") && calls.length > 1
        ? { ok: false, code: "ASK_USER_MUST_BE_ALONE", error: "ask_user must be alone" } : null; },
      pendingInteraction: getPendingUserInteraction,
      onDeferred({ executionState, resume, provider }) {
        const pending = getPendingUserInteraction(executionState);
        if (pending) pending.resume = { ...resume, mode: "ask_user", transport: provider === "anthropic" ? "anthropic-messages" : "openai-chat" };
      },
      sanitizeResult(result) { if (!result || typeof result !== "object") return result; const { executionState, ...rest } = result; return rest; },
    },
  };
}

module.exports = { createMainPlanningCapability };
