"use strict";

const { randomUUID } = require("crypto");
const ledgerApi = require("../protocol/toolCallLedger");
const { materializeResolvedToolResults } = require("../protocol/materialize");
const { withFaultPoint } = require("../protocol/faultHarness");
const { ToolLoopGuard } = require("./toolLoopGuard");
const { buildContextMeter, contextTokensFromUsage } = require("../context/contextWindow");

const clone = (value) => JSON.parse(JSON.stringify(value));
const count = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0;

function createExecutionGuards({ signal = null, timeoutMs = 43200000 } = {}) {
  const started = Date.now();
  return { ensureActive() {
    if (signal && signal.aborted) throw Object.assign(new Error("agent cancelled"), { code: "cancelled" });
    if (Date.now() - started > timeoutMs) throw Object.assign(new Error(`agent timeout (${timeoutMs}ms)`), { code: "timeout" });
  } };
}

/** Shared model/tool loop. All business policies and tools are injected. */
async function runAgentLoop({
  transport, tools, policies = [], workspaceRoot = process.cwd(),
  prompt = "", systemPrompt = "", systemBlocks = null, historyMessages = [],
  model = "", baseUrl = "", apiKey = "", provider = "", accountId = "", requestHeaders = {}, requestProfile = "",
  timeoutMs = 43200000, onStreamDelta = null, onThinkingDelta = null,
  onPhase = null, onToolEvent = null, onArtifactPersisted = null, onContextUsage = null,
  sessionId = "", signal = null, guards = null, executionState: initialState = null,
  resume = false, toolBudget = {}, maxAutoContinues = 24,
  sanitizeMessages = (messages) => messages, retireImages = () => {},
  providerTurnGate = null, maxRounds = Infinity, onEvent = null,
  projectId = "", agentId = "", taskId = "", taskRunId = "", attemptId = "", requestId = "",
  artifactNamespace = "ucode",
} = {}) {
  const requestModel = String(model || "").trim();
  if (!requestModel) throw new Error("agent model is not configured");
  if (!tools || typeof tools.execute !== "function") throw new Error("agent tool registry is required");
  const requestUrl = transport.resolveUrl(baseUrl);
  if (!requestUrl) throw new Error("agent baseUrl is not configured");
  const signalGuards = createExecutionGuards({ signal, timeoutMs });
  const activeGuards = guards ? { ensureActive() { signalGuards.ensureActive(); guards.ensureActive(); } } : signalGuards;
  const messages = sanitizeMessages(clone(historyMessages));
  if (!resume) transport.prepareMessages({ messages, systemPrompt, prompt });
  const outputStart = messages.length;
  const currentTurnItems = () => clone(messages.slice(outputStart)).filter((message) => (
    String(message.role || "").toLowerCase() !== "user" || Array.isArray(message.content)
      && message.content.some((block) => ["tool_result", "image", "image_url"].includes(block.type))
  ));
  let executionState = initialState;
  for (const policy of policies) if (policy.initializeState) executionState = policy.initializeState(executionState);
  if (!executionState || typeof executionState !== "object") executionState = {};
  const loopGuard = new ToolLoopGuard({ tightTools: tools.tightTools() });
  const usage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, lastContextTokens: 0 };
  let aggregated = "";
  let streamed = false;
  let toolCallsExecuted = 0;
  let toolErrors = 0;
  let emptyRetries = 0;
  let activeLedger = null;
  let lastLedger = null;
  let autoContinues = 0;
  let lastContinueKey = "";
  let emptyContinues = 0;
  let providerMessages = messages;
  let isolatedPrefix = 0;
  let turnId = "";
  const context = () => ({ executionState, messages, loopGuard, usage, toolCallsExecuted, toolErrors, turnId });
  const event = async (type, data = {}) => {
    if (onEvent) await onEvent({ type, projectId, agentId, sessionId, taskId, taskRunId, attemptId, requestId, turnId, ...data });
  };
  const policyStop = async (hook, extra = {}) => {
    for (const policy of policies) {
      const stop = policy[hook] && await policy[hook]({ ...context(), ...extra });
      if (stop) return typeof stop === "string" ? { stopReason: stop } : stop;
    }
    return null;
  };
  const sanitizeResult = (result) => policies.reduce((value, policy) => policy.sanitizeResult ? policy.sanitizeResult(value) : value, result);
  const callId = (call) => String(call.source && call.source.id || "");
  const resolve = (call, result) => ledgerApi.resolveCall(activeLedger, callId(call), { result: sanitizeResult(result), isError: !result || result.ok === false });
  const mirror = () => {
    if (providerMessages === messages) return;
    messages.push(...clone(providerMessages.slice(isolatedPrefix)));
    isolatedPrefix = providerMessages.length;
  };
  const finish = (extra = {}) => ({
    text: aggregated, streamed, toolCallsExecuted, messages,
    turnItems: currentTurnItems(), usage, executionState,
    protocolLedger: lastLedger || ledgerApi.snapshotLedger(activeLedger), ...extra,
  });
  const flush = (calls) => {
    const pendingById = Object.fromEntries(calls.map((call) => [callId(call), call]));
    materializeResolvedToolResults(activeLedger, { transport, messages: providerMessages, pendingById });
    mirror();
    lastLedger = ledgerApi.snapshotLedger(activeLedger);
  };
  const pendingInteraction = () => {
    for (const policy of policies) {
      const pending = policy.pendingInteraction && policy.pendingInteraction(executionState);
      if (pending) return pending;
    }
    return null;
  };
  const toolContext = (extra = {}) => ({ workspaceRoot, onToolEvent, sessionId, onArtifactPersisted, executionState, signal,
    projectId, agentId, taskId, taskRunId, attemptId, requestId, turnId, artifactNamespace, ...extra });
  if (resume) await withFaultPoint("before_provider_resume", () => {});

  while (true) {
    activeGuards.ensureActive();
    const turnStop = await policyStop("beforeTurn");
    if (turnStop) return finish(turnStop);
    if (usage.turns >= maxRounds) return finish({ stopReason: "budget_exceeded" });
    turnId = `turn_${randomUUID()}`;
    providerMessages = messages;
    for (const policy of policies) {
      if (policy.prepareTurn) providerMessages = policy.prepareTurn({ ...context(), providerMessages }) || providerMessages;
    }
    isolatedPrefix = providerMessages.length;
    if (activeLedger) {
      if (providerTurnGate) providerTurnGate(activeLedger);
      else if (ledgerApi.listUnresolved(activeLedger).length || ledgerApi.listDeferred(activeLedger).length) {
        throw new Error("unresolved tool calls before provider turn");
      }
    }
    const action = loopGuard.nextAction();
    if (action && action.kind === "stop") return finish({ error: action.message, stopReason: "repeated_tool_calls" });
    if (action && action.kind === "warn") providerMessages.push({ role: "user", content: action.message });

    await event("model.started");
    const streamEvents = [];
    let streamEventError = null;
    let turnResult;
    try { turnResult = await transport.runTurn({
      url: requestUrl, apiKey, model: requestModel, provider, accountId, requestHeaders, requestProfile,
      systemPrompt, systemBlocks, messages: providerMessages, tools: tools.toOpenAiTools(),
      sessionId, signal, timeoutMs, onPhase, onThinkingDelta,
      onTextDelta(chunk) {
        const text = String(chunk || "");
        if (!text) return;
        aggregated += text;
        if (onEvent) {
          streamed = true;
          streamEvents.push(event("message.delta", { text }).catch((error) => { streamEventError = streamEventError || error; }));
        }
        if (typeof onStreamDelta === "function") { streamed = true; onStreamDelta(text); }
      },
    }); } finally {
      await Promise.all(streamEvents);
      if (streamEventError) throw streamEventError;
    }
    activeGuards.ensureActive();
    retireImages(providerMessages);
    if (providerMessages !== messages) retireImages(messages);
    usage.turns += 1;
    for (const key of ["input", "output", "cacheRead", "cacheCreation"]) usage[key] += count(turnResult && turnResult.usage && turnResult.usage[key]);
    usage.lastContextTokens = contextTokensFromUsage(turnResult && turnResult.usage);
    await event("model.completed", { usage: turnResult && turnResult.usage || {} });
    if (typeof onContextUsage === "function") {
      try { onContextUsage(buildContextMeter({ usedTokens: usage.lastContextTokens, model: requestModel })); } catch { /* observer only */ }
    }
    const calls = transport.getToolCalls(turnResult);
    if (!calls.length) {
      loopGuard.reset();
      const text = String(turnResult.text || "").trim();
      if (!text && toolCallsExecuted > 0) {
        if (emptyRetries >= 2) throw new Error("model returned an empty response after tool execution");
        emptyRetries += 1;
        providerMessages.push({ role: "user", content: "Continue the current task after the tool results. Call any remaining tools, or provide a concrete final answer to the user. Do not end the turn with an empty response." });
        mirror();
        continue;
      }
      emptyRetries = 0;
      let legacy = null;
      for (const policy of policies) if (policy.legacyCommand) { legacy = policy.legacyCommand(text); if (legacy) break; }
      transport.appendFinalAssistantMessage({ messages: providerMessages, turnResult });
      if (legacy) {
        activeGuards.ensureActive();
        const result = await tools.execute(legacy.tool, legacy.args, toolContext({ origin: legacy.origin }));
        activeGuards.ensureActive();
        if (result && result.executionState) executionState = result.executionState;
        providerMessages.push({ role: "user", content: JSON.stringify({ type: legacy.resultType, ...sanitizeResult(result && result.status ? result : { status: "rejected", ok: false, error: `${legacy.tool} failed` }) }) });
        mirror();
        continue;
      }
      mirror();
      if (!aggregated.trim() && text) aggregated = text;
      let continuation = false;
      if (autoContinues < maxAutoContinues) {
        for (const policy of policies) {
          const key = policy.continuationKey ? policy.continuationKey(context()) : "continuation";
          if (emptyContinues >= 2 && key && key === lastContinueKey) continue;
          if (policy.continueAfterFinal && policy.continueAfterFinal(context())) {
            autoContinues += 1; emptyContinues += 1; lastContinueKey = key; continuation = true; break;
          }
        }
      }
      if (continuation) continue;
      return finish();
    }
    emptyContinues = 0;
    emptyRetries = 0;
    const pending = transport.prepareToolCalls({ messages: providerMessages, turnResult, toolCalls: calls });
    if (!pending) { mirror(); return finish(); }
    loopGuard.observe(pending);
    activeLedger = ledgerApi.createToolCallLedger({ provider, sessionId, deferableTools: tools.deferableTools() });
    for (const call of pending) {
      if (!call.source) call.source = {};
      if (!call.source.id) call.source.id = `call_${randomUUID()}`;
    }
    if (new Set(pending.map(callId)).size !== pending.length) {
      throw Object.assign(new Error("duplicate tool call IDs in provider turn"), { code: "duplicate_tool_call_id" });
    }
    ledgerApi.declareCalls(activeLedger, pending.map((call) => ({ callId: callId(call), name: String(call.name || "").toLowerCase(), args: call.args })));
    lastLedger = ledgerApi.snapshotLedger(activeLedger);
    await withFaultPoint("after_prepare_tool_calls", () => {});
    await withFaultPoint("before_tool_exec", () => {});
    let batchError = null;
    for (const policy of policies) if (policy.validateBatch) { batchError = policy.validateBatch(pending); if (batchError) break; }
    if (batchError) {
      for (const call of pending) { resolve(call, batchError); toolCallsExecuted += 1; toolErrors += 1; }
      flush(pending);
      continue;
    }
    let deferred = null;
    let toolStop = null;
    for (const call of pending) {
      const name = String(call.name || "").trim().toLowerCase();
      const before = toolStop || await policyStop("beforeTool", { call });
      if (before) {
        toolStop = before;
        resolve(call, { ok: false, code: before.stopReason || "stopped", error: "execution stopped before tool invocation" });
        continue;
      }
      let blocked = null;
      for (const policy of policies) if (policy.validateTool) { blocked = policy.validateTool(name, executionState); if (blocked) break; }
      if (blocked) { toolCallsExecuted += 1; toolErrors += 1; resolve(call, blocked); continue; }
      const resumeCall = tools.deferableTools().includes(name) ? { toolCallId: callId(call), toolName: name, call: { name: call.name, args: call.args, source: call.source } } : null;
      ledgerApi.markExecuting(activeLedger, callId(call));
      activeGuards.ensureActive();
      await event("tool.started", { toolCallId: callId(call), toolName: name, args: call.args });
      const result = await tools.execute(name, call.args, toolContext({ resume: resumeCall, toolCallId: callId(call) }));
      activeGuards.ensureActive();
      if (result && result.executionState) executionState = result.executionState;
      toolCallsExecuted += 1;
      if (!result || result.ok === false) toolErrors += 1;
      if (resumeCall && result && result.deferToolResult) {
        for (const policy of policies) if (policy.onDeferred) policy.onDeferred({ executionState, resume: resumeCall, provider });
        ledgerApi.deferCall(activeLedger, callId(call), { reason: name });
        deferred = { interactionId: result.interactionId || "" };
        await event("interaction.requested", { toolCallId: callId(call), interactionId: deferred.interactionId });
        continue;
      }
      resolve(call, result);
      await event("tool.completed", { toolCallId: callId(call), toolName: name, result: sanitizeResult(result) });
      toolStop = await policyStop("afterTool", { call, result });
      if (toolStop) continue;
      if (toolBudget.maxToolCalls != null && toolCallsExecuted >= toolBudget.maxToolCalls) throw new Error(`tool call budget exceeded (${toolBudget.maxToolCalls})`);
      if (toolErrors >= (toolBudget.maxToolErrors ?? 20)) {
        const detail = [call.name, result && result.error].filter(Boolean).join(": ");
        throw new Error(`tool error budget exceeded (${toolBudget.maxToolErrors ?? 20})${detail ? `: ${detail}` : ""}`);
      }
    }
    flush(pending);
    if (toolStop) return finish(toolStop);
    const interaction = pendingInteraction();
    if (deferred || interaction) return finish({ waitingUserInteraction: true, interactionId: deferred && deferred.interactionId || interaction && interaction.id || "" });
  }
}

module.exports = { runAgentLoop, createExecutionGuards };
