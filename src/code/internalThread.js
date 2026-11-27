"use strict";

// Embedded host for the same native coding runner used by standalone ucode.
const { randomUUID } = require("crypto");
const agent = require("./agent");
const { buildPlanSetPayload } = require("../ui/agentPresentation");

function createInternalCodingThread(options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const { normalizeThinkingLevel, applyThinkingLevelToEnv } = require("./thinkingLevels");
  const resolved = agent.resolveUcodeProviderModel({ workspaceRoot, model: options.model || "" });
  const initialThinking = normalizeThinkingLevel(options.thinkingLevel || process.env.UFOO_UCODE_THINKING || "") || "medium";
  applyThinkingLevelToEnv(initialThinking, process.env);
  const state = {
    workspaceRoot, ...resolved, engine: "ufoo-core",
    thinking: initialThinking,
    permissionMode: String(options.permissionMode || process.env.UFOO_PERMISSION_MODE || "auto_edit").trim().toLowerCase(),
    ...(typeof options.authorizeTool === "function" ? { authorizeTool: options.authorizeTool } : {}),
    context: agent.buildNlContext({ workspaceRoot, ...resolved }),
    nlMessages: [], sessionId: options.sessionId || `ucode-${randomUUID()}`,
  };
  if (options.sessionId && options.resume !== false) {
    const restored = agent.resumeSessionState(state, options.sessionId, workspaceRoot);
    if (restored?.ok === false) throw new Error(restored.error || `Could not resume session: ${options.sessionId}`);
  }
  let abort = null;
  let wakeDelivery = null;
  const wakeHost = require("./runtime/backgroundWakeHost").createUcodeWakeHost({ state,
    canDeliver: () => !abort && Boolean(wakeDelivery),
    deliver: (event, claim, text) => wakeDelivery(event, claim, text),
    onError: error => options.onError?.(error),
  });

  async function* runStreamed(input, runOptions = {}) {
    if (abort) throw new Error("internal coding thread is already running");
    abort = new AbortController();
    const controller = abort;
    const queue = [];
    let wake = null;
    let done = false;
    let failure = null;
    const push = (event) => { queue.push(event); if (wake) { wake(); wake = null; } };
    const cancelled = () => controller.abort(runOptions.signal?.reason);
    if (runOptions.signal?.aborted) cancelled();
    runOptions.signal?.addEventListener("abort", cancelled, { once: true });
    const activeTools = new Map();
    let toolSequence = 0;
    const publishPlan = () => push({ type: "plan", ...buildPlanSetPayload(state.executionState) });
    const callbacks = {
      signal: controller.signal,
      runtimeContext: runOptions.runtimeContext || {},
      ...(Array.isArray(runOptions.attachments) && runOptions.attachments.length > 0
        ? { attachments: runOptions.attachments }
        : {}),
      onRuntimeEvent: event => push({ type: "runtime_event", event }),
      onDelta: (delta) => push({ type: "text_delta", delta }),
      onThinkingDelta: (delta) => push({ type: "thinking_delta", delta }),
      onPhase: (phase) => push({ type: "phase", phase }),
      onContextUsage: (meter) => push({ type: "context_usage", meter }),
      onToolEvent: (event) => {
        const key = JSON.stringify([event.tool, event.args || {}, event.origin || null]);
        const stack = activeTools.get(key) || [];
        if (event.phase === "start") {
          const id = String(event.callId || event.toolCallId || event.id || `native-tool-${randomUUID()}`);
          stack.push(id); activeTools.set(key, stack);
          push({ type: "tool_call", toolCallId: id, name: event.tool, args: event.args });
        } else if (event.phase === "end" || event.phase === "error") {
          const id = stack.pop() || String(event.callId || event.toolCallId || event.id || `native-tool-${++toolSequence}`);
          if (!stack.length) activeTools.delete(key);
          push({ type: "tool_result", toolCallId: id, output: event.result || event.error || "", is_error: event.phase === "error" });
          publishPlan();
        }
      },
    };
    const runTask = options.runTask || agent.runNaturalLanguageTask;
    const work = Promise.resolve().then(async () => {
      push({ type: "turn_started" });
      const { hasPendingUserInteraction, formatInteractionPromptLines } = require("./context/userInteraction");
      const pending = hasPendingUserInteraction(state.executionState);
      let result;
      if (pending && !options.runTask) {
        push({ type: "phase", phase: { type: "applying_reply" } });
        result = await agent.resumeAfterUserInteraction(runOptions.userInput ?? input, state, callbacks);
      } else result = await runTask(input, state, callbacks);
      if (result?.ok === false) {
        const error = new Error(result.error || "native coding task failed");
        if (result.cancelled || controller.signal.aborted) error.code = "cancelled";
        throw error;
      }
      if (!result?.streamed && result?.summary) push({ type: "text_delta", delta: result.summary });
      if (hasPendingUserInteraction(state.executionState)) {
        const { getPendingUserInteraction } = require("./context/userInteraction");
        push({ type: "interaction", lines: formatInteractionPromptLines(getPendingUserInteraction(state.executionState), { cols: 80 }) });
      }
      if (!options.runTask) agent.persistSessionState(state);
      publishPlan();
      if (result?.contextMeter || state.contextMeter) push({ type: "context_usage", meter: result?.contextMeter || state.contextMeter });
      const finalText = result?.finalText ?? result?.summary;
      push({ type: "turn_completed", usage: result?.usage || result?.metrics || null,
        ...(typeof finalText === "string" ? { finalText } : {}) });
    }).catch((error) => { failure = error; }).finally(() => {
      done = true;
      if (wake) { wake(); wake = null; }
    });
    try {
      while (!done || queue.length) {
        if (queue.length) yield queue.shift();
        else await new Promise((resolve) => { wake = resolve; });
      }
      if (failure) throw failure;
    } finally {
      controller.abort();
      await work;
      runOptions.signal?.removeEventListener("abort", cancelled);
      abort = null;
    }
  }

  function configure({ model, thinkingLevel, permissionMode } = {}) {
    if (model !== undefined) {
      const nextModel = String(model || "").trim();
      if (nextModel) {
        state.model = nextModel;
        state.context = agent.buildNlContext({ workspaceRoot, provider: state.provider, model: state.model });
      }
    }
    if (thinkingLevel !== undefined) {
      const normalized = normalizeThinkingLevel(thinkingLevel);
      if (normalized) {
        state.thinking = normalized;
        applyThinkingLevelToEnv(normalized, process.env);
      }
    }
    if (permissionMode !== undefined) {
      const nextPerm = String(permissionMode || "").trim().toLowerCase();
      if (nextPerm) {
        state.permissionMode = nextPerm;
        try { process.env.UFOO_PERMISSION_MODE = nextPerm; } catch {}
      }
    }
    return {
      model: state.model,
      thinkingLevel: state.thinking,
      permissionMode: state.permissionMode,
    };
  }

  function clear() {
    if (abort) {
      try { abort.abort("user_cleared"); } catch {}
    }
    state.nlMessages = [];
    state.executionState = undefined;
    state.contextMeter = undefined;
    state.sessionId = `ucode-${randomUUID()}`;
    state.context = agent.buildNlContext({ workspaceRoot, provider: state.provider, model: state.model });
    return { ok: true, sessionId: state.sessionId };
  }

  return {
    get id() { return state.sessionId; },
    get model() { return state.model; },
    get thinkingLevel() { return state.thinking; },
    get permissionMode() { return state.permissionMode; },
    configure,
    clear,
    runStreamed,
    async pollWakes(deliver) { wakeDelivery = deliver; try { await wakeHost.tick(); } finally { wakeDelivery = null; } },
    close: async () => { wakeHost.close(); if (abort) abort.abort("runtime_closed"); },
  };
}

module.exports = { createInternalCodingThread };
