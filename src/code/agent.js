const fs = require("fs");
const path = require("path");
const { runToolCall } = require("./dispatch");
const { runNativeAgentTask } = require("./nativeRunner");
const { runDecomposedTask } = require("./taskDecomposer");
const { loadConfig, defaultAgentModelForProvider, sameModelProvider } = require("../config");
const {
  resolveSessionId,
  normalizeSessionId,
  saveSessionSnapshot,
  loadSessionSnapshot,
} = require("./sessionStore");
const { buildSkillInjections } = require("./skills");
const {
  assembleModelContext,
  syncMessagesToTranscript,
  applyContextSideEffects,
  ensureProjectSnapshot,
  recordToolCallInSession,
  commitAfterSegmentEnd,
  sanitizeModelMessages,
} = require("./context/assembler");
const { buildLayeredSystemPrompt } = require("./context/promptLayers");
const {
  createProjectPreflightContextV2,
} = require("./context/projectSnapshot");
const {
  ensureTaskContract,
  ensureStateEpoch,
  parseStructuredSideEffects,
  patchTaskContractFromUserMessage,
} = require("./context/stateCommit");
const { applyWorkingSetPlan } = require("./context/workingSet");
const {
  normalizePlanGraphCommand,
  runPlanGraphCommand,
} = require("./context/planGraphService");
const {
  shouldFrameAsUserReminder,
  buildContinuationUserPrompt,
  clearUserPrompts,
} = require("./context/userNudge");
const {
  runUbusCommand,
  parseBusCheckOutput,
  extractBusMessageTask,
  runShellCapture,
  stripAnsi,
  busCheckOutputIndicatesPending,
  resolvePendingQueueFile,
  resolveUfooProjectRoot,
  countPendingQueueLines,
  getPendingBusCount,
  drainJsonlFile,
  extractTaskFromBusEvent,
  shouldAutoConsumeBus,
} = require("./busConsumer");
const {
  runUcodeCoreAgent,
  runSingleCommand,
  extractAgentNickname,
  parseAgentArgs,
} = require("./repl");

function ensureContextSessionState(state = {}) {
  if (!Array.isArray(state.workingSet)) state.workingSet = [];
  if (!state.executionState || typeof state.executionState !== "object") {
    const { emptyExecutionState } = require("./context/executionSegment");
    state.executionState = emptyExecutionState();
  }
  if (typeof state.executionState.planMode !== "boolean") {
    state.executionState.planMode = false;
  }
  if (!Array.isArray(state.executionState.pendingUserPrompts)) {
    state.executionState.pendingUserPrompts = [];
  }
  if (!state.executionState.planGraph || typeof state.executionState.planGraph !== "object") {
    state.executionState.planGraph = require("./context/planGraphService").emptyPlanGraphState();
  }
  require("./context/planProjection").ensurePlanUiState(state.executionState);
  if (!state.contextPolicy || typeof state.contextPolicy !== "object") {
    const { defaultContextPolicy } = require("./context/assembler");
    state.contextPolicy = defaultContextPolicy();
  }
  if (!Number.isFinite(state.toolCallsSinceCommit)) state.toolCallsSinceCommit = 0;
  ensureStateEpoch(state);
  return state;
}

function buildSkillBodyBlocks(skillInjections = {}) {
  const blocks = Array.isArray(skillInjections.blocks) ? skillInjections.blocks : [];
  return blocks.map((block) => {
    const text = String(block || "");
    if (text.includes("<active_skill>")) return text;
    return text.replace(/^<skill>/, "<active_skill>").replace(/<\/skill>/, "</active_skill>");
  });
}

