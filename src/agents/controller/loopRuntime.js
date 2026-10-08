"use strict";

const { executeControllerTool } = require("./controllerToolExecutor");
const { createAgentRuntime } = require("../runtime");
const { createControllerJsonTransport } = require("../providers/controllerJsonTransport");
const { createCoordinationCapability } = require("../capabilities/coordination");
const { createLoopObserver } = require("./loopObservability");
const { finalizeRouterPayload } = require("../../orchestration/controller/routerFinalize");

const DEFAULT_LOOP_OPTIONS = {
  enabled: false,
  maxRounds: 3,
  maxToolCalls: 3,
  maxToolErrors: 2,
  maxPromptChars: 12000,
};

const TERMINAL_REASONS = Object.freeze({
  FINAL_ANSWER: "final_answer",
  BUDGET_EXCEEDED: "budget_exceeded",
  TOOL_FAILURE: "tool_failure",
  USER_CANCEL: "user_cancel",
  PROVIDER_ERROR: "provider_error",
});

const FALLBACK_USED_VALUES = Object.freeze({
  NONE: "none",
  ASSISTANT_CALL: "assistant_call",
  LEGACY_ROUTER: "legacy_router",
  HELPER_AGENT: "helper_agent",
});

function normalizeTerminalReason(value) {
  const raw = String(value || "").trim();
  if (!raw) return TERMINAL_REASONS.FINAL_ANSWER;
  if (Object.values(TERMINAL_REASONS).includes(raw)) return raw;
  return TERMINAL_REASONS.FINAL_ANSWER;
}

function normalizeFallbackUsed(value) {
  const raw = String(value || "").trim();
  if (!raw) return FALLBACK_USED_VALUES.NONE;
  if (Object.values(FALLBACK_USED_VALUES).includes(raw)) return raw;
  return FALLBACK_USED_VALUES.NONE;
}

function toNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function extractModelMetrics(result) {
  const meta = result && result.meta && typeof result.meta === "object" ? result.meta : null;
  const payloadMeta = result && result.payload && typeof result.payload === "object"
    && result.payload.meta && typeof result.payload.meta === "object"
    ? result.payload.meta
    : null;
  const source = { ...(payloadMeta || {}), ...(meta || {}) };
  return {
    input_tokens: toNonNegativeInt(source.input_tokens),
    output_tokens: toNonNegativeInt(source.output_tokens),
    cache_read_tokens: toNonNegativeInt(source.cache_read_tokens),
    cache_creation_tokens: toNonNegativeInt(source.cache_creation_tokens),
    cache_semistatic_hit: toNonNegativeInt(source.cache_semistatic_hit),
    cache_semistatic_miss: toNonNegativeInt(source.cache_semistatic_miss),
    memory_prefix_tokens: toNonNegativeInt(source.memory_prefix_tokens),
    dynamic_memory_tokens: toNonNegativeInt(source.dynamic_memory_tokens),
    latency_ms: toNonNegativeInt(source.latency_ms),
    first_token_ms: toNonNegativeInt(source.first_token_ms),
    stop_reason: String(source.stop_reason || "").trim(),
  };
}

function normalizePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) return num;
  return fallback;
}

function resolveLoopRuntimeOptions(env = process.env) {
  const mode = String(env.UFOO_AGENT_RUNTIME_MODE || env.UFOO_AGENT_LOOP_MODE || "").trim().toLowerCase();
  const enabled = mode === "loop" || String(env.UFOO_AGENT_ENABLE_LOOP || "").trim() === "1";
  return {
    enabled,
    maxRounds: normalizePositiveInt(env.UFOO_AGENT_LOOP_MAX_ROUNDS, DEFAULT_LOOP_OPTIONS.maxRounds),
    maxToolCalls: normalizePositiveInt(env.UFOO_AGENT_LOOP_MAX_TOOL_CALLS, DEFAULT_LOOP_OPTIONS.maxToolCalls),
    maxToolErrors: normalizePositiveInt(env.UFOO_AGENT_LOOP_MAX_TOOL_ERRORS, DEFAULT_LOOP_OPTIONS.maxToolErrors),
    maxPromptChars: normalizePositiveInt(env.UFOO_AGENT_LOOP_MAX_PROMPT_CHARS, DEFAULT_LOOP_OPTIONS.maxPromptChars),
  };
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { reply: "", dispatch: [], ops: [], done: true };
  }
  return {
    ...payload,
    reply: typeof payload.reply === "string" ? payload.reply : "",
    dispatch: Array.isArray(payload.dispatch) ? payload.dispatch : [],
    ops: Array.isArray(payload.ops) ? payload.ops : [],
    done: payload.done !== false,
  };
}

