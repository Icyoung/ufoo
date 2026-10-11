"use strict";

const { randomUUID } = require("crypto");
const ledgerApi = require("../protocol/toolCallLedger");
const { materializeResolvedToolResults } = require("../protocol/materialize");
const { withFaultPoint } = require("../protocol/faultHarness");
const { ToolLoopGuard } = require("./toolLoopGuard");
const { buildContextMeter, contextTokensFromUsage } = require("../context/contextWindow");
const { isContextOverflow } = require("../context/compaction");
const { buildRunObservation, observationFingerprint } = require("../protocol/runObservation");

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
  thinkingLevel = "", requestKind = "unknown",
  timeoutMs = 43200000, onStreamDelta = null, onThinkingDelta = null,
  onPhase = null, onToolEvent = null, onArtifactPersisted = null, onContextUsage = null,
  sessionId = "", signal = null, guards = null, executionState: initialState = null,
  resume = false, toolBudget = {}, maxAutoContinues = 24,
  sanitizeMessages = (messages) => messages, retireImages = () => {},
  providerTurnGate = null, maxRounds = Infinity, onEvent = null,
  projectId = "", agentId = "", taskId = "", taskRunId = "", attemptId = "", requestId = "",
  traceId = "", parentTaskRunId = "", parentSessionId = "",
  artifactNamespace = "ucode",
  contextManager = null, historyOffset: restoredHistoryOffset = null,
} = {}) {
  const requestModel = String(model || "").trim();
  if (!requestModel) throw new Error("agent model is not configured");
  if (!tools || typeof tools.execute !== "function") throw new Error("agent tool registry is required");
  const requestUrl = transport.resolveUrl(baseUrl);
  if (!requestUrl) throw new Error("agent baseUrl is not configured");
  const signalGuards = createExecutionGuards({ signal, timeoutMs });
  const activeGuards = guards ? { ensureActive() { signalGuards.ensureActive(); guards.ensureActive(); } } : signalGuards;
  const messages = sanitizeMessages(clone(historyMessages));
  const historyOffset = restoredHistoryOffset ?? (resume ? 0 : messages.filter(message => message.role !== "system").length);
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
  let lastContextEstimate = 0;
  let forceCompaction = false;
  let contextRetry = false;
  const context = () => ({ executionState, messages, loopGuard, usage, toolCallsExecuted, toolErrors, turnId });
  const event = async (type, data = {}) => {
    if (onEvent) await onEvent({ type, time: new Date().toISOString(), projectId, agentId, sessionId, taskId, taskRunId, attemptId, requestId, turnId,
      traceId: traceId || taskId || taskRunId, parentTaskRunId, parentSessionId, ...data });
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
    text: aggregated, finalText: "", streamed, toolCallsExecuted, messages,
    turnItems: currentTurnItems(), usage, executionState,
    protocolLedger: lastLedger || ledgerApi.snapshotLedger(activeLedger), historyOffset, ...extra,
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
  const toolContext = (extra = {}) => ({ workspaceRoot, onToolEvent: typeof onToolEvent === "function" ? event => onToolEvent({ ...event,
    ...(event.origin ? { parentToolCallId: extra.toolCallId } : { toolCallId: extra.toolCallId }) }) : null, sessionId, onArtifactPersisted, executionState, signal,
    projectId, agentId, taskId, taskRunId, attemptId, requestId, turnId, traceId: traceId || taskId || taskRunId, parentTaskRunId, parentSessionId, artifactNamespace, ...extra });
  if (onEvent) await event("run.config", { configuration: buildRunObservation({ provider, model: requestModel,
    transport: transport.name || transport.id || "", thinkingLevel, systemPrompt, systemBlocks, prompt,
    tools: tools.toOpenAiTools(), resume, requestKind, engineFingerprint: LOOP_IMPLEMENTATION_FINGERPRINT }) });
  if (resume) await withFaultPoint("before_provider_resume", () => {});

  while (true) {
    activeGuards.ensureActive();
    const turnStop = await policyStop("beforeTurn");
    if (turnStop) return finish(turnStop);
    if (usage.turns >= maxRounds) return finish({ stopReason: "budget_exceeded" });
    turnId = `turn_${randomUUID()}`;
    providerMessages = messages;
    for (const policy of policies) {
      if (policy.prepareTurn) providerMessages = await policy.prepareTurn({ ...context(), providerMessages }) || providerMessages;
    }
    isolatedPrefix = providerMessages.length;
    if (activeLedger) {
      if (providerTurnGate) providerTurnGate(activeLedger);
      else if (ledgerApi.listUnresolved(activeLedger).length || ledgerApi.listDeferred(activeLedger).length) {
        throw new Error("unresolved tool calls before provider turn");
      }
    }
    const action = loopGuard.nextAction();
    if (action) await event(`loop.${action.kind === "stop" ? "stopped" : "warning"}`, { code: "repeated_tool_calls", repeatedSteps: loopGuard.count, toolNames: loopGuard.names });
    if (action && action.kind === "stop") return finish({ error: action.message, stopReason: "repeated_tool_calls" });
    if (action && action.kind === "warn") providerMessages.push({ role: "user", content: action.message });
    mirror();

    let maxOutputTokens;
    if (contextManager) {
      let prepared;
      try { prepared = await contextManager.prepare({ messages: providerMessages, model: requestModel, systemPrompt, systemBlocks,
        tools: tools.toOpenAiTools(), transport, signal, onPhase, onEvent: event,
        lastUsage: usage.lastContextTokens, lastEstimate: lastContextEstimate,
        force: forceCompaction,
        request: { url: requestUrl, apiKey, provider, accountId, requestHeaders, requestProfile, sessionId } }); }
      catch (error) {
        // Preflight runs only after tool results are paired. Keep this complete
        // transcript even when compression is cancelled or storage is broken.
        return finish({ error: error.message, stopReason: error.code || "context_compression_failed" });
      }
      providerMessages = prepared.messages;
      lastContextEstimate = prepared.estimatedTokens;
      maxOutputTokens = prepared.maxOutputTokens;
      forceCompaction = false;
    }
    // Only newly generated messages are mirrored into the full transcript.
    isolatedPrefix = providerMessages.length;

    try { activeGuards.ensureActive(); }
    catch (error) { return finish({ error: error.message, stopReason: error.code || "runtime_error" }); }
    const modelStarted = Date.now();
    await event("model.started", { provider, model: requestModel, transport: transport.name || transport.id || "", estimatedInputTokens: lastContextEstimate });
    const streamEvents = [];
    let streamEventError = null;
    let turnResult;
    let turnError = null;
    const outputBeforeTurn = aggregated.length;
    try { turnResult = await transport.runTurn({
      url: requestUrl, apiKey, model: requestModel, provider, accountId, requestHeaders, requestProfile, thinkingLevel,
      systemPrompt, systemBlocks, messages: providerMessages, tools: tools.toOpenAiTools(),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      sessionId, signal, timeoutMs,
      onPhase(phase) {
        streamEvents.push(event("model.phase", { phase }).catch(error => { streamEventError ||= error; }));
        onPhase?.(phase);
      },
      onThinkingDelta(delta) {
        streamEvents.push(event("thinking.delta", { text: String(delta || "") }).catch(error => { streamEventError ||= error; }));
        onThinkingDelta?.(delta);
      },
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
    }); } catch (error) { turnError = error; } finally {
      await Promise.all(streamEvents);
      if (streamEventError) throw streamEventError;
    }
    if (turnError) {
      await event("model.failed", { error: turnError.message, code: turnError.code || "provider_error", durationMs: Date.now() - modelStarted });
      if (!contextManager || !isContextOverflow(turnError)) throw turnError;
      if (contextRetry || aggregated.length !== outputBeforeTurn) return finish({ error: turnError.message, stopReason: "context_budget_exceeded" });
      contextRetry = true;
      forceCompaction = true;
      await event("model.retry", { code: "context_overflow", retry: 1 });
      continue;
    }
    contextRetry = false;
    activeGuards.ensureActive();
    retireImages(providerMessages);
    if (providerMessages !== messages) retireImages(messages);
    usage.turns += 1;
    for (const key of ["input", "output", "cacheRead", "cacheCreation"]) usage[key] += count(turnResult && turnResult.usage && turnResult.usage[key]);
    usage.lastContextTokens = contextTokensFromUsage(turnResult && turnResult.usage);
    await event("model.completed", { usage: turnResult && turnResult.usage || {}, durationMs: Date.now() - modelStarted });
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
        await event("model.retry", { code: "empty_response", retry: emptyRetries });
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
      if (continuation) {
        await event("model.retry", { code: "auto_continue", retry: autoContinues });
        continue;
      }
      return finish({ finalText: text });
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
      for (const call of pending) {
        await event("tool.rejected", { toolCallId: callId(call), toolName: call.name, code: batchError.code || "invalid_batch", argumentFingerprint: observationFingerprint(call.args) });
        resolve(call, batchError); toolCallsExecuted += 1; toolErrors += 1;
      }
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
        await event("tool.rejected", { toolCallId: callId(call), toolName: name, code: before.stopReason || "stopped", argumentFingerprint: observationFingerprint(call.args) });
        resolve(call, { ok: false, code: before.stopReason || "stopped", error: "execution stopped before tool invocation" });
        continue;
      }
      let blocked = null;
      for (const policy of policies) if (policy.validateTool) { blocked = policy.validateTool(name, executionState); if (blocked) break; }
      if (blocked) {
        await event("tool.rejected", { toolCallId: callId(call), toolName: name, code: blocked.code || "tool_not_allowed", argumentFingerprint: observationFingerprint(call.args) });
        toolCallsExecuted += 1; toolErrors += 1; resolve(call, blocked); continue;
      }
      const resumeCall = tools.deferableTools().includes(name) ? { toolCallId: callId(call), toolName: name, call: { name: call.name, args: call.args, source: call.source } } : null;
      ledgerApi.markExecuting(activeLedger, callId(call));
      activeGuards.ensureActive();
      await event("tool.started", { toolCallId: callId(call), toolName: name, args: call.args, argumentFingerprint: observationFingerprint(call.args) });
      const toolStarted = Date.now();
      let result;
      try { result = await tools.execute(name, call.args, toolContext({ resume: resumeCall, toolCallId: callId(call) })); }
      catch (error) {
        await event("tool.failed", { toolCallId: callId(call), toolName: name, error: error.message, code: error.code || "tool_execution_failed",
          outcome: "unknown", durationMs: Date.now() - toolStarted });
        throw error;
      }
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
      await event("tool.completed", { toolCallId: callId(call), toolName: name, result: sanitizeResult(result), durationMs: Date.now() - toolStarted });
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

const LOOP_IMPLEMENTATION_FINGERPRINT = observationFingerprint(runAgentLoop.toString());

module.exports = { runAgentLoop, createExecutionGuards };