async function runPlanGraphSteps({
  command = null,
  segment = null,
  workspaceRoot = process.cwd(),
  sessionId = "",
  state = {},
  pushToolLog = () => null,
} = {}) {
  if (!state.executionState || typeof state.executionState !== "object") {
    state.executionState = require("./context/executionSegment").emptyExecutionState();
  }

  const normalized = command
    || (segment ? normalizePlanGraphCommand(segment) : null);
  if (!normalized) {
    return { ok: false, error: "missing plan_graph command" };
  }

  const result = runPlanGraphCommand(normalized, {
    executionState: state.executionState,
    autoAdvance: true,
    parallel: true,
    runTool: ({ node, args, tool, stepId }) => {
      pushToolLog({
        tool,
        phase: "start",
        args,
        error: "",
        origin: {
          kind: "plan_graph",
          graphRevision: Number(state.executionState.planGraph && state.executionState.planGraph.revision) || 0,
          nodeId: stepId || (node && node.id) || "",
        },
      });
      const { runToolCall: dispatchToolCall } = require("./dispatch");
      const { persistToolResultToContext } = require("./context/assembler");
      const toolResult = dispatchToolCall(
        { tool, args },
        { workspaceRoot, cwd: workspaceRoot, sessionId },
      );
      if (!toolResult || toolResult.ok === false) {
        pushToolLog({
          tool,
          phase: "error",
          args,
          error: String((toolResult && toolResult.error) || "tool failed"),
          origin: {
            kind: "plan_graph",
            nodeId: stepId || (node && node.id) || "",
          },
        });
        return toolResult;
      }
      const persisted = persistToolResultToContext({
        workspaceRoot,
        sessionId,
        tool,
        args,
        rawResult: toolResult,
      });
      recordToolCallInSession(state, persisted, workspaceRoot);
      const plan = require("./context/workingSet").defaultContextPlanFromToolEvent(
        tool,
        persisted.artifactId || (persisted.modelPayload && persisted.modelPayload.artifactId),
        args,
      );
      if (plan) state.workingSet = applyWorkingSetPlan(state.workingSet, plan, state);
      if ((tool === "write" || tool === "edit") && args && args.path) {
        const filePath = String(args.path);
        const files = Array.isArray(state.executionState.modifiedFiles)
          ? state.executionState.modifiedFiles.slice()
          : [];
        if (!files.includes(filePath)) files.push(filePath);
        state.executionState.modifiedFiles = files;
      }
      return {
        ...(persisted.modelPayload || toolResult),
        origin: {
          kind: "plan_graph",
          graphRevision: Number(state.executionState.planGraph && state.executionState.planGraph.revision) || 0,
          nodeId: stepId || (node && node.id) || "",
        },
      };
    },
  });

  state.executionState = result.executionState || state.executionState;
  commitAfterSegmentEnd(state, {
    ok: result.status === "accepted",
    segmentId: result.graphId || "",
    error: result.status === "accepted" ? "" : "plan_graph rejected",
    stoppedAt: result.stoppedAt || "",
  }, workspaceRoot);
  return {
    ok: result.status === "accepted",
    graphId: result.graphId || "",
    error: result.status === "accepted"
      ? ""
      : (Array.isArray(result.errors) ? result.errors.map((e) => e.message || e.code).join("; ") : "plan_graph rejected"),
    stoppedAt: result.stoppedAt || "",
    modelPayload: result.modelPayload || result,
  };
}

async function runExecutionSegmentSteps({
  segment = {},
  workspaceRoot = process.cwd(),
  sessionId = "",
  state = {},
  pushToolLog = () => null,
} = {}) {
  return runPlanGraphSteps({
    command: normalizePlanGraphCommand(segment) || normalizePlanGraphCommand({
      type: "execution_segment",
      ...segment,
    }),
    workspaceRoot,
    sessionId,
    state,
    pushToolLog,
  });
}


function readTextOrFile(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  // Only read from disk when the value clearly looks like a path; otherwise a
  // prompt that happens to match an existing file would be silently replaced
  // by that file's contents.
  const looksLikePath = !/[\r\n]/.test(raw)
    && (raw.startsWith("./") || raw.startsWith("/") || raw.startsWith("~")
      || /\.(?:md|txt)$/i.test(raw));
  if (looksLikePath) {
    try {
      if (fs.existsSync(raw)) return String(fs.readFileSync(raw, "utf8") || "");
    } catch {
      // ignore
    }
  }
  return raw;
}

function resolveUcodeProviderModel({
  workspaceRoot = process.cwd(),
  provider = "",
  model = "",
} = {}) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const config = loadConfig(root);
  const fallbackProviderFromAgent = resolvePlannerProvider(String(config.agentProvider || "").trim());
  const explicitProvider = String(
    provider
      || process.env.UFOO_UCODE_PROVIDER
      || config.ucodeProvider
      || ""
  ).trim();
  const resolvedProvider = resolvePlannerProvider(explicitProvider || fallbackProviderFromAgent);
  const configuredModel = sameModelProvider(config.ucodeProvider || config.agentProvider, resolvedProvider)
    ? (config.ucodeModel || config.agentModel)
    : "";
  const resolvedModel = String(
    model
      || process.env.UFOO_UCODE_MODEL
      || configuredModel
      || defaultAgentModelForProvider(resolvedProvider)
  ).trim();
  return {
    provider: resolvedProvider,
    model: resolvedModel || "default",
  };
}

function clampContext(text = "", maxChars = 32000) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function resolvePlannerProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "claude" || text === "claude-cli" || text === "claude-code" || text === "anthropic") return "anthropic";
  if (text === "codex" || text === "codex-cli" || text === "codex-code" || text === "openai") return "openai";
  return text;
}

function extractJsonSummary(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const direct = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  if (direct && typeof direct === "object") {
    if (typeof direct.summary === "string" && direct.summary.trim()) return direct.summary.trim();
    if (typeof direct.reply === "string" && direct.reply.trim()) return direct.reply.trim();
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim();
        if (typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply.trim();
      }
    } catch {
      // keep scanning
    }
  }
  return raw;
}

function isCliTimeoutError(message = "") {
  const text = String(message || "").toLowerCase();
  return text.includes("cli timeout");
}

function isCliCancelledError(message = "") {
  const text = String(message || "").toLowerCase();
  return text.includes("cli cancelled") || text.includes("canceled");
}