function buildLoopContinuationPrompt({
  originalPrompt,
  toolResults,
  lastReply,
  loopState,
}) {
  const lines = [];
  lines.push(String(originalPrompt || ""));
  lines.push("");
  if (lastReply) {
    lines.push("Previous draft reply:");
    lines.push(String(lastReply || ""));
    lines.push("");
  }
  lines.push("Controller loop state (JSON):");
  lines.push(JSON.stringify(loopState, null, 2));
  lines.push("");
  lines.push("Controller tool results so far (JSON):");
  lines.push(JSON.stringify(toolResults, null, 2));
  lines.push("");
  lines.push("Use these results to decide the next tool_call or final JSON response.");
  return lines.join("\n");
}

async function finalizeLoopRun({
  projectRoot,
  payload,
  prompt = "",
  processManager,
  dispatchMessages,
  handleOps,
  markPending,
  finalizeLocally = true,
}) {
  return finalizeRouterPayload({
    projectRoot,
    payload,
    prompt,
    processManager: processManager || null,
    dispatchMessages,
    handleOps,
    markPending,
    finalizeLocally,
  });
}

function buildTerminalPayload(reason, lastPayload, rounds, toolCalls, toolErrors, totals = {}) {
  const payload = normalizePayload(lastPayload);
  const canonicalReason = normalizeTerminalReason(reason);
  if (!payload.reply) {
    payload.reply = `Controller loop stopped: ${canonicalReason}.`;
  }
  payload.dispatch = [];
  payload.ops = [];
  payload.loop = {
    terminal_reason: canonicalReason,
    rounds,
    tool_calls: toolCalls,
    tool_errors: toolErrors,
    fallback_used: normalizeFallbackUsed(totals.fallback_used),
    total_tokens: toNonNegativeInt(totals.total_tokens),
    total_latency_ms: toNonNegativeInt(totals.total_latency_ms),
    dynamic_memory_tokens: toNonNegativeInt(totals.dynamic_memory_tokens),
  };
  return payload;
}

