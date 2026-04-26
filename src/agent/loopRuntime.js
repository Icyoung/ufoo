"use strict";

const { executeControllerTool } = require("./controllerToolExecutor");
const { createLoopObserver } = require("./loopObservability");
const { finalizeRouterPayload } = require("../controller/routerFinalize");

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

  for (let round = 1; round <= options.maxRounds; round += 1) {
    if (checkCancellation()) {
      const payload = terminate(TERMINAL_REASONS.USER_CANCEL, lastPayload, round - 1);
      return finalizeLoopRun({
        projectRoot,
        payload,
        prompt: currentPrompt,
        processManager,
        dispatchMessages,
        handleOps,
        markPending,
        finalizeLocally,
      });
    }

    if (currentPrompt.length > options.maxPromptChars) {
      const payload = terminate(TERMINAL_REASONS.BUDGET_EXCEEDED, lastPayload, round - 1);
      return finalizeLoopRun({
        projectRoot,
        payload,
        prompt: currentPrompt,
        processManager,
        dispatchMessages,
        handleOps,
        markPending,
        finalizeLocally,
      });
    }

    const roundStartedAt = now();
    observer.emit("model_call_started", {
      round,
      provider: String(provider || ""),
      model: String(model || ""),
      prompt_chars: currentPrompt.length,
    });

    const result = await runUfooAgent({
      projectRoot,
      prompt: currentPrompt,
      provider,
      model,
      ...ufooAgentOptions,
      loopRuntime: {
        enabled: true,
        round,
        maxRounds: options.maxRounds,
        maxToolCalls: options.maxToolCalls,
        remainingToolCalls: Math.max(options.maxToolCalls - toolCalls, 0),
      },
    });

    const metrics = extractModelMetrics(result);
    const modelLatency = metrics.latency_ms > 0 ? metrics.latency_ms : Math.max(0, now() - roundStartedAt);
    totalTokens += metrics.input_tokens + metrics.output_tokens;
    totalLatencyMs += modelLatency;

    const toolCall = result && result.payload && typeof result.payload === "object"
      && result.payload.tool_call && typeof result.payload.tool_call === "object"
      ? result.payload.tool_call
      : null;

    observer.emit("model_call", {
      round,
      provider: String(provider || ""),
      model: String(model || ""),
      ok: result && result.ok === true,
      input_tokens: metrics.input_tokens,
      output_tokens: metrics.output_tokens,
      cache_read_tokens: metrics.cache_read_tokens,
      cache_creation_tokens: metrics.cache_creation_tokens,
      cache_semistatic_hit: metrics.cache_semistatic_hit,
      cache_semistatic_miss: metrics.cache_semistatic_miss,
      memory_prefix_tokens: metrics.memory_prefix_tokens,
      dynamic_memory_tokens: metrics.dynamic_memory_tokens,
      latency_ms: modelLatency,
      first_token_ms: metrics.first_token_ms,
      tool_call_count: toolCall ? 1 : 0,
      stop_reason: metrics.stop_reason,
      error: result && result.ok === false ? String(result.error || "") : "",
    });
    observer.emit("model_call_finished", {
      round,
      ok: result && result.ok === true,
      error: result && result.ok === false ? String(result.error || "") : "",
    });

    if (!result || result.ok !== true) {
      const payload = terminate(TERMINAL_REASONS.PROVIDER_ERROR, lastPayload, round);
      return {
        ok: false,
        error: result && result.error ? result.error : "ufoo-agent loop failed",
        payload,
      };
    }

    const payload = normalizePayload(result.payload);
    lastPayload = payload;

    if (!toolCall) {
      const finalPayload = {
        ...payload,
        loop: {
          terminal_reason: TERMINAL_REASONS.FINAL_ANSWER,
          rounds: round,
          tool_calls: toolCalls,
          tool_errors: toolErrors,
          fallback_used: FALLBACK_USED_VALUES.NONE,
          total_tokens: totalTokens,
          total_latency_ms: totalLatencyMs,
          dynamic_memory_tokens: dynamicMemoryTokens,
        },
      };
      observer.emit("loop_terminal", finalPayload.loop);
      return finalizeLoopRun({
        projectRoot,
        payload: finalPayload,
        prompt: currentPrompt,
        processManager,
        dispatchMessages,
        handleOps,
        markPending,
        finalizeLocally,
      });
    }

    if (toolCalls >= options.maxToolCalls) {
      const finalPayload = terminate(TERMINAL_REASONS.BUDGET_EXCEEDED, payload, round);
      return finalizeLoopRun({
        projectRoot,
        payload: finalPayload,
        prompt: currentPrompt,
        processManager,
        dispatchMessages,
        handleOps,
        markPending,
        finalizeLocally,
      });
    }

    toolCalls += 1;
    const toolStartedAt = now();
    const toolResult = await executeControllerTool({
      projectRoot,
      subscriber: "ufoo-agent",
      processManager,
      dispatchMessages,
      handleOps,
      ackBus,
      markPending,
      observer,
      turnId: `loop-round-${round}`,
    }, toolCall);
    const toolDuration = Math.max(0, now() - toolStartedAt);

    let toolResultSize = 0;
    let toolDynamicMemoryTokens = 0;
    try {
      toolResultSize = toolResult && toolResult.result !== undefined
        ? JSON.stringify(toolResult.result).length
        : 0;
      toolDynamicMemoryTokens = toolResult && toolResult.result && Number.isFinite(Number(toolResult.result.dynamic_memory_tokens))
        ? Math.max(0, Math.floor(Number(toolResult.result.dynamic_memory_tokens)))
        : 0;
    } catch {
      toolResultSize = 0;
      toolDynamicMemoryTokens = 0;
    }
    dynamicMemoryTokens += toolDynamicMemoryTokens;

    observer.emit("tool_call", {
      round,
      tool_name: String(toolResult && toolResult.name ? toolResult.name : toolCall.name || ""),
      tool_call_id: String(toolResult && toolResult.tool_call_id ? toolResult.tool_call_id : ""),
      turn_id: toolResult && toolResult.turn_id ? String(toolResult.turn_id) : `loop-round-${round}`,
      duration_ms: toolDuration,
      result_size: toolResultSize,
      dynamic_memory_tokens: toolDynamicMemoryTokens,
      retry_count: 0,
      final_status: toolResult && toolResult.ok === true ? "ok" : "error",
    });

    if (!toolResult.ok) {
      toolErrors += 1;
    }
    toolResults.push(toolResult);

    if (toolErrors >= options.maxToolErrors) {
      const finalPayload = terminate(TERMINAL_REASONS.TOOL_FAILURE, payload, round);
      return finalizeLoopRun({
        projectRoot,
        payload: finalPayload,
        prompt: currentPrompt,
        processManager,
        dispatchMessages,
        handleOps,
        markPending,
        finalizeLocally,
      });
    }

    currentPrompt = buildLoopContinuationPrompt({
      originalPrompt: prompt,
      toolResults,
      lastReply: payload.reply,
      loopState: {
        round,
        max_rounds: options.maxRounds,
        tool_calls_used: toolCalls,
        tool_calls_remaining: Math.max(options.maxToolCalls - toolCalls, 0),
        tool_errors: toolErrors,
      },
    });
  }

  const payload = terminate(TERMINAL_REASONS.BUDGET_EXCEEDED, lastPayload, options.maxRounds);
  return finalizeLoopRun({
    projectRoot,
    payload,
    prompt: currentPrompt,
    processManager,
    dispatchMessages,
    handleOps,
    markPending,
    finalizeLocally,
  });
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