function computeExtendedTimeout(baseTimeoutMs) {
  const base = Number.isFinite(baseTimeoutMs) ? Math.max(1000, Math.floor(baseTimeoutMs)) : 43200000;
  return Math.min(43200000, Math.max(base * 2, base + 120000));
}

// Reasoning models routinely blew the old 10min budget across a multi-turn
// tool loop. Total per-task budget defaults to 12h and can be raised per
// call, via --timeout-ms, or via UFOO_UCODE_TASK_TIMEOUT_MS.
const DEFAULT_NL_TASK_TIMEOUT_MS = 43200000;

function resolveNlTaskTimeoutMs(value) {
  if (Number.isFinite(value) && value > 0) return Math.max(1000, Math.floor(value));
  const env = Number(process.env.UFOO_UCODE_TASK_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return Math.max(1000, Math.floor(env));
  return DEFAULT_NL_TASK_TIMEOUT_MS;
}

function enrichNativeError(errorMessage = "") {
  const text = String(errorMessage || "").trim();
  if (!text) return "nl task failed";

  const lower = text.toLowerCase();
  if (
    lower.includes("fetch failed")
    || lower.includes("enotfound")
    || lower.includes("econnrefused")
    || lower.includes("network error")
    || lower.includes("other side closed")
  ) {
    return `${text}. Network connection to provider failed. Check VPN/proxy/network and verify endpoint/key via /settings ucode show.`;
  }
  if (lower.includes("model is not configured")) {
    return `${text}. Configure ucode with /settings ucode set provider=<openai|anthropic> model=<id> key=<apiKey> [url=<baseUrl>]`;
  }
  if (lower.includes("baseurl is not configured")) {
    return `${text}. Configure endpoint with /settings ucode set url=<baseUrl> (and key/model if missing).`;
  }
  if (
    /provider request failed \((401|403)\)/i.test(text)
    || lower.includes("unauthorized")
    || lower.includes("invalid api key")
  ) {
    return `${text}. Check provider/url/key via /settings ucode show.`;
  }
  if (lower.includes("cli timeout")) {
    return `${text}. Task budget exceeded; raise it with --timeout-ms or UFOO_UCODE_TASK_TIMEOUT_MS.`;
  }
  return text;
}

function normalizeToolLogEvent(event = {}) {
  if (!event || typeof event !== "object") return null;
  const tool = String(event.tool || event.name || "").trim().toLowerCase();
  if (!tool) return null;
  if (tool !== "read" && tool !== "write" && tool !== "edit" && tool !== "bash" && tool !== "artifact_read") return null;
  const phase = String(event.phase || "update").trim().toLowerCase();
  const normalizedPhase = phase === "error" ? "error" : (phase === "start" ? "start" : "");
  if (!normalizedPhase) return null;
  const rawArgs = event.args && typeof event.args === "object" ? event.args : {};
  const args = { ...rawArgs };
  const error = String(event.error || "").trim();
  return {
    type: "tool",
    tool,
    phase: normalizedPhase,
    args,
    error,
  };
}

function createToolLogCollector(logs = [], onToolLog = null) {
  const list = Array.isArray(logs) ? logs : [];
  const callback = typeof onToolLog === "function" ? onToolLog : null;

  return (event = {}) => {
    const log = normalizeToolLogEvent(event);
    if (!log) return null;
    list.push(log);
    if (callback) {
      try {
        callback(log);
      } catch {
        // ignore callback failures
      }
    }
    return log;
  };
}

function pushSkillWarning(logs = [], onToolLog = null, warning = "") {
  const text = String(warning || "").trim();
  if (!text) return null;
  const entry = {
    type: "skills",
    phase: "warning",
    message: text,
    error: text,
  };
  if (Array.isArray(logs)) logs.push(entry);
  if (typeof onToolLog === "function") {
    try {
      onToolLog(entry);
    } catch {
      // ignore callback failures
    }
  }
  return entry;
}

function stripSkillBlocksFromText(value = "") {
  return String(value || "")
    .replace(/<(?:active_)?skill>\s*[\s\S]*?<\/(?:active_)?skill>\s*/gi, "")
    .trim();
}

function stripSkillBlocksFromMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    if (typeof message.content === "string") {
      return {
        ...message,
        content: stripSkillBlocksFromText(message.content),
      };
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item;
          if (typeof item.text === "string") {
            return {
              ...item,
              text: stripSkillBlocksFromText(item.text),
            };
          }
          return item;
        }),
      };
    }
    return message;
  });
}

function isProjectAnalysisTask(task = "") {
  const text = String(task || "").trim().toLowerCase();
  if (!text) return false;
  return /(?:analy[sz]e|analysis|review|audit|status|architecture|codebase|repo|project|现状|架构|审查|分析|项目|代码库)/i.test(text);
}

