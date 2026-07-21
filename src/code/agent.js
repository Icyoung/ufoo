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
const { buildPromptContext } = require("../agents/prompts/native");
const { buildSkillInjections } = require("./skills");
const { isContextV2Enabled } = require("./context/featureFlag");
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
  parseExecutionSegment,
  executeExecutionSegment,
} = require("./context/executionSegment");
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

async function runExecutionSegmentSteps({
  segment = {},
  workspaceRoot = process.cwd(),
  sessionId = "",
  state = {},
  pushToolLog = () => null,
} = {}) {
  const exec = executeExecutionSegment({
    segment,
    executionState: state.executionState,
    onStepStart: ({ tool, args }) => {
      pushToolLog({ tool, phase: "start", args, error: "" });
    },
    onStepComplete: ({ tool, args, result }) => {
      pushToolLog({
        tool,
        phase: result && result.ok === false ? "error" : "",
        args,
        error: result && result.ok === false ? String(result.error || "") : "",
      });
      if (isContextV2Enabled() && result && result.ok !== false) {
        const plan = require("./context/workingSet").defaultContextPlanFromToolEvent(
          tool,
          result.artifactId,
          args,
        );
        if (plan) state.workingSet = applyWorkingSetPlan(state.workingSet, plan, state);
      }
      if ((tool === "write" || tool === "edit") && args && args.path) {
        const filePath = String(args.path);
        if (!state.executionState || typeof state.executionState !== "object") {
          state.executionState = require("./context/executionSegment").emptyExecutionState();
        }
        const files = Array.isArray(state.executionState.modifiedFiles)
          ? state.executionState.modifiedFiles.slice()
          : [];
        if (!files.includes(filePath)) files.push(filePath);
        state.executionState.modifiedFiles = files;
      }
    },
    runStep: ({ tool, args }) => {
      const { runToolCall: dispatchToolCall } = require("./dispatch");
      const { persistToolResultToContext } = require("./context/assembler");
      const result = dispatchToolCall(
        { tool, args },
        { workspaceRoot, cwd: workspaceRoot, sessionId },
      );
      if (!result || result.ok === false || !isContextV2Enabled()) {
        return result;
      }
      const persisted = persistToolResultToContext({
        workspaceRoot,
        sessionId,
        tool,
        args,
        rawResult: result,
      });
      recordToolCallInSession(state, persisted, workspaceRoot);
      return persisted.modelPayload || result;
    },
  });
  state.executionState = exec.executionState;
  if (isContextV2Enabled()) {
    commitAfterSegmentEnd(state, exec, workspaceRoot);
  }
  return {
    ok: exec.ok,
    segmentId: exec.segmentId,
    error: exec.error,
    stoppedAt: exec.stoppedAt,
  };
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

function createProjectPreflightContext({
  workspaceRoot = process.cwd(),
  pushToolLog = () => null,
} = {}) {
  const root = String(workspaceRoot || process.cwd());
  const readCandidates = [
    "AGENTS.md",
    "README.md",
    "README.zh-CN.md",
    "package.json",
  ];
  const blocks = [];

  for (const relPath of readCandidates) {
    pushToolLog({
      tool: "read",
      phase: "start",
      args: { path: relPath },
      error: "",
    });
    const readRes = runToolCall(
      {
        tool: "read",
        args: { path: relPath, maxBytes: 12000 },
      },
      {
        workspaceRoot: root,
        cwd: root,
      }
    );
    pushToolLog({
      tool: "read",
      phase: readRes && readRes.ok === false ? "error" : "",
      args: { path: relPath },
      error: readRes && readRes.ok === false ? String(readRes.error || "") : "",
    });
    if (!readRes || readRes.ok === false) continue;
    const content = String(readRes.content || "").trim();
    if (!content) continue;
    const clipped = content.length > 2400
      ? `${content.slice(0, 2400)}\n...[truncated]`
      : content;
    blocks.push(`File: ${relPath}\n${clipped}`);
    if (blocks.length >= 2) break;
  }

  if (blocks.length === 0) {
    const command = "ls -la";
    pushToolLog({
      tool: "bash",
      phase: "start",
      args: { command },
      error: "",
    });
    const bashRes = runToolCall(
      {
        tool: "bash",
        args: { command, timeoutMs: 4000 },
      },
      {
        workspaceRoot: root,
        cwd: root,
      }
    );
    pushToolLog({
      tool: "bash",
      phase: bashRes && bashRes.ok === false ? "error" : "",
      args: { command },
      error: bashRes && bashRes.ok === false ? String(bashRes.error || "") : "",
    });
    if (bashRes && bashRes.ok !== false) {
      const stdout = String(bashRes.stdout || "").trim();
      const clipped = stdout.length > 1200
        ? `${stdout.slice(0, 1200)}\n...[truncated]`
        : stdout;
      if (clipped) {
        blocks.push(`Command: ${command}\n${clipped}`);
      }
    }
  }

  if (blocks.length === 0) return "";
  return [
    "Preflight snapshot (captured by ucode):",
    ...blocks.map((block) => `---\n${block}`),
  ].join("\n");
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

  // Detect bug fix tasks and use decomposed runner
  const isBugFixTask = /\b(?:fix(?:es|ed|ing)?|bugs?|issues?|problems?|errors?|broken)\b|doesn't work|not work/i.test(taskText);
  const useDecomposition = isBugFixTask && !options.disableDecomposition;
  const analysisTask = isProjectAnalysisTask(taskText);
  const workspaceRoot = String(state.workspaceRoot || process.cwd());
  const contextV2 = isContextV2Enabled();
  if (contextV2) ensureContextSessionState(state);

  let preflightContext = "";
  let projectSnapshot = state.projectSnapshot || null;
  if (analysisTask) {
    if (contextV2) {
      projectSnapshot = createProjectPreflightContextV2({
        workspaceRoot,
        sessionId: String(state.sessionId || ""),
        pushToolLog,
        existingSnapshot: state.projectSnapshot,
      });
      state.projectSnapshot = projectSnapshot;
    } else {
      preflightContext = createProjectPreflightContext({
        workspaceRoot,
        pushToolLog,
      });
    }
  } else if (contextV2) {
    projectSnapshot = ensureProjectSnapshot(state, workspaceRoot);
  }

  if (contextV2) {
    ensureTaskContract(state, taskText);
    state.taskContract = patchTaskContractFromUserMessage(state.taskContract, taskText);
  }

  const taskPrompt = analysisTask
    ? `${taskText}\n\nAnalysis requirements:\n- Inspect repository evidence before concluding.\n- Cite concrete file observations.\n- Keep findings concise and actionable.`
    : taskText;
  const skillInjections = buildSkillInjections({
    prompt: taskPrompt,
    workspaceRoot,
    sessionId: String(state.sessionId || ""),
    persistBodies: contextV2,
    useActiveSkillTag: contextV2,
  });
  for (const warning of skillInjections.warnings || []) {
    pushSkillWarning(logs, onToolLog, warning);
  }
  if (contextV2 && Array.isArray(skillInjections.activeSkills) && skillInjections.activeSkills.length > 0) {
    state.activeSkills = skillInjections.activeSkills;
  }
  const skillBodyBlocks = contextV2
    ? buildSkillBodyBlocks(skillInjections)
    : (skillInjections.blocks || []);
  // v1: skill body rides in the user prompt.
  // v2: skill body goes only into turnDynamic (system layered prompt) to avoid
  // double injection and mixed system/user privilege semantics.
  const effectiveTaskPrompt = contextV2
    ? taskPrompt
    : (skillBodyBlocks.length > 0
      ? `${skillBodyBlocks.join("\n\n")}\n\n${taskPrompt}`
      : taskPrompt);

  let assembled = null;
  let systemContext = "";
  if (contextV2) {
    assembled = assembleModelContext(state, {
      workspaceRoot,
      model,
      provider,
      turnDynamic: skillBodyBlocks.join("\n\n"),
      latestUserMessage: effectiveTaskPrompt,
    });
    systemContext = assembled.systemPrompt;
    state.summary = assembled.summary || state.summary;
  } else {
    systemContext = [String(state.context || "").trim(), preflightContext]
      .filter(Boolean)
      .join("\n\n");
  }

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
    const historyMessages = contextV2 && assembled
      ? assembled.messages
      : (Array.isArray(state.nlMessages) ? state.nlMessages : []);
    // Sanitized length matches what nativeRunner clones before appending this
    // turn's user/tool/assistant messages — used as the transcript sync baseline.
    lastTranscriptBaseline = sanitizeModelMessages(historyMessages).length;
    return runNativeAgentImpl({
      workspaceRoot,
      provider,
      model,
      prompt: effectiveTaskPrompt,
      systemPrompt: systemContext,
      systemBlocks: contextV2 && assembled ? assembled.systemBlocks : null,
      messages: historyMessages,
      sessionId: String(sessionIdValue || state.sessionId || ""),
      timeoutMs: timeoutOverrideMs,
      onStreamDelta: onStream,
      onThinkingDelta,
      onPhase,
      contextV2,
      onArtifactPersisted: contextV2
        ? (persisted) => recordToolCallInSession(state, persisted, workspaceRoot)
        : null,
      onToolEvent: (event) => {
        toolEventsThisAttempt += 1;
        pushToolLog(event);
      },
      signal: options.signal,
    });
  };

  try {
    let cliRes;

    const requestedSegment = parseExecutionSegment(options.executionSegment || options.nextSegment || null);
    if (contextV2 && requestedSegment && requestedSegment.steps && requestedSegment.steps.length > 0) {
      const segmentResult = await runExecutionSegmentSteps({
        segment: requestedSegment,
        workspaceRoot,
        sessionId: String(state.sessionId || ""),
        state,
        pushToolLog,
      });
      if (!segmentResult.ok) {
        return {
          ok: false,
          summary: "",
          artifacts: [],
          logs: logs.slice(),
          error: segmentResult.error,
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
        state: contextV2 ? state : null,
        contextV2,
        systemBlocks: contextV2 && assembled ? assembled.systemBlocks : null,
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
    if (cliRes && Array.isArray(cliRes.messages)) {
      state.nlMessages = stripSkillBlocksFromMessages(cliRes.messages);
      if (contextV2) {
        syncMessagesToTranscript(state, cliRes.messages, workspaceRoot, {
          baselineCount: lastTranscriptBaseline,
        });
      }
    }
    const normalized = String(cliRes.output || "").trim();
    const sideEffects = contextV2 ? parseStructuredSideEffects(normalized) : null;
    if (contextV2 && sideEffects) {
      applyContextSideEffects(state, sideEffects);
      const nextSegment = parseExecutionSegment(sideEffects);
      if (nextSegment && nextSegment.steps && nextSegment.steps.length > 0) {
        await runExecutionSegmentSteps({
          segment: nextSegment,
          workspaceRoot,
          sessionId: String(state.sessionId || ""),
          state,
          pushToolLog,
        });
      }
    }
    const summary = extractJsonSummary(normalized);
    const resolvedSummary = String(summary || "").trim() || buildNlFallbackSummary(logs);
    const artifactIds = contextV2 && Array.isArray(state.workingSet)
      ? state.workingSet.map((entry) => entry.artifactId).filter(Boolean)
      : [];
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
 * Single wire entry for system prompt assembly.
 * v2 (default): layered Context Manager prompt.
 * v1 (explicit off): legacy flat buildPromptContext.
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

  if (isContextV2Enabled()) {
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

  // Legacy v1 path — kept for UFOO_UCODE_CONTEXT_V2=0 compatibility only.
  return buildPromptContext({
    workspaceRoot,
    model,
    provider,
    appendSystemPrompt,
  });
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
  if (isContextV2Enabled()) {
    ensureContextSessionState(state);
    const { ensureTranscript } = require("./context/assembler");
    ensureTranscript(state, state.workspaceRoot);
    if (Array.isArray(state.transcriptEvents) && state.transcriptEvents.length > 0) {
      const { transcriptEventsToMessages } = require("./context/transcript");
      state.nlMessages = transcriptEventsToMessages(state.transcriptEvents, { preferArtifact: true });
    }
  }

  return {
    ok: true,
    error: "",
    sessionId: state.sessionId,
    restoredMessages: Array.isArray(state.nlMessages) ? state.nlMessages.length : 0,
  };
}

module.exports = {
  runUcodeCoreAgent,
  runSingleCommand,
  runNaturalLanguageTask,
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