async function runPromptWithControllerLoop({
  projectRoot,
  prompt,
  provider,
  model,
  processManager = null,
  runUfooAgent,
  dispatchMessages,
  handleOps,
  ackBus,
  markPending = () => {},
  log = () => {},
  ufooAgentOptions = {},
  finalizeLocally = true,
  loopRuntime = DEFAULT_LOOP_OPTIONS,
  observer: providedObserver = null,
  observabilityDefaults = {},
  now = () => Date.now(),
  isCancelled = null,
}) {
  const options = { ...DEFAULT_LOOP_OPTIONS, ...(loopRuntime || {}) };
  const observer = providedObserver || createLoopObserver({
    projectRoot,
    enabled: options.enabled !== false,
    defaults: observabilityDefaults,
  });

  let currentPrompt = String(prompt || "");
  let lastPayload = null;
  let toolCalls = 0;
  let toolErrors = 0;
  let totalTokens = 0;
  let totalLatencyMs = 0;
  let dynamicMemoryTokens = 0;
  const toolResults = [];

  const checkCancellation = () => {
    if (typeof isCancelled !== "function") return false;
    try {
      return isCancelled() === true;
    } catch {
      return false;
    }
  };

  const totals = () => ({
    fallback_used: FALLBACK_USED_VALUES.NONE,
    total_tokens: totalTokens,
    total_latency_ms: totalLatencyMs,
    dynamic_memory_tokens: dynamicMemoryTokens,
  });

  const terminate = (reason, payloadBase, roundsCount) => {
    const finalPayload = buildTerminalPayload(
      reason,
      payloadBase,
      roundsCount,
      toolCalls,
      toolErrors,
      totals()
    );
    observer.emit("loop_terminal", finalPayload.loop);
    return finalPayload;
  };

  let rounds = 0;
  const host = {
    grantedPermissions: ["coordination.read", "coordination.write", "agents.manage", "schedules.manage", "memory.write"],
    coordination: {
      projectRoot, processManager, dispatchMessages, handleOps, ackBus, markPending, observer,
      async execute(ctx, call) {
        const started = now();
        const result = await executeControllerTool({ ...ctx, turnId: `loop-round-${rounds}` }, call);
        let size = 0;
        let memory = 0;
        try {
          size = result.result === undefined ? 0 : JSON.stringify(result.result).length;
          memory = toNonNegativeInt(result.result && result.result.dynamic_memory_tokens);
        } catch { /* diagnostic metadata only */ }
        dynamicMemoryTokens += memory;
        observer.emit("tool_call", {
          round: rounds, tool_name: result.name || call.name,
          tool_call_id: result.tool_call_id || "", turn_id: result.turn_id || `loop-round-${rounds}`,
          duration_ms: Math.max(0, now() - started), result_size: size,
          dynamic_memory_tokens: memory, retry_count: 0, final_status: result.ok ? "ok" : "error",
        });
        return result;
      },
    },
  };
  const policy = {
    beforeTurn() {
      if (checkCancellation()) return TERMINAL_REASONS.USER_CANCEL;
      if (rounds >= options.maxRounds || currentPrompt.length > options.maxPromptChars) return TERMINAL_REASONS.BUDGET_EXCEEDED;
      return null;
    },
    beforeTool() {
      return toolCalls >= options.maxToolCalls ? TERMINAL_REASONS.BUDGET_EXCEEDED : null;
    },
    afterTool({ call, result }) {
      toolCalls += 1;
      if (!result || !result.ok) toolErrors += 1;
      toolResults.push(result && result.name ? result : {
        ...result, name: call.name, tool_call_id: call.source.id, turn_id: `loop-round-${rounds}`,
      });
      if (toolErrors >= options.maxToolErrors) return TERMINAL_REASONS.TOOL_FAILURE;
      currentPrompt = buildLoopContinuationPrompt({
        originalPrompt: prompt, toolResults, lastReply: lastPayload.reply,
        loopState: { round: rounds, max_rounds: options.maxRounds, tool_calls_used: toolCalls,
          tool_calls_remaining: Math.max(options.maxToolCalls - toolCalls, 0), tool_errors: toolErrors },
      });
      return null;
    },
  };
  const transport = createControllerJsonTransport({ async invoke() {
    rounds += 1;
    const started = now();
    observer.emit("model_call_started", { round: rounds, provider: String(provider || ""),
      model: String(model || ""), prompt_chars: currentPrompt.length });
    const result = await runUfooAgent({ projectRoot, prompt: currentPrompt, provider, model,
      ...ufooAgentOptions, loopRuntime: { enabled: true, round: rounds, maxRounds: options.maxRounds,
        maxToolCalls: options.maxToolCalls, remainingToolCalls: Math.max(options.maxToolCalls - toolCalls, 0) } });
    const metrics = extractModelMetrics(result);
    const latency = metrics.latency_ms || Math.max(0, now() - started);
    totalTokens += metrics.input_tokens + metrics.output_tokens;
    totalLatencyMs += latency;
    observer.emit("model_call", { round: rounds, provider: String(provider || ""), model: String(model || ""),
      ...metrics, latency_ms: latency, ok: result && result.ok === true,
      tool_call_count: result && result.payload && result.payload.tool_call ? 1 : 0,
      error: result && result.ok === false ? String(result.error || "") : "" });
    observer.emit("model_call_finished", { round: rounds, ok: result && result.ok === true,
      error: result && result.ok === false ? String(result.error || "") : "" });
    if (result && result.ok) lastPayload = normalizePayload(result.payload);
    return result;
  } });
  const runtime = createAgentRuntime({ profile: { capabilities: ["controller"] }, transport, host,
    capabilities: [createCoordinationCapability({ host, id: "controller", policy })] });
  let run;
  try {
    run = await runtime.run({ workspaceRoot: projectRoot, prompt, model: model || "controller",
      toolBudget: { maxToolErrors: Infinity } });
  } catch (error) {
    const payload = terminate(TERMINAL_REASONS.PROVIDER_ERROR, lastPayload, rounds);
    return { ok: false, error: error.message, payload };
  }
  const payload = run.stopReason
    ? terminate(run.stopReason, lastPayload, rounds)
    : { ...lastPayload, loop: { terminal_reason: TERMINAL_REASONS.FINAL_ANSWER, rounds,
      tool_calls: toolCalls, tool_errors: toolErrors, ...totals() } };
  if (!run.stopReason) observer.emit("loop_terminal", payload.loop);
  return finalizeLoopRun({ projectRoot, payload, prompt: currentPrompt, processManager,
    dispatchMessages, handleOps, markPending, finalizeLocally });
}

module.exports = {
  DEFAULT_LOOP_OPTIONS,
  FALLBACK_USED_VALUES,
  TERMINAL_REASONS,
  buildLoopContinuationPrompt,
  normalizeFallbackUsed,
  normalizeTerminalReason,
  resolveLoopRuntimeOptions,
  runPromptWithControllerLoop,
};