function buildNlFallbackSummary(logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  const started = list.filter((entry) => entry && entry.phase === "start").length;
  const failed = list.filter((entry) => entry && entry.phase === "error").length;

  if (started > 0 || failed > 0) {
    const parts = [`${started} tool step${started === 1 ? "" : "s"} started`];
    if (failed > 0) parts.push(`${failed} failed`);
    return `Done (${parts.join(", ")}).`;
  }
  if (list.length > 0) {
    return `Done (${list.length} tool events).`;
  }
  return "Done (no model text response).";
}

async function runNaturalLanguageTask(task = "", state = {}, options = {}) {
  const taskText = String(task || "").trim();
  if (!taskText) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: "empty task",
      metrics: {},
      streamed: false,
      streamLastChar: "",
    };
  }

  const provider = resolvePlannerProvider(
    state.provider || process.env.UFOO_UCODE_PROVIDER || ""
  );
  const model = String(state.model || process.env.UFOO_UCODE_MODEL || "").trim();
  const timeoutMs = resolveNlTaskTimeoutMs(state.timeoutMs);
  let streamed = false;
  let streamLastChar = "";
  let toolEventsThisAttempt = 0;
  const onDelta = typeof options.onDelta === "function"
    ? options.onDelta
    : null;
  const logs = [];
  const onToolLog = typeof options.onToolLog === "function"
    ? options.onToolLog
    : null;
  const pushToolLog = createToolLogCollector(logs, onToolLog);

  // Structural / explicit upgrade to decomposed runner (not keyword "fix").
  const { shouldUpgradeToDecomposition } = require("./taskRoute");
  const routeDecision = shouldUpgradeToDecomposition(taskText, {
    disableDecomposition: options.disableDecomposition,
    forceDecomposition: options.forceDecomposition,
    forceDirect: options.forceDirect,
    failureCount: options.failureCount,
    modelRequestedUpgrade: options.modelRequestedUpgrade,
    hasPlanGraph: Boolean(
      state.executionState
      && state.executionState.planGraph
      && state.executionState.planGraph.graphId
    ),
  });
  const useDecomposition = Boolean(routeDecision.upgrade);
  state.lastRouteDecision = routeDecision;
  const analysisTask = isProjectAnalysisTask(taskText);
  const workspaceRoot = String(state.workspaceRoot || process.cwd());
  ensureContextSessionState(state);

  let projectSnapshot = state.projectSnapshot || null;
  if (analysisTask) {
    projectSnapshot = createProjectPreflightContextV2({
      workspaceRoot,
      sessionId: String(state.sessionId || ""),
      pushToolLog,
      existingSnapshot: state.projectSnapshot,
    });
    state.projectSnapshot = projectSnapshot;
  } else {
    projectSnapshot = ensureProjectSnapshot(state, workspaceRoot);
  }

  ensureTaskContract(state, taskText);
  if (!shouldFrameAsUserReminder(state.executionState)) {
    state.taskContract = patchTaskContractFromUserMessage(state.taskContract, taskText);
  }

  const taskPrompt = analysisTask
    ? `${taskText}\n\nAnalysis requirements:\n- Inspect repository evidence before concluding.\n- Cite concrete file observations.\n- Keep findings concise and actionable.`
    : taskText;
  const skillInjections = buildSkillInjections({
    prompt: taskPrompt,
    workspaceRoot,
    sessionId: String(state.sessionId || ""),
    persistBodies: true,
    useActiveSkillTag: true,
  });
  for (const warning of skillInjections.warnings || []) {
    pushSkillWarning(logs, onToolLog, warning);
  }
  if (Array.isArray(skillInjections.activeSkills) && skillInjections.activeSkills.length > 0) {
    state.activeSkills = skillInjections.activeSkills;
  }
  const skillBodyBlocks = buildSkillBodyBlocks(skillInjections);
  // Skill body goes into turnDynamic (system layered prompt) to avoid
  // double injection and mixed system/user privilege semantics.
  let effectiveTaskPrompt = taskPrompt;
  if (shouldFrameAsUserReminder(state.executionState)) {
    effectiveTaskPrompt = buildContinuationUserPrompt(effectiveTaskPrompt, state.executionState);
  }

  const assembled = assembleModelContext(state, {
    workspaceRoot,
    model,
    provider,
    turnDynamic: skillBodyBlocks.join("\n\n"),
    latestUserMessage: effectiveTaskPrompt,
  });
  const systemContext = assembled.systemPrompt;
  state.summary = assembled.summary || state.summary;

  const onStream = onDelta
    ? (delta) => {
      const text = String(delta || "");
      if (!text) return;
      streamed = true;
      streamLastChar = text.slice(-1);
      try {
        onDelta(text);
      } catch {
        // ignore stream callback failures
      }
    }
    : null;
  const runNativeAgentImpl = typeof options.runNativeAgentImpl === "function"
    ? options.runNativeAgentImpl
    : runNativeAgentTask;
  const onPhase = typeof options.onPhase === "function" ? options.onPhase : null;
  const onThinkingDelta = typeof options.onThinkingDelta === "function" ? options.onThinkingDelta : null;
  let lastTranscriptBaseline = 0;
  const invokeNative = (sessionIdValue = "", timeoutOverrideMs = timeoutMs) => {
    toolEventsThisAttempt = 0;
    const historyMessages = assembled.messages;
    // Sanitized length matches what nativeRunner clones before appending this
    // turn's user/tool/assistant messages — used as the transcript sync baseline.
    lastTranscriptBaseline = sanitizeModelMessages(historyMessages).length;
    return runNativeAgentImpl({
      workspaceRoot,
      provider,
      model,
      prompt: effectiveTaskPrompt,
      systemPrompt: systemContext,
      systemBlocks: assembled.systemBlocks || null,
      messages: historyMessages,
      sessionId: String(sessionIdValue || state.sessionId || ""),
      timeoutMs: timeoutOverrideMs,
      onStreamDelta: onStream,
      onThinkingDelta,
      onPhase,
      executionState: state.executionState || null,
      onArtifactPersisted: (persisted) => recordToolCallInSession(state, persisted, workspaceRoot),
      onToolEvent: (event) => {
        toolEventsThisAttempt += 1;
        pushToolLog(event);
      },
      signal: options.signal,
    });
  };

  try {
    let cliRes;

    const requestedPlan = normalizePlanGraphCommand(
      options.executionSegment || options.nextSegment || options.planGraph || null,
    );
    if (requestedPlan) {
      const planResult = await runPlanGraphSteps({
        command: requestedPlan,
        workspaceRoot,
        sessionId: String(state.sessionId || ""),
        state,
        pushToolLog,
      });
      if (!planResult.ok) {
        return {
          ok: false,
          summary: "",
          artifacts: [],
          logs: logs.slice(),
          error: planResult.error,
          metrics: {},
          streamed: false,
          streamLastChar: "",
        };
      }
    }

    // Use decomposed runner for bug fix tasks
    if (useDecomposition) {
      const decomposedResult = await runDecomposedTask({
        task: effectiveTaskPrompt,
        onProgress: options.onProgress,
        onToolEvent: pushToolLog,
        signal: options.signal,
        workspaceRoot,
        provider,
        model,
        systemPrompt: systemContext,
        messages: Array.isArray(state.nlMessages) ? state.nlMessages : [],
        sessionId: String(state.sessionId || ""),
        state,
        systemBlocks: assembled.systemBlocks || null,
      });

      if (decomposedResult.ok) {
        cliRes = {
          ok: true,
          output: decomposedResult.summary,
          sessionId: state.sessionId,
          messages: state.nlMessages,
        };
      } else {
        cliRes = {
          ok: false,
          error: decomposedResult.error,
        };
      }
    } else {
      // Original single-step execution
      cliRes = await invokeNative(String(state.sessionId || ""));

      if (!cliRes || cliRes.ok === false) {
        const errMsg = String((cliRes && cliRes.error) || "");
        // Only replay the whole task when this attempt ran no tool calls;
        // retrying after executed write/edit/bash steps would replay side effects.
        if (isCliTimeoutError(errMsg) && toolEventsThisAttempt === 0) {
          const extendedTimeoutMs = computeExtendedTimeout(timeoutMs);
          cliRes = await invokeNative(String(state.sessionId || ""), extendedTimeoutMs);
        }
      }
    }

    if (!cliRes || cliRes.ok === false) {
      const errMsg = String((cliRes && cliRes.error) || "");
      if (isCliCancelledError(errMsg) && state.executionState) {
        clearUserPrompts(state.executionState);
      }
      return {
        ok: false,
        summary: "",
        artifacts: [],
        logs: logs.slice(),
        error: enrichNativeError(errMsg),
        cancelled: isCliCancelledError(errMsg),
        metrics: {},
        streamed: Boolean(streamed || (cliRes && cliRes.streamed)),
        streamLastChar,
      };
    }
    if (cliRes && typeof cliRes.sessionId === "string" && cliRes.sessionId.trim()) {
      state.sessionId = cliRes.sessionId.trim();
    }
    if (cliRes && cliRes.executionState && typeof cliRes.executionState === "object") {
      // Preserve planMode if the runner returned a fresh empty state without it.
      const priorPlanMode = Boolean(state.executionState && state.executionState.planMode);
      const priorSource = state.executionState && state.executionState.planModeSource
        ? String(state.executionState.planModeSource)
        : "";
      state.executionState = cliRes.executionState;
      if (typeof state.executionState.planMode !== "boolean") {
        state.executionState.planMode = priorPlanMode;
      }
      if (!state.executionState.planModeSource && priorSource) {
        state.executionState.planModeSource = priorSource;
      }
    }
    if (cliRes && Array.isArray(cliRes.messages)) {
      // Sync first so ensureTranscript does not migrate the just-assigned
      // nlMessages and then append the same delta again.
      syncMessagesToTranscript(state, cliRes.messages, workspaceRoot, {
        baselineCount: lastTranscriptBaseline,
      });
      state.nlMessages = stripSkillBlocksFromMessages(
        Array.isArray(state.nlMessages) && state.nlMessages.length > 0
          ? state.nlMessages
          : cliRes.messages,
      );
    }
    const normalized = String(cliRes.output || "").trim();
    const sideEffects = parseStructuredSideEffects(normalized);
    if (sideEffects) {
      applyContextSideEffects(state, sideEffects);
      const planCommand = normalizePlanGraphCommand(sideEffects);
      if (planCommand) {
        await runPlanGraphSteps({
          command: planCommand,
          workspaceRoot,
          sessionId: String(state.sessionId || ""),
          state,
          pushToolLog,
        });
      }
    }
    const summary = extractJsonSummary(normalized);
    const resolvedSummary = String(summary || "").trim() || buildNlFallbackSummary(logs);
    const artifactIds = Array.isArray(state.workingSet)
      ? state.workingSet.map((entry) => entry.artifactId).filter(Boolean)
      : [];
    if (cliRes && cliRes.waitingUserInteraction) {
      return {
        ok: true,
        summary: resolvedSummary || "Waiting for your reply",
        artifacts: artifactIds,
        logs: logs.slice(),
        error: "",
        metrics: {},
        streamed: Boolean(streamed || cliRes.streamed),
        streamLastChar,
        waitingUserInteraction: true,
        interactionId: cliRes.interactionId || "",
      };
    }
    return {
      ok: true,
      summary: resolvedSummary,
      artifacts: artifactIds,
      logs: logs.slice(),
      error: "",
      metrics: {},
      streamed: Boolean(streamed || cliRes.streamed),
      streamLastChar,
    };
  } catch (err) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: logs.slice(),
      error: enrichNativeError(err && err.message ? err.message : "nl task failed"),
      cancelled: isCliCancelledError(err && err.message ? err.message : ""),
      metrics: {},
      streamed,
      streamLastChar,
    };
  }
}

