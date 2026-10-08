"use strict";

// Embedded host for the same native coding runner used by standalone ucode.
const { randomUUID } = require("crypto");
const agent = require("./agent");
const { buildPlanSetPayload } = require("../ui/agentPresentation");

function createInternalCodingThread(options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const resolved = agent.resolveUcodeProviderModel({ workspaceRoot, model: options.model || "" });
  const state = {
    workspaceRoot, ...resolved, engine: "ufoo-core",
    context: agent.buildNlContext({ workspaceRoot, ...resolved }),
    nlMessages: [], sessionId: options.sessionId || `ucode-${randomUUID()}`,
  };
  if (options.sessionId) agent.resumeSessionState(state, options.sessionId, workspaceRoot);
  let abort = null;

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
      onDelta: (delta) => push({ type: "text_delta", delta }),
      onThinkingDelta: (delta) => push({ type: "thinking_delta", delta }),
      onPhase: (phase) => push({ type: "phase", phase }),
      onContextUsage: (meter) => push({ type: "context_usage", meter }),
      onToolEvent: (event) => {
        const key = JSON.stringify([event.tool, event.args || {}, event.origin || null]);
        const stack = activeTools.get(key) || [];
        if (event.phase === "start") {
          const id = String(event.callId || event.toolCallId || event.id || `native-tool-${++toolSequence}`);
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
      push({ type: "turn_completed", usage: result?.usage || result?.metrics || null });
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

  return { id: state.sessionId, runStreamed, close: async () => { if (abort) abort.abort(); } };
}

module.exports = { createInternalCodingThread };
