"use strict";

const EventBus = require("../bus");
const { getToolDefinition, CALLER_TIERS } = require("../tools");
const { dispatchMessageHandler } = require("../tools/handlers/dispatchMessage");
const { ackBusHandler } = require("../tools/handlers/ackBus");

function normalizeObjectArgs(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" ? value : {};
}

function normalizePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) return num;
  return fallback;
}

function buildStructuredError(code, message, extra = {}) {
  return {
    code: String(code || "tool_error"),
    message: String(message || "tool execution failed"),
    ...extra,
  };
}

function resolveDispatchTargets(ctx, target) {
  if (typeof ctx.resolveDispatchTargets === "function") {
    const resolved = ctx.resolveDispatchTargets(target);
    if (Array.isArray(resolved) && resolved.length > 0) return resolved;
  }

  const eventBus = ctx.eventBus || new EventBus(ctx.projectRoot);
  try {
    if (typeof eventBus.ensureBus === "function") eventBus.ensureBus();
    if (typeof eventBus.loadBusData === "function") eventBus.loadBusData();
    const targets = eventBus.messageManager && typeof eventBus.messageManager.resolveTarget === "function"
      ? eventBus.messageManager.resolveTarget(target)
      : [];
    if (Array.isArray(targets) && targets.length > 0) return targets;
  } catch {
    // fall through to conservative fallback
  }

  if (target.includes(":")) return [target];

  throw buildStructuredError("invalid_target", `dispatch_message target not found: ${target}`);
}

async function handleDispatchMessage(ctx, args) {
  const eventBus = typeof ctx.dispatchMessages === "function"
    ? {
      send: async (target, message, publisher, options = {}) => {
        resolveDispatchTargets(ctx, target);
        if (target !== "broadcast" && typeof ctx.markPending === "function") {
          ctx.markPending(target);
        }
        await ctx.dispatchMessages(ctx.projectRoot, [{
          target,
          message,
          injection_mode: options.injectionMode || "immediate",
          source: options.source || publisher,
        }]);
        return { seq: 0, targets: [target] };
      },
      broadcast: async (message, publisher, options = {}) => {
        await ctx.dispatchMessages(ctx.projectRoot, [{
          target: "broadcast",
          message,
          injection_mode: options.injectionMode || "immediate",
          source: options.source || publisher,
        }]);
        return { seq: 0, targets: ["broadcast"] };
      },
    }
    : new EventBus(ctx.projectRoot);

  const result = await dispatchMessageHandler({
    projectRoot: ctx.projectRoot,
    subscriber: ctx.subscriber,
    eventBus,
  }, args);

  return {
    dispatched: 1,
    target: result.target,
    injection_mode: result.mode,
    source: result.source,
  };
}

async function handleAckBus(ctx, args) {
  const eventBus = typeof ctx.ackBus === "function"
    ? {
      ack: async (subscriber) => {
        await ctx.ackBus(ctx.projectRoot, subscriber);
        return 1;
      },
    }
    : new EventBus(ctx.projectRoot);

  const result = await ackBusHandler({
    projectRoot: ctx.projectRoot,
    subscriber: ctx.subscriber,
    eventBus,
  }, args);

  return {
    acknowledged: true,
    subscriber: result.subscriber,
  };
}

async function handleLaunchAgent(ctx, args) {
  if (typeof ctx.handleOps !== "function") {
    throw buildStructuredError("tool_unavailable", "launch_agent hook is unavailable");
  }

  const agent = String(args.agent || "").trim().toLowerCase();
  if (!agent) {
    throw buildStructuredError("invalid_arguments", "launch_agent requires agent");
  }

  const op = {
    action: "launch",
    agent,
    count: normalizePositiveInt(args.count, 1),
  };
  if (args.nickname) op.nickname = String(args.nickname).trim();
  if (args.prompt_profile) op.prompt_profile = String(args.prompt_profile).trim();
  if (args.launch_scope) op.launch_scope = String(args.launch_scope).trim();
  if (args.terminal_app) op.terminal_app = String(args.terminal_app).trim();

  const opsResults = await ctx.handleOps(ctx.projectRoot, [op], ctx.processManager || null);
  return {
    operation: op,
    ops_results: Array.isArray(opsResults) ? opsResults : [],
  };
}

async function handleSharedRegistryTool(ctx, name, args, audit = {}) {
  const definition = getToolDefinition(name);
  if (!definition || typeof definition.handler !== "function") {
    throw buildStructuredError("unsupported_tool", `unsupported controller tool: ${name}`);
  }
  if (!definition.allowed_tiers.includes(CALLER_TIERS.CONTROLLER)) {
    throw buildStructuredError("forbidden_caller_tier", `controller is not allowed to invoke tool: ${name}`);
  }
  const eventBus = ctx.eventBus || new EventBus(ctx.projectRoot);
  return definition.handler({
    projectRoot: ctx.projectRoot,
    subscriber: ctx.subscriber || "ufoo-agent",
    caller_tier: CALLER_TIERS.CONTROLLER,
    eventBus,
    turn_id: audit.turn_id || "",
    tool_call_id: audit.tool_call_id || "",
  }, args);
}

async function executeControllerTool(ctx, toolCall = {}) {
  const observer = ctx.observer || { emit: () => {}, audit: () => {} };
  const name = String(toolCall.name || "").trim();
  const args = normalizeObjectArgs(toolCall.arguments);
  const toolCallId = String(
    toolCall.tool_call_id || toolCall.toolCallId || toolCall.id || `${Date.now().toString(36)}`
  ).trim();
  const turnId = String(toolCall.turn_id || toolCall.turnId || ctx.turnId || "").trim();

  observer.emit("tool_call_started", {
    tool_name: name,
    tool_call_id: toolCallId,
    turn_id: turnId,
  });

  try {
    let result;
    if (name === "dispatch_message") {
      result = await handleDispatchMessage(ctx, args);
    } else if (name === "ack_bus") {
      result = await handleAckBus(ctx, args);
    } else if (name === "launch_agent") {
      result = await handleLaunchAgent(ctx, args);
    } else {
      result = await handleSharedRegistryTool(ctx, name, args, {
        turn_id: turnId,
        tool_call_id: toolCallId,
      });
    }

    observer.emit("tool_call_finished", {
      tool_name: name,
      tool_call_id: toolCallId,
      turn_id: turnId,
      ok: true,
    });
    observer.audit({
      source: "controller_loop",
      kind: "tool_call",
      tool_name: name,
      tool_call_id: toolCallId,
      turn_id: turnId,
      ok: true,
      result,
    });

    return {
      ok: true,
      name,
      tool_call_id: toolCallId,
      turn_id: turnId,
      result,
    };
  } catch (err) {
    const error = err && typeof err === "object" && err.code
      ? err
      : buildStructuredError("tool_execution_failed", err && err.message ? err.message : String(err || "tool failed"));

    observer.emit("tool_call_finished", {
      tool_name: name,
      tool_call_id: toolCallId,
      turn_id: turnId,
      ok: false,
      error_code: error.code,
    });
    observer.audit({
      source: "controller_loop",
      kind: "tool_call",
      tool_name: name,
      tool_call_id: toolCallId,
      turn_id: turnId,
      ok: false,
      error,
    });

    return {
      ok: false,
      name,
      tool_call_id: toolCallId,
      turn_id: turnId,
      error,
    };
  }
}

module.exports = {
  buildStructuredError,
  executeControllerTool,
};