function formatNlResult(result, asJson = false) {
  if (asJson) {
    return JSON.stringify(result && typeof result === "object" ? result : {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: "invalid nl result",
      metrics: {},
    });
  }
  if (result && result.cancelled) {
    return "Cancelled.";
  }
  if (!result || result.ok === false) {
    return `Error: ${(result && result.error) || "task failed"}`;
  }
  const summary = String(result.summary || "").trim();
  if (summary) return summary;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter(Boolean) : [];
  if (artifacts.length > 0) return artifacts.join("\n");
  return buildNlFallbackSummary(result && Array.isArray(result.logs) ? result.logs : []);
}

function buildNlContext({
  appendSystemPrompt = "",
  systemPrompt = "",
  workspaceRoot = "",
  model = "",
  provider = "",
} = {}) {
  // Legacy override: if caller passes a raw systemPrompt string/file, honor it
  const override = readTextOrFile(systemPrompt);
  if (override) return clampContext(override);

  // Resolve append from args or env
  const append = readTextOrFile(appendSystemPrompt)
    || readTextOrFile(process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT)
    || readTextOrFile(process.env.UFOO_UCODE_BOOTSTRAP_FILE)
    || readTextOrFile(process.env.UFOO_UCODE_PROMPT_FILE)
    || "";

  return clampContext(resolveWireSystemPrompt({
    workspaceRoot: workspaceRoot || process.cwd(),
    model,
    provider,
    appendSystemPrompt: append,
  }));
}

