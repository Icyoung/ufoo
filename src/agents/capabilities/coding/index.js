"use strict";

const { buildCoreToolSpecs } = require("../../../code/tools/specs");
const { runCoreToolAsync } = require("../../../code/tools/executor");
const { randomUUID } = require("crypto");
const { validateWakeOptions } = require("./backgroundHooks");

const CODING_TOOLS = new Set(["read", "read_image", "write", "edit", "bash", "artifact_read"]);

function toolFromSpec(spec, editBudgetNotice) {
  const { name, description, parameters } = spec.function;
  return {
    name, description, inputSchema: parameters,
    permissions: [name === "bash" ? "workspace.execute" : ["write", "edit"].includes(name) ? "workspace.write" : "workspace.read"],
    tight: ["read", "read_image", "artifact_read"].includes(name),
    async handler(args, context) {
      const hooks = context.runtimeHooks;
      const startsBackground = name === "bash" && args.background && (!args.action || args.action === "run");
      if (name === "bash" && args.wake !== undefined && !startsBackground) return { ok: false, code: "invalid_arguments", error: "wake is only valid when starting a background command" };
      let backgroundId;
      if (startsBackground) {
        let wake;
        try { wake = validateWakeOptions(args.wake, context.workspaceRoot); }
        catch (error) { return { ok: false, code: "invalid_arguments", error: error.message }; }
        if (args.wake && !hooks && (wake.onExit || wake.conditions.length)) return { ok: false, code: "wake_unavailable", error: "This host does not support background wake notifications" };
        if (hooks && (wake.onExit || wake.conditions.length)) {
          backgroundId = `bg_${randomUUID().replace(/-/g, "")}`;
          try { hooks.register({ id: backgroundId, source: "background", ownerTaskRunId: context.taskRunId,
            spec: { backgroundId, ...wake }, timeoutMs: wake.timeoutMs }); }
          catch (error) { return { ok: false, code: "wake_registration_failed", error: error.message }; }
        }
      }
      if (name === "bash" && args.action === "stop") hooks?.cancel(args.backgroundId);
      const result = await runCoreToolAsync({ ...context, backgroundId, tool: name, args });
      if (editBudgetNotice && (name === "edit" || name === "write") && result?.ok) {
        const notice = editBudgetNotice();
        if (notice) return { ...result, turnBudget: notice };
      }
      if (backgroundId && !result?.backgroundId) hooks.cancel(backgroundId);
      if (name === "bash" && args.action === "status" && hooks) {
        const state = hooks.snapshot();
        const subscription = state.subscriptions[args.backgroundId];
        if (subscription) return { ...result, wake: { subscriptionId: subscription.id, status: subscription.status,
          notifications: Object.values(state.events).filter(event => event.subscriptionId === subscription.id).map(event => ({ id: event.id, type: event.type, status: event.status })) } };
      }
      return backgroundId && result?.backgroundId ? { ...result, wake: { registered: true, subscriptionId: backgroundId } } : result;
    },
  };
}

// Surface the existing deadline at the first edit and once in the second half.
// Keeping it on the tool receipt leaves the cached instructions and schemas stable.
function createEditBudgetNotice({ budgetMs, deadlineAt }) {
  let lastStage = 0;
  return () => {
    const remainingMs = deadlineAt - Date.now();
    const stage = remainingMs > budgetMs / 2 ? 1 : 2;
    if (remainingMs <= 0 || stage <= lastStage) return null;
    lastStage = stage;
    return {
      remainingSecondsAtEdit: Math.ceil(remainingMs / 1000),
      guidance: stage === 1
        ? "Work in runnable increments. Exercise the affected entry point as soon as a change is usable, leaving time to repair and rerun it."
        : "Prioritize a focused check of the changed behavior and a previously working path. Rerun the check after any repair.",
    };
  };
}

function createCodingCapability({ workspaceAccess = null, editBudget = null } = {}) {
  const editBudgetNotice = editBudget && createEditBudgetNotice(editBudget);
  return {
    id: "coding", version: "1.0",
    requires: { providerFeatures: ["tool_calls", "vision"] },
    tools: buildCoreToolSpecs().filter((spec) => CODING_TOOLS.has(spec.function.name)).map((spec) => {
      const tool = toolFromSpec(spec, editBudgetNotice);
      return workspaceAccess ? { ...tool, async handler(args, context) {
        const result = await workspaceAccess.run({ ...context, tool: tool.name, args }, () => tool.handler(args, context));
        return { ...result, toolCallId: context.toolCallId };
      } } : tool;
    }),
  };
}

module.exports = { createCodingCapability, toolFromSpec };
