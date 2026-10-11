"use strict";

const { randomUUID } = require("crypto");
const { loadConfig } = require("../config");
const { resolveKimiUpstreamCredentials } = require("../agents/providers/credentials/kimi");
const { resolveCodexUpstreamCredentials } = require("../agents/providers/credentials/codex");
const { resolveRuntimeConfig, resolveTransport, resolveCompletionUrl, resolveResponsesUrl, resolveAnthropicMessagesUrl, DEFAULT_OPENAI_BASE_URL } = require("../agents/providers/runtimeConfig");
const { getNativeTransport, createNativeSseDispatcher, resolveReasoningEffort, normalizeTimeoutMs, createUsageTotals, cloneMessageList } = require("../agents/providers/nativeTransport");
const { createAgentRuntime } = require("../agents/runtime/createAgentRuntime");
const { createCodingCapability } = require("../agents/capabilities/coding");
const { createPlanningCapability } = require("../agents/capabilities/planning");
const { createSkillsCapability } = require("../agents/capabilities/skills");
const codingProfile = require("../agents/profiles/coding");
const { runCoreToolAsync } = require("./tools/executor");
const { sanitizeModelMessages } = require("./context/assembler");
const { retireMessageImages } = require("../agents/providers/transports/visionBlocks");
const { resolveToolBudget, DEFAULT_TASK_TIMEOUT_MS } = require("../agents/runtime/core/executionBudget");
const { clearUserPrompts } = require("./context/userNudge");
const { runProviderTurnGate, resolveCall, checkFaultPoint, materializeAnswerToolResult } = require("./protocol");
const { appendUsageRecord } = require("./usageStore");
const { buildCoreToolSpecs, buildAnthropicToolSpecs } = require("./tools/specs");
const { createContextManager } = require("../agents/runtime/context/compaction");
const { createCheckpointStore } = require("../agents/runtime/context/checkpointStore");
const { createRuntimeStore } = require("../agents/runtime/context/runtimeStore");
const { normalizeTraceContext } = require("../agents/runtime/protocol/traceContext");
const { redactSecrets } = require("../runtime/privacy/redactor");

const DEFAULT_NATIVE_TIMEOUT_MS = DEFAULT_TASK_TIMEOUT_MS;
const DEFAULT_MAX_PLAN_AUTO_CONTINUES = 24;
const nowMs = () => Date.now();

function createGuards({ signal = null, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS } = {}) {
  const startedAt = nowMs();
  const budgetMs = normalizeTimeoutMs(timeoutMs);

  function ensureActive() {
    if (signal && typeof signal === "object" && signal.aborted) {
      const err = new Error("CLI cancelled");
      err.code = "cancelled";
      throw err;
    }
    if (nowMs() - startedAt > budgetMs) {
      const err = new Error(`CLI timeout (${budgetMs}ms)`);
      err.code = "timeout";
      throw err;
    }
  }

  return {
    ensureActive,
    budgetMs,
  };
}

async function runNativeLoop(options = {}) {
  const runtime = createAgentRuntime({
    profile: codingProfile,
    transport: options.transport,
    capabilities: [createCodingCapability(), createPlanningCapability(), createSkillsCapability()],
    host: { grantedPermissions: ["workspace.read", "workspace.write", "workspace.execute", "execution.control", "interaction.request"] },
    defaults: {
      sanitizeMessages: sanitizeModelMessages,
      retireImages: retireMessageImages,
      providerTurnGate: runProviderTurnGate,
      maxAutoContinues: DEFAULT_MAX_PLAN_AUTO_CONTINUES,
    },
  });
  return runtime.run({ ...options, toolBudget: resolveToolBudget(options.maxToolCalls) });
}

function appendAnswerToolResult(messages = [], resume = null, answer = {}, options = {}) {
  const materialized = materializeAnswerToolResult(messages, resume, answer);
  if (!materialized.ok) return materialized;
  const ledger = options && options.ledger ? options.ledger : null;
  if (ledger) {
    const call = resume && resume.call ? resume.call : null;
    const callId = String(
      (call && call.source && call.source.id) || (resume && resume.toolCallId) || ""
    ).trim();
    if (callId) {
      resolveCall(ledger, callId, {
        result: answer,
        isError: false,
        allowFromDeferred: true,
      });
    }
  }
  checkFaultPoint("after_answer_commit");
  return { ok: true };
}