/**
 * Single wire entry for system prompt assembly (layered Context Manager).
 */
function resolveWireSystemPrompt({
  workspaceRoot = process.cwd(),
  model = "",
  provider = "",
  appendSystemPrompt = "",
  overrideSystemPrompt = "",
  epochDynamic = "",
  turnDynamic = "",
  sessionStableExtras = "",
} = {}) {
  if (overrideSystemPrompt) return String(overrideSystemPrompt);

  return buildLayeredSystemPrompt({
    workspaceRoot,
    model,
    provider,
    appendSystemPrompt,
    epochDynamic,
    turnDynamic,
    sessionStableExtras,
  }).flatText;
}

function buildSessionSnapshotFromState(state = {}) {
  const source = state && typeof state === "object" ? state : {};
  return {
    sessionId: resolveSessionId(source.sessionId),
    workspaceRoot: String(source.workspaceRoot || process.cwd()).trim() || process.cwd(),
    provider: String(source.provider || "").trim(),
    model: String(source.model || "").trim(),
    context: String(source.context || ""),
    nlMessages: Array.isArray(source.nlMessages) ? source.nlMessages : [],
    createdAt: String(source.sessionCreatedAt || "").trim(),
    summary: String(source.summary || "").trim(),
    projectSnapshot: source.projectSnapshot && typeof source.projectSnapshot === "object"
      ? source.projectSnapshot
      : null,
    taskContract: source.taskContract && typeof source.taskContract === "object"
      ? source.taskContract
      : null,
    stateEpoch: source.stateEpoch && typeof source.stateEpoch === "object"
      ? source.stateEpoch
      : null,
    workingSet: Array.isArray(source.workingSet) ? source.workingSet : [],
    executionState: source.executionState && typeof source.executionState === "object"
      ? source.executionState
      : null,
    contextPolicy: source.contextPolicy && typeof source.contextPolicy === "object"
      ? source.contextPolicy
      : null,
    toolCallsSinceCommit: Number.isFinite(source.toolCallsSinceCommit)
      ? Math.max(0, Math.floor(source.toolCallsSinceCommit))
      : 0,
    activeSkills: Array.isArray(source.activeSkills) ? source.activeSkills : [],
  };
}

function persistSessionState(state = {}) {
  const snapshot = buildSessionSnapshotFromState(state);
  if (!state.sessionId && snapshot.sessionId) {
    state.sessionId = snapshot.sessionId;
  }
  // Skip writing sessions that carry no messages yet; otherwise every launch
  // (even an immediate quit) leaves an empty session file behind and the
  // sessions directory grows without bound.
  if (!Array.isArray(snapshot.nlMessages) || snapshot.nlMessages.length === 0) {
    return {
      ok: true,
      skipped: true,
      error: "",
      sessionId: snapshot.sessionId,
      filePath: "",
    };
  }
  const saved = saveSessionSnapshot(snapshot.workspaceRoot, snapshot);
  if (saved && saved.ok) {
    state.sessionId = saved.sessionId;
    const savedSnapshot = saved.snapshot && typeof saved.snapshot === "object"
      ? saved.snapshot
      : {};
    const createdAt = String(savedSnapshot.createdAt || "").trim();
    if (createdAt) {
      state.sessionCreatedAt = createdAt;
    }
  }
  return saved;
}

function resumeSessionState(state = {}, sessionId = "", workspaceRoot = process.cwd()) {
  const targetId = normalizeSessionId(sessionId);
  if (!targetId) {
    return {
      ok: false,
      error: "invalid session id",
      sessionId: "",
      restoredMessages: 0,
    };
  }

  const loaded = loadSessionSnapshot(workspaceRoot, targetId);
  if (!loaded || loaded.ok === false || !loaded.snapshot) {
    return {
      ok: false,
      error: String((loaded && loaded.error) || `session not found: ${targetId}`),
      sessionId: targetId,
      restoredMessages: 0,
    };
  }

  const snapshot = loaded.snapshot;
  state.sessionId = String(snapshot.sessionId || targetId);
  state.workspaceRoot = String(snapshot.workspaceRoot || workspaceRoot || process.cwd());
  state.provider = String(snapshot.provider || "");
  state.model = String(snapshot.model || "");
  state.context = String(snapshot.context || "");
  state.nlMessages = Array.isArray(snapshot.nlMessages) ? snapshot.nlMessages : [];
  state.sessionCreatedAt = String(snapshot.createdAt || "").trim();
  state.summary = String(snapshot.summary || "").trim();
  state.projectSnapshot = snapshot.projectSnapshot || null;
  state.taskContract = snapshot.taskContract || null;
  state.stateEpoch = snapshot.stateEpoch || null;
  state.workingSet = Array.isArray(snapshot.workingSet) ? snapshot.workingSet : [];
  state.executionState = snapshot.executionState || null;
  state.contextPolicy = snapshot.contextPolicy || null;
  state.toolCallsSinceCommit = Number.isFinite(snapshot.toolCallsSinceCommit)
    ? snapshot.toolCallsSinceCommit
    : 0;
  state.activeSkills = Array.isArray(snapshot.activeSkills) ? snapshot.activeSkills : [];
  ensureContextSessionState(state);
  const { ensureTranscript } = require("./context/assembler");
  ensureTranscript(state, state.workspaceRoot);
  if (Array.isArray(state.transcriptEvents) && state.transcriptEvents.length > 0) {
    const { transcriptEventsToMessages } = require("./context/transcript");
    state.nlMessages = transcriptEventsToMessages(state.transcriptEvents, { preferArtifact: true });
  }

  return {
    ok: true,
    error: "",
    sessionId: state.sessionId,
    restoredMessages: Array.isArray(state.nlMessages) ? state.nlMessages.length : 0,
  };
}

/**
 * Continue after TUI resolves approval/choice/chat.
 * ask_user: answer is written as the deferred tool_result (contiguous, no question echo).
 * checkpoint: short answer-only user message referencing interaction/node.
 */