async function runNativeAgentTask({
  workspaceRoot = process.cwd(),
  prompt = "",
  systemPrompt = "",
  systemBlocks = null,
  provider = "",
  model = "",
  messages = [],
  sessionId = "",
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
  maxToolCalls = undefined,
  onStreamDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  onToolEvent = null,
  onArtifactPersisted = null,
  onContextUsage = null,
  signal = null,
  executionState = null,
  resume = false,
  contextPolicy = {},
  runtimeContext = {},
  onRuntimeEvent = null,
} = {}) {
  const guards = createGuards({ signal, timeoutMs });
  const nextSessionId = String(sessionId || "").trim() || `native-${randomUUID()}`;
  const promptText = String(prompt || "").trim();
  const ids = normalizeTraceContext(runtimeContext);
  ids.taskRunId ||= `native-run-${randomUUID()}`;
  ids.taskId ||= ids.taskRunId;
  ids.traceId ||= ids.taskId;
  ids.requestId ||= ids.taskRunId;
  ids.attemptId ||= `attempt-${randomUUID()}`;
  const observation = createRuntimeStore({ workspaceRoot, namespace: "ucode", sessionId: nextSessionId, redact: redactSecrets });
  const observationWarnings = [];
  const observe = async event => {
    const value = { ...ids, agentId: process.env.UFOO_SUBSCRIBER_ID || "ucode", sessionId: nextSessionId, ...event };
    let committed = value;
    try {
      const state = observation.append(value);
      committed = observation.events({ after: state.sequence - 1 })[0];
    } catch (error) {
      if (!observationWarnings.length) {
        observationWarnings.push({ code: "observation_unavailable", error: error.message });
        console.error(`[ucode] observation unavailable: ${error.code || "write failed"}`);
        if (onRuntimeEvent) {
          try { await onRuntimeEvent(redactSecrets({ ...value, type: "observation.warning", warning: observationWarnings[0] })); } catch { /* observer failure is not task failure */ }
        }
      }
    }
    if (onRuntimeEvent) {
      try { await onRuntimeEvent(redactSecrets(committed)); } catch { /* display observers do not own execution */ }
    }
  };
  // Track every text delta so the error path can return the partial output
  // the model already produced instead of discarding it.
  let partialOutput = "";
  const trackingStreamDelta = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    partialOutput += text;
    if (typeof onStreamDelta === "function") {
      onStreamDelta(chunk);
    }
  };

  try {
    await observe({ type: "request.accepted", request: { ...ids, text: promptText } });
    await observe({ type: "task.started" });
    guards.ensureActive();

    if (!resume && !promptText) {
      await observe({ type: "task.failed", error: "empty task" });
      return {
        ok: false,
        error: "empty task",
        output: "",
        sessionId: nextSessionId,
        streamed: false,
      };
    }

    const runtime = resolveRuntimeConfig({
      workspaceRoot,
      provider,
      model,
    });

    let accountId = "";
    if (runtime.provider === "codex" && !runtime.apiKey) {
      try {
        const config = loadConfig(workspaceRoot) || {};
        const credential = await resolveCodexUpstreamCredentials({
          authPath: config.codexAuthPath,
          refreshWindowMs: Number(config.codexOauthRefreshWindowSec || 300) * 1000,
          env: process.env,
        });
        const token = String(credential && (credential.accessToken || credential.apiKey) || "").trim();
        if (token) {
          runtime.apiKey = token;
          runtime.apiKeySource = String(credential.source || "codex-credential");
        }
        const credentialKind = String(credential && credential.credentialKind || "").trim();
        if (
          credentialKind === "api-key"
          && !String(process.env.UFOO_UCODE_BASE_URL || "").trim()
          && !String(config.ucodeBaseUrl || "").trim()
        ) {
          runtime.baseUrl = String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim();
        }
        if (credentialKind === "oauth") {
          accountId = String(credential && credential.accountId || "").trim();
        }
      } catch {
        // The request will report the provider's auth error when no Codex
        // credential is available; keep runtime resolution non-throwing.
      }
    }

    // Kimi tokens expire; resolveRuntimeConfig reads the credential file
    // synchronously, so refresh it here (async) when the key came from that
    // file and the token is outside the fresh window.
    if (
      runtime.provider === "kimi"
      && runtime.apiKeySource === "kimi-credential"
      && runtime.kimiCredentialState !== "fresh"
    ) {
      try {
        const credential = await resolveKimiUpstreamCredentials({ env: process.env });
        const token = String(credential && credential.accessToken || "").trim();
        if (token) runtime.apiKey = token;
      } catch {
        // Keep the file token; the request itself will surface auth failures.
      }
    }

    const transport = getNativeTransport(runtime.transport);
    await observe({ type: "runtime.binding", binding: { provider: runtime.provider, model: runtime.model, transport: runtime.transport } });

    const runResult = await runNativeLoop({
      transport,
      workspaceRoot,
      prompt: resume ? "" : promptText,
      systemPrompt,
      systemBlocks,
      historyMessages: messages,
      model: runtime.model,
      requestKind: runtimeContext.requestKind || (runtimeContext.taskRunId ? "unknown" : "user"),
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      provider: runtime.provider,
      accountId,
      timeoutMs,
      maxToolCalls,
      onStreamDelta: trackingStreamDelta,
      onThinkingDelta,
      onPhase,
      onToolEvent,
      onArtifactPersisted,
      onContextUsage,
      sessionId: nextSessionId,
      signal,
      guards,
      executionState,
      resume: Boolean(resume),
      contextManager: createContextManager({ policy: contextPolicy,
        store: createCheckpointStore({ workspaceRoot, namespace: "ucode", sessionId: nextSessionId }) }),
      ...ids,
      agentId: process.env.UFOO_SUBSCRIBER_ID || "ucode",
      onEvent: observe,
    });

    const outputText = String(runResult.text || "").trim() || (
      runResult.toolCallsExecuted > 0
        ? `Completed ${runResult.toolCallsExecuted} tool call${runResult.toolCallsExecuted === 1 ? "" : "s"}.`
        : ""
    );

    const usage = runResult.usage && typeof runResult.usage === "object"
      ? runResult.usage
      : createUsageTotals();
    const { buildContextMeter } = require("./contextWindow");
    const contextMeter = buildContextMeter({
      usedTokens: usage.lastContextTokens,
      model: runtime.model,
    });
    appendUsageRecord(workspaceRoot, {
      sessionId: nextSessionId,
      model: runtime.model,
      provider: runtime.provider,
      turns: usage.turns,
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheCreation: usage.cacheCreation,
    });
    await observe({ type: signal?.aborted || runResult.stopReason === "cancelled" ? "task.cancelled" : runResult.error || runResult.stopReason ? "task.failed" : runResult.waitingUserInteraction ? "task.paused" : "task.completed",
      error: runResult.error || runResult.stopReason || "", result: { text: runResult.finalText || outputText, usage } });

    return {
      ok: !runResult.error,
      error: runResult.error || "",
      stopReason: runResult.stopReason || "",
      output: outputText,
      finalText: runResult.finalText,
      messages: cloneMessageList(runResult.messages),
      turnItems: cloneMessageList(runResult.turnItems),
      sessionId: nextSessionId,
      usage,
      contextMeter,
      executionState: runResult.executionState || executionState || null,
      // The loop marks streamed=true whenever it receives a stream callback;
      // only report it when the caller actually registered one.
      streamed: Boolean(runResult.streamed) && typeof onStreamDelta === "function",
      waitingUserInteraction: Boolean(runResult.waitingUserInteraction),
      interactionId: runResult.interactionId || "",
      protocolLedger: runResult.protocolLedger || null,
      ...(observationWarnings.length ? { observationWarnings } : {}),
    };
  } catch (err) {
    await observe({ type: signal?.aborted || err.code === "cancelled" ? "task.cancelled" : "task.failed", error: err.message || "native runner failed" });
    const message = err && err.message ? err.message : "native runner failed";
    if (executionState && typeof executionState === "object") {
      clearUserPrompts(executionState);
    }
    return {
      ok: false,
      error: message,
      output: partialOutput.trim(),
      sessionId: nextSessionId,
      streamed: false,
      executionState: executionState || null,
      ...(observationWarnings.length ? { observationWarnings } : {}),
    };
  }
}

module.exports = {
  runNativeAgentTask,
  runCoreToolAsync,
  appendAnswerToolResult,
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveResponsesUrl,
  resolveAnthropicMessagesUrl,
  resolveTransport,
  resolveReasoningEffort,
  createNativeSseDispatcher,
  buildCoreToolSpecs,
  buildAnthropicToolSpecs,
};