async function resumeAfterUserInteraction(answerText = "", state = {}, options = {}) {
  ensureContextSessionState(state);
  const { resolveUserInteraction } = require("./context/userInteraction");
  const { appendAnswerToolResult } = require("./nativeRunner");
  const resolved = resolveUserInteraction(state.executionState, answerText);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error || "failed to resolve user interaction",
      code: resolved.code || "",
      waitingUserInteraction: true,
    };
  }

  const logs = [];
  const pushToolLog = (event) => {
    try {
      logs.push(normalizeToolLogEvent(event));
    } catch { /* ignore */ }
  };

  let messages = Array.isArray(state.nlMessages) ? state.nlMessages.slice() : [];
  if (resolved.continueMode === "tool_result" && resolved.resume && resolved.resume.call) {
    const appended = appendAnswerToolResult(messages, resolved.resume, resolved.answer);
    if (!appended.ok) {
      return { ok: false, error: appended.error || "failed to append answer tool_result" };
    }
  } else {
    // Checkpoint / non-tool path: answer-only contiguous user message (no question).
    messages.push({
      role: "user",
      content: JSON.stringify(resolved.answer),
    });
  }
  state.nlMessages = messages;

  const workspaceRoot = state.workspaceRoot || process.cwd();
  const assembled = assembleModelContext(state, {
    workspaceRoot,
    provider: state.provider,
    model: state.model,
  });
  const systemContext = assembled.systemPrompt || "";

  let streamLastChar = "";
  const onDelta = typeof options.onDelta === "function" ? options.onDelta : null;
  const trackingOnDelta = onDelta
    ? (delta) => {
      const text = String(delta || "");
      if (text) streamLastChar = text.slice(-1);
      return onDelta(delta);
    }
    : null;

  const cliRes = await runNativeAgentTask({
    workspaceRoot,
    provider: state.provider,
    model: state.model,
    prompt: "",
    systemPrompt: systemContext,
    systemBlocks: assembled.systemBlocks || null,
    messages,
    sessionId: String(state.sessionId || ""),
    onToolEvent: pushToolLog,
    onStreamDelta: trackingOnDelta,
    onThinkingDelta: typeof options.onThinkingDelta === "function" ? options.onThinkingDelta : null,
    onPhase: typeof options.onPhase === "function" ? options.onPhase : null,
    executionState: state.executionState,
    signal: options.signal,
    resume: true,
  });

  if (cliRes && cliRes.executionState) {
    state.executionState = cliRes.executionState;
  }
  if (cliRes && Array.isArray(cliRes.messages)) {
    state.nlMessages = stripSkillBlocksFromMessages(cliRes.messages);
  }

  if (!cliRes || cliRes.ok === false) {
    return {
      ok: false,
      error: (cliRes && cliRes.error) || "resume failed",
      logs,
      waitingUserInteraction: false,
      streamed: false,
      streamLastChar: "",
    };
  }

  if (cliRes.waitingUserInteraction) {
    return {
      ok: true,
      summary: "Waiting for your reply",
      logs,
      waitingUserInteraction: true,
      interactionId: cliRes.interactionId || "",
      streamed: Boolean(cliRes.streamed),
      streamLastChar,
    };
  }

  return {
    ok: true,
    summary: String(cliRes.output || "").trim() || "continued",
    logs,
    waitingUserInteraction: false,
    streamed: Boolean(cliRes.streamed),
    streamLastChar,
  };
}

module.exports = {
  runUcodeCoreAgent,
  runSingleCommand,
  runNaturalLanguageTask,
  resumeAfterUserInteraction,
  submitUserInteractionAnswer: (...args) => require("./protocol/suspension").submitUserInteractionAnswer(...args),
  formatNlResult,
  normalizeToolLogEvent,
  isProjectAnalysisTask,
  buildNlFallbackSummary,
  buildNlContext,
  resolveWireSystemPrompt,
  stripSkillBlocksFromMessages,
  stripSkillBlocksFromText,
  resolvePlannerProvider,
  extractJsonSummary,
  enrichNativeError,
  resolveNlTaskTimeoutMs,
  DEFAULT_NL_TASK_TIMEOUT_MS,
  resolveUcodeProviderModel,
  buildSessionSnapshotFromState,
  persistSessionState,
  resumeSessionState,
  parseBusCheckOutput,
  extractBusMessageTask,
  runUbusCommand,
  runShellCapture,
  readTextOrFile,
  stripAnsi,
  busCheckOutputIndicatesPending,
  resolvePendingQueueFile,
  extractAgentNickname,
  resolveUfooProjectRoot,
  countPendingQueueLines,
  getPendingBusCount,
  drainJsonlFile,
  extractTaskFromBusEvent,
  shouldAutoConsumeBus,
  parseAgentArgs,
};

if (require.main === module) {
  const parsed = parseAgentArgs(process.argv.slice(2));
  runUcodeCoreAgent({
    workspaceRoot: parsed.workspaceRoot || process.cwd(),
    provider: parsed.provider,
    model: parsed.model,
    appendSystemPrompt: parsed.appendSystemPrompt,
    systemPrompt: parsed.systemPrompt,
    sessionId: parsed.sessionId,
    timeoutMs: parsed.timeoutMs,
    jsonOutput: parsed.jsonOutput,
    forceTui: parsed.forceTui,
    disableTui: parsed.disableTui,
  }).then((res) => {
    process.exit(typeof res.code === "number" ? res.code : 0);
  }).catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : "ucode agent failed"}\n`);
    process.exit(1);
  });
}
