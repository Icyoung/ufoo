const { randomUUID } = require("crypto");
const { loadConfig, defaultAgentModelForProvider, sameModelProvider } = require("../config");
const {
  readKimiAccessToken,
  resolveKimiUpstreamCredentials,
} = require("../agents/providers/credentials/kimi");
const { runToolCall } = require("./dispatch");
const { runTaskRunTool } = require("./tools/taskRun");
const { appendUsageRecord } = require("./usageStore");
const {
  persistToolResultToContext,
  sanitizeModelMessages,
} = require("./context/assembler");
const { systemBlocksToAnthropicPayload } = require("./context/promptLayers");
const { parseStructuredSideEffects } = require("./context/stateCommit");
const {
  emptyExecutionState,
} = require("./context/executionSegment");
const {
  normalizePlanGraphCommand,
  runPlanGraphCommand,
  activePlanRequiresExpansion,
} = require("./context/planGraphService");
const { planModeBlocksDirectTool } = require("./context/planMode");
const {
  drainUserPrompts,
  clearUserPrompts,
  formatUserReminderMessage,
  ensurePendingUserPrompts,
  shouldAutoContinuePlan,
  buildPlanAutoContinueReminder,
} = require("./context/userNudge");
const {
  drainAgentMailboxForTurn,
  shouldAutoContinueForTaskWake,
  buildTaskRunWakeReminder,
  listTaskRunsAwaitingModel,
} = require("./runtime/agentWakeup");
const {
  runAskUserTool,
  syncInteractionFromPlanGraph,
  hasPendingUserInteraction,
  getPendingUserInteraction,
} = require("./context/userInteraction");
const { checkWriteAllowed } = require("./runtime/workspaceLease");
const {
  createToolCallLedger,
  declareCalls,
  markExecuting,
  deferCall,
  resolveCall,
  snapshotLedger,
  runProviderTurnGate,
  withFaultPoint,
  checkFaultPoint,
  materializeResolvedToolResults,
  materializeAnswerToolResult,
} = require("./protocol");
const { stableStringify } = require("./context/stableJson");
const { getReadToolDescription } = require("../agents/prompts/native/toolDescriptions/read");
const { getReadImageToolDescription } = require("../agents/prompts/native/toolDescriptions/readImage");
const { getWriteToolDescription } = require("../agents/prompts/native/toolDescriptions/write");
const { getEditToolDescription } = require("../agents/prompts/native/toolDescriptions/edit");
const { getBashToolDescription } = require("../agents/prompts/native/toolDescriptions/bash");

const CORE_TOOL_NAMES = new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "bash",
  "artifact_read",
  "plan_graph",
  "task_run",
  "ask_user",
]);
const EXECUTABLE_GRAPH_TOOLS = new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "bash",
  "artifact_read",
]);
const CONTROL_PLANE_TOOLS = new Set(["plan_graph", "task_run"]);
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_KIMI_MODEL = "k3";
// Claude Code SDK defaults to no turn limit; built-in agents cap at 30 (DreamTask)
// to 200 (fork). We count individual tool calls (not turns), so 100 leaves headroom
// for non-trivial tasks while still catching runaway loops. Override via env.
const DEFAULT_MAX_NATIVE_TOOL_CALLS = 100;
const DEFAULT_MAX_NATIVE_TOOL_ERRORS = 20;
const DEFAULT_NATIVE_TIMEOUT_MS = 43200000; // 12 hours
/** Max text-only auto-continues while a plan is waiting on a task (per user submit). */
const DEFAULT_MAX_PLAN_AUTO_CONTINUES = 24;
// Anthropic Messages rejects max_tokens above the model's real cap (64K on
// current models), so the transports use different defaults. Override either
// via UFOO_UCODE_MAX_TOKENS (positive integer).
const DEFAULT_OPENAI_MAX_TOKENS = 131072;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 64000;
// Extended thinking defaults live in thinkingLevels.js (medium = 10k).
// UFOO_UCODE_THINKING=off|low|medium|high|max selects a preset; numeric
// UFOO_UCODE_THINKING_BUDGET_TOKENS still overrides. 0 disables thinking.
// Prompt caching is GA on the current Messages API: cache_control blocks need
// no anthropic-beta header. Kept as a constant so the marker shape stays in
// one place (system block + last history message, 2 of the 4 allowed
// breakpoints).
const ANTHROPIC_CACHE_CONTROL = Object.freeze({ type: "ephemeral" });

function nowMs() {
  return Date.now();
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NATIVE_TIMEOUT_MS;
  return Math.max(1000, Math.floor(parsed));
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function resolveNativeToolBudget(env = process.env) {
  return {
    maxToolCalls: normalizePositiveInt(env.UFOO_UCODE_MAX_TOOL_CALLS, DEFAULT_MAX_NATIVE_TOOL_CALLS),
    maxToolErrors: normalizePositiveInt(env.UFOO_UCODE_MAX_TOOL_ERRORS, DEFAULT_MAX_NATIVE_TOOL_ERRORS),
  };
}

function resolveMaxTokens(fallback) {
  return normalizePositiveInt(process.env.UFOO_UCODE_MAX_TOKENS, fallback);
}

function resolveThinkingBudgetTokens(options = {}) {
  const { resolveThinkingFromEnvAndConfig } = require("./thinkingLevels");
  const { loadGlobalUcodeConfig } = require("../config");
  let configLevel = String(options.configLevel || "").trim();
  if (!configLevel) {
    try {
      configLevel = String((loadGlobalUcodeConfig() || {}).ucodeThinking || "").trim();
    } catch {
      configLevel = "";
    }
  }
  const resolved = resolveThinkingFromEnvAndConfig({
    env: options.env || process.env,
    configLevel,
  });
  return resolved.budgetTokens;
}

function resolveReasoningEffort(options = {}) {
  const { resolveThinkingFromEnvAndConfig } = require("./thinkingLevels");
  const { loadGlobalUcodeConfig } = require("../config");
  let configLevel = String(options.configLevel || "").trim();
  if (!configLevel) {
    try {
      configLevel = String((loadGlobalUcodeConfig() || {}).ucodeThinking || "").trim();
    } catch {
      configLevel = "";
    }
  }
  const resolved = resolveThinkingFromEnvAndConfig({
    env: options.env || process.env,
    configLevel,
  });
  return resolved.reasoningEffort || "";
}

function toUsageInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function createUsageTotals() {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
  };
}

function addUsageTotals(totals, usage = null) {
  if (!usage || typeof usage !== "object") return totals;
  totals.input += toUsageInt(usage.input);
  totals.output += toUsageInt(usage.output);
  totals.cacheRead += toUsageInt(usage.cacheRead);
  totals.cacheCreation += toUsageInt(usage.cacheCreation);
  return totals;
}

// OpenAI-compatible streams end with one usage chunk carrying whole-turn
// totals (prompt_tokens_details.cached_tokens counts the cache hits).
function readOpenAiUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
    ? raw.prompt_tokens_details
    : {};
  return {
    input: toUsageInt(raw.prompt_tokens),
    output: toUsageInt(raw.completion_tokens),
    cacheRead: toUsageInt(details.cached_tokens),
    cacheCreation: 0,
  };
}

// Anthropic reports input/cache tokens once on message_start; output tokens
// arrive per message_delta. The non-streaming body carries the full totals.
function readAnthropicUsage(raw, { includeOutput = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  return {
    input: toUsageInt(raw.input_tokens),
    output: includeOutput ? toUsageInt(raw.output_tokens) : 0,
    cacheRead: toUsageInt(raw.cache_read_input_tokens),
    cacheCreation: toUsageInt(raw.cache_creation_input_tokens),
  };
}

function enforceNativeToolBudget({
  toolCallsExecuted = 0,
  toolErrors = 0,
  maxToolCalls = DEFAULT_MAX_NATIVE_TOOL_CALLS,
  maxToolErrors = DEFAULT_MAX_NATIVE_TOOL_ERRORS,
  lastTool = "",
  lastError = "",
} = {}) {
  if (toolCallsExecuted >= maxToolCalls) {
    throw new Error(`tool call budget exceeded (${maxToolCalls})`);
  }
  if (toolErrors >= maxToolErrors) {
    const detail = [lastTool, lastError].filter(Boolean).join(": ");
    throw new Error(`tool error budget exceeded (${maxToolErrors})${detail ? `: ${detail}` : ""}`);
  }
}

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

function emitToolEvent(callback, event = {}) {
  if (typeof callback !== "function") return;
  try {
    const payload = event && typeof event === "object" ? { ...event } : {};
    if (payload.origin == null) delete payload.origin;
    callback(payload);
  } catch {
    // ignore callback failures
  }
}

function clipText(value = "", maxChars = 6000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "codex" || text === "codex-cli" || text === "codex-code") return "openai";
  if (text === "claude" || text === "claude-cli" || text === "claude-code") return "anthropic";
  if (text === "kimi" || text === "kimi-code" || text === "moonshot") return "kimi";
  if (text === "openai" || text === "anthropic") return text;
  return text;
}

function resolveTransport({ provider = "", baseUrl = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const url = String(baseUrl || "").trim().toLowerCase();

  if (normalizedProvider === "anthropic") return "anthropic-messages";
  if (normalizedProvider === "kimi") return "openai-chat";
  if (url.includes("anthropic.com")) return "anthropic-messages";
  if (/\/messages(?:$|[/?#])/.test(url) && !/\/chat\/completions(?:$|[/?#])/.test(url)) {
    return "anthropic-messages";
  }

  return "openai-chat";
}

function resolveRuntimeConfig({ workspaceRoot = process.cwd(), provider = "", model = "" } = {}) {
  const config = loadConfig(workspaceRoot);
  const configuredProvider = normalizeProvider(config.ucodeProvider || config.agentProvider || "");
  const selectedProvider = normalizeProvider(
    provider
      || process.env.UFOO_UCODE_PROVIDER
      || configuredProvider
      || "openai"
  ) || "openai";
  const configuredModel = sameModelProvider(config.ucodeProvider || config.agentProvider, selectedProvider)
    ? (config.ucodeModel || config.agentModel)
    : "";

  const selectedModel = String(
    model
      || process.env.UFOO_UCODE_MODEL
      || configuredModel
      || (selectedProvider === "kimi" ? DEFAULT_KIMI_MODEL : defaultAgentModelForProvider(selectedProvider))
  ).trim();

  const defaultBaseUrl = selectedProvider === "anthropic"
    ? String(process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL)
    : selectedProvider === "kimi"
      ? DEFAULT_KIMI_BASE_URL
      : String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL);

  const baseUrl = String(
    process.env.UFOO_UCODE_BASE_URL
      || config.ucodeBaseUrl
      || defaultBaseUrl
  ).trim();

  const explicitApiKey = String(
    process.env.UFOO_UCODE_API_KEY
      || config.ucodeApiKey
      || ""
  ).trim();
  let apiKey = explicitApiKey;
  let apiKeySource = explicitApiKey ? "explicit" : "";
  let kimiCredentialState = "";
  if (!apiKey && selectedProvider === "kimi") {
    const credential = readKimiAccessToken({ env: process.env });
    if (credential && credential.accessToken) {
      apiKey = String(credential.accessToken).trim();
      apiKeySource = "kimi-credential";
      kimiCredentialState = String(credential.state || "");
    }
  }
  if (!apiKey) {
    apiKey = String(
      (selectedProvider === "openai" ? process.env.OPENAI_API_KEY : "")
        || (selectedProvider === "anthropic" ? process.env.ANTHROPIC_API_KEY : "")
        || ""
    ).trim();
    if (apiKey) apiKeySource = "env";
  }

  return {
    provider: selectedProvider,
    model: selectedModel,
    baseUrl,
    apiKey,
    apiKeySource,
    kimiCredentialState,
    transport: resolveTransport({ provider: selectedProvider, baseUrl }),
  };
}

function resolveCompletionUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/chat/completions`;
  return `${normalized}/chat/completions`;
}

function resolveAnthropicMessagesUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim() || DEFAULT_ANTHROPIC_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (/\/messages$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/messages`;
  return `${normalized}/messages`;
}

function buildCoreToolSpecs() {
  return [
    {
      type: "function",
      function: {
        name: "read",
        description: getReadToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            maxBytes: { type: "integer" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_image",
        description: getReadImageToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Workspace-relative path to a png, jpeg, gif, or webp image.",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: getWriteToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: {
              type: "string",
              enum: ["overwrite", "append"],
              description: 'Write mode: "overwrite" replaces the file (default), "append" adds to its end.',
            },
            append: { type: "boolean" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: getEditToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            find: { type: "string" },
            replace: { type: "string" },
            all: { type: "boolean" },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: getBashToolDescription(),
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutMs: { type: "integer" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "artifact_read",
        description: [
          "Read previously stored tool output by artifactId.",
          "This does not read workspace files; use `read` for repository paths.",
          "Optionally read a slice with startLine/endLine, maxChars, or tailLines.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            artifactId: { type: "string" },
            sessionId: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            maxChars: { type: "integer" },
            tailLines: { type: "integer" },
          },
          required: ["artifactId"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "plan_graph",
        description: [
          "Manage the persistent Plan Graph and graph-bound TaskRuns.",
          "TaskRuns are orthogonal to Plan Mode; for a standalone TaskRun without a plan, use `task_run` instead.",
          "Use create, patch, inspect, or cancel_graph for graph operations, and control for graph-bound TaskRun lifecycle.",
          "`control.start_task` starts a graph `task_loop` asynchronously and returns immediately.",
          "Use `inline_llm` for work handled by the current graph owner,",
          "`expand` for tasks that must be lowered into child nodes,",
          "and `task_loop` for asynchronous work in an independent TaskLoop attached to a plan node.",
          "Do not call `plan_graph` together with data-plane tools in the same assistant turn.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: [
                "create",
                "patch",
                "inspect",
                "clear",
                "cancel_graph",
                "control",
              ],
              description: [
                "create/patch/inspect/cancel_graph mutate or inspect the graph spec;",
                "control runs TaskRun lifecycle and node status actions.",
              ].join(" "),
            },
            graph: {
              type: "object",
              description: "Full graph for create (objective + nodes). group is input sugar only.",
            },
            operations: {
              type: "array",
              description: [
                "Patch ops only: add_node, expand_node, add_dependency, remove_dependency.",
                "Status actions (complete_task, skip_node, cancel_subtree) belong under control.actions.",
              ].join(" "),
              items: { type: "object" },
            },
            actions: {
              type: "array",
              description: [
                "Control actions: start_task, cancel_task, fail_task, complete_task, skip_node, cancel_subtree.",
                "complete_task with taskRunId finishes a TaskLoop TaskRun;",
                "complete_task with nodeId finishes a waiting_llm inline task owned by the graph owner.",
              ].join(" "),
              items: { type: "object" },
            },
            reason: {
              type: "string",
              description: "Optional reason for cancel_graph or fail/cancel task.",
            },
            commandId: {
              type: "string",
              description: [
                "Optional idempotency key for explicit replay.",
                "When omitted, the Runtime should derive one from the tool invocation when available.",
              ].join(" "),
            },
            expectedSpecRevision: {
              type: "integer",
              description: "Optional optimistic concurrency token for patch.",
            },
            graphId: {
              type: "string",
              description: "Optional graph id check for patch/control.",
            },
          },
          required: ["operation"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "task_run",
        description: [
          "Start, inspect, cancel, fail, or complete a TaskRun.",
          "TaskRuns are orthogonal to Plan Mode and do not require a plan_graph.",
          "Use operation=start with an objective for a standalone single-point TaskRun; it returns immediately.",
          "On complex multi-goal work, decompose into concrete objectives and start one or more TaskRuns.",
          "Use plan_graph control.start_task only when the TaskRun is attached to a plan_graph task_loop node.",
          "Do not call `task_run` together with data-plane tools in the same assistant turn.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["start", "cancel", "fail", "complete", "inspect"],
              description: [
                "start creates a standalone TaskRun from objective;",
                "cancel/fail/complete/inspect address an existing taskRunId",
                "(cancel/fail may also use nodeId for graph-bound runs).",
              ].join(" "),
            },
            objective: {
              type: "string",
              description: "Required for start: concrete TaskRun objective.",
            },
            title: {
              type: "string",
              description: "Optional short title for start.",
            },
            taskRunId: {
              type: "string",
              description: "TaskRun id for cancel, fail, complete, or inspect.",
            },
            nodeId: {
              type: "string",
              description: "Optional graph node id for cancel/fail of a graph-bound TaskRun.",
            },
            reason: {
              type: "string",
              description: "Optional reason for cancel or fail.",
            },
            result: {
              type: "object",
              description: "Optional result payload for complete (TaskLoop owner).",
            },
            commandId: {
              type: "string",
              description: "Optional idempotency key for explicit replay.",
            },
          },
          required: ["operation"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ask_user",
        description: [
          "Ask the user for input and pause the current Agent loop until the reply arrives.",
          "Use only when user input is required to proceed, not for routine updates or decisions the agent can safely make.",
          "`kind=approval` requests yes/no confirmation; `kind=choice` presents the supplied options; `kind=chat` requests free text.",
          "This must be the only tool call in the turn.",
          "The reply is returned only as this tool result, not as a separate user message or pending user prompt.",
          "After the tool returns, continue from the answer and do not ask the same question again.",
          "Running TaskRuns are not paused automatically.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["approval", "choice", "chat"],
              description: "Interaction type.",
            },
            prompt: {
              type: "string",
              description: "Question shown to the user.",
            },
            options: {
              type: "array",
              description: "For choice: option labels (or {key,label} objects). Ignored for chat.",
              items: {
                oneOf: [
                  { type: "string" },
                  {
                    type: "object",
                    properties: {
                      key: { type: "string" },
                      label: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
          required: ["kind", "prompt"],
        },
      },
    },
  ];
}

function buildAnthropicToolSpecs() {
  return buildCoreToolSpecs().map((spec) => ({
    name: spec.function.name,
    description: spec.function.description,
    input_schema: spec.function.parameters,
  }));
}

function createRequestController({ signal = null, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, normalizeTimeoutMs(timeoutMs));

  let abortHandler = null;
  if (signal && typeof signal === "object") {
    abortHandler = () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    };
    if (signal.aborted) {
      abortHandler();
    } else if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal && abortHandler && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortHandler);
      }
    },
  };
}

function parseJsonSafe(value = "", fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function cloneMessageList(value = []) {
  const parsed = parseJsonSafe(toJsonString(value), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function normalizeToolName(value = "") {
  const name = String(value || "").trim().toLowerCase();
  if (!CORE_TOOL_NAMES.has(name)) return "";
  return name;
}

function toJsonString(value) {
  return stableStringify(value);
}

function parseSseBlocks(text = "") {
  const source = String(text || "");
  const blocks = source.split(/\r?\n\r?\n/);
  if (blocks.length <= 1) {
    return { blocks: [], rest: source };
  }
  const rest = blocks.pop() || "";
  return { blocks, rest };
}

function parseSseEventBlock(block = "") {
  const lines = String(block || "").split(/\r?\n/);
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    data: data.join("\n"),
  };
}

function parseSseDataBlock(block = "") {
  return parseSseEventBlock(block).data;
}

function normalizeToolCallArgs(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return {};
  const parsed = parseJsonSafe(text, null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function runCoreTool({
  tool = "",
  args = {},
  workspaceRoot = process.cwd(),
  onToolEvent = null,
  sessionId = "",
  onArtifactPersisted = null,
  executionState = null,
  origin = null,
  resume = null,
} = {}) {
  const normalizedTool = normalizeToolName(tool);
  if (!normalizedTool) {
    emitToolEvent(onToolEvent, {
      tool: String(tool || "unknown"),
      phase: "error",
      args: args && typeof args === "object" ? { ...args } : {},
      error: `unsupported tool: ${tool}`,
      origin,
    });
    return {
      ok: false,
      error: `unsupported tool: ${tool}`,
    };
  }

  const safeArgs = args && typeof args === "object" ? { ...args } : {};
  if (normalizedTool === "artifact_read" && sessionId && !safeArgs.sessionId) {
    safeArgs.sessionId = sessionId;
  }
  emitToolEvent(onToolEvent, {
    tool: normalizedTool,
    phase: "start",
    args: safeArgs,
    error: "",
    origin,
  });

  if (normalizedTool === "plan_graph") {
    const state = executionState && typeof executionState === "object"
      ? executionState
      : emptyExecutionState();
    const result = runPlanGraphCommand(safeArgs, {
      executionState: state,
      autoAdvance: true,
      parallel: true,
      runTool: ({ node, args: nestedArgs, tool: nestedTool, stepId }) => {
        const nested = runCoreTool({
          tool: nestedTool,
          args: nestedArgs,
          workspaceRoot,
          onToolEvent,
          sessionId,
          onArtifactPersisted,
          executionState: state,
          origin: {
            kind: "plan_graph",
            graphId: String(state.planGraph && state.planGraph.graphId || ""),
            graphRevision: Number(state.planGraph && state.planGraph.specRevision) || 0,
            commandRevision: Number(state.planGraph && state.planGraph.specRevision) || 0,
            nodeId: stepId || (node && node.id) || "",
            attempt: Number(node && node.attempt) || 0,
          },
        });
        return nested;
      },
    });
    if (result.ok === false) {
      emitToolEvent(onToolEvent, {
        tool: "plan_graph",
        phase: "error",
        args: safeArgs,
        error: Array.isArray(result.errors)
          ? result.errors.map((e) => e.message || e.code).join("; ")
          : "plan_graph rejected",
        origin,
      });
    } else {
      syncInteractionFromPlanGraph(result.executionState || state);
    }
    return {
      ...result.modelPayload,
      ok: result.status === "accepted",
      executionState: result.executionState || state,
    };
  }

  if (normalizedTool === "task_run") {
    const state = executionState && typeof executionState === "object"
      ? executionState
      : emptyExecutionState();
    const result = runTaskRunTool(safeArgs, {
      executionState: state,
      runTool: ({ node, args: nestedArgs, tool: nestedTool, stepId }) => {
        const nested = runCoreTool({
          tool: nestedTool,
          args: nestedArgs,
          workspaceRoot,
          onToolEvent,
          sessionId,
          onArtifactPersisted,
          executionState: state,
          origin: {
            kind: "task_run",
            taskRunId: String(safeArgs.taskRunId || ""),
            nodeId: stepId || (node && node.id) || "",
            attempt: Number(node && node.attempt) || 0,
          },
        });
        return nested;
      },
    });
    const ok = result.ok !== false && result.status !== "rejected";
    emitToolEvent(onToolEvent, {
      tool: "task_run",
      phase: ok ? "end" : "error",
      args: safeArgs,
      result,
      error: ok
        ? ""
        : (Array.isArray(result.errors)
          ? result.errors.map((e) => e.message || e.code).join("; ")
          : (result.error || "task_run rejected")),
      origin,
    });
    return {
      ...result,
      ok,
      executionState: result.executionState || state,
    };
  }

  if (normalizedTool === "ask_user") {
    const state = executionState && typeof executionState === "object"
      ? executionState
      : emptyExecutionState();
    const result = runAskUserTool(safeArgs, {
      executionState: state,
      resume: resume || null,
    });
    const ok = result.ok !== false && result.status !== "rejected";
    emitToolEvent(onToolEvent, {
      tool: "ask_user",
      phase: ok ? "end" : "error",
      args: safeArgs,
      result: result.modelPayload || result,
      error: ok ? "" : (result.error || "ask_user rejected"),
      origin,
    });
    return {
      ...(result.modelPayload || result),
      ok,
      status: result.status,
      waiting_user: Boolean(result.waiting_user || result.status === "waiting_user"),
      interactionId: result.interactionId || "",
      executionState: result.executionState || state,
      deferToolResult: ok && result.status === "waiting_user",
    };
  }

  const toolOptions = { workspaceRoot, cwd: workspaceRoot };
  if (normalizedTool === "artifact_read" && sessionId) {
    toolOptions.sessionId = sessionId;
  }
  const result = runToolCall(
    { tool: normalizedTool, args: safeArgs },
    toolOptions,
  );

  if (!result || result.ok === false) {
    emitToolEvent(onToolEvent, {
      tool: normalizedTool,
      phase: "error",
      args: safeArgs,
      error: String((result && result.error) || `${normalizedTool} failed`),
      origin,
    });
    return result;
  }

  if (normalizedTool !== "artifact_read" && EXECUTABLE_GRAPH_TOOLS.has(normalizedTool)) {
    const persisted = persistToolResultToContext({
      workspaceRoot,
      sessionId,
      tool: normalizedTool,
      args: safeArgs,
      rawResult: result,
    });
    if (typeof onArtifactPersisted === "function") {
      try {
        onArtifactPersisted(persisted);
      } catch {
        // ignore
      }
    }
    const payload = persisted.modelPayload || result;
    if (origin) payload.origin = origin;
    return payload;
  }

  if (origin && result && typeof result === "object") {
    return { ...result, origin };
  }
  return result;
}

function emitPhase(callback, event = {}) {
  if (typeof callback !== "function") return;
  try {
    callback(event);
  } catch {
    // ignore phase callback failures
  }
}

// Shared SSE transport skeleton: POST the payload, then read the stream as
// SSE blocks, dispatch each non-[DONE] block to onEvent, and stop after the
// batch that carried [DONE]. Timeout/cancel translation and request cleanup
// live here so each protocol turn only declares its event handling.
async function runSseRequest({
  url = "",
  headers = {},
  payload = {},
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
  onPhase = null,
  onNonStream,
  onEvent,
  onTail = null,
  buildResult,
} = {}) {
  const request = createRequestController({ signal, timeoutMs });

  emitPhase(onPhase, { type: "request_start" });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: request.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`provider request failed (${response.status}): ${clipText(body, 500)}`);
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      const data = await response.json();
      return onNonStream(data);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawBuffer = "";
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(rawBuffer);
      rawBuffer = parsed.rest;

      for (const block of parsed.blocks) {
        const { event, data } = parseSseEventBlock(block);
        if (!data) continue;
        if (data === "[DONE]") {
          // Stop reading after this batch instead of waiting for the server
          // to close the connection, but keep the buffered tail and finish
          // the blocks already parsed alongside [DONE] instead of silently
          // dropping them.
          sawDone = true;
          continue;
        }

        onEvent({ event, data });
      }

      if (sawDone) break;
    }

    if (typeof onTail === "function") {
      onTail(rawBuffer);
    }

    return buildResult();
  } catch (err) {
    if (request.timedOut()) {
      const timeoutError = new Error(`CLI timeout (${normalizeTimeoutMs(timeoutMs)}ms)`);
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    if (signal && typeof signal === "object" && signal.aborted) {
      const cancelError = new Error("CLI cancelled");
      cancelError.code = "cancelled";
      throw cancelError;
    }
    throw err;
  } finally {
    request.cleanup();
  }
}

async function runOpenAiLikeTurn({
  url = "",
  apiKey = "",
  model = "",
  provider = "",
  messages = [],
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
} = {}) {
  const payload = {
    model,
    max_tokens: resolveMaxTokens(DEFAULT_OPENAI_MAX_TOKENS),
    messages,
    tools: buildCoreToolSpecs(),
    tool_choice: "auto",
    stream: true,
    // Ask for the terminal usage chunk so token/cache accounting works.
    stream_options: { include_usage: true },
    // Kimi k3 rejects any temperature other than 1.
    temperature: normalizeProvider(provider) === "kimi" ? 1 : 0,
  };
  const reasoningEffort = resolveReasoningEffort();
  if (reasoningEffort) {
    // OpenAI-compatible gateways that support reasoning models accept this;
    // unknown fields are typically ignored by plain chat models.
    payload.reasoning_effort = reasoningEffort;
  }

  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const toolCallMap = new Map();
  const announcedToolNames = new Set();
  let responseText = "";
  let nextSyntheticIndex = 0;
  let lastSyntheticIndex = -1;
  let streamUsage = null;

  return runSseRequest({
    url,
    headers,
    payload,
    signal,
    timeoutMs,
    onPhase,
    onNonStream: (data) => {
      const message = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message
        : {};
      const text = typeof message.content === "string" ? message.content : "";
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (text && typeof onTextDelta === "function") {
        onTextDelta(text);
      }
      return {
        text,
        toolCalls,
        usage: readOpenAiUsage(data && data.usage),
      };
    },
    onEvent: ({ data }) => {
      const chunk = parseJsonSafe(data, null);
      if (!chunk || typeof chunk !== "object") return;

      // The usage chunk carries empty choices, so read it before the
      // choice guard below; latest wins (it reports whole-turn totals).
      const chunkUsage = readOpenAiUsage(chunk.usage);
      if (chunkUsage) streamUsage = chunkUsage;

      const choice = chunk.choices && chunk.choices[0] ? chunk.choices[0] : null;
      if (!choice || typeof choice !== "object") return;

      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

      const reasoningChunk = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (reasoningChunk) {
        emitPhase(onPhase, { type: "thinking_delta", text: reasoningChunk });
        if (typeof onThinkingDelta === "function") {
          onThinkingDelta(reasoningChunk);
        }
      }

      if (typeof delta.content === "string" && delta.content) {
        responseText += delta.content;
        emitPhase(onPhase, { type: "text_delta", text: delta.content });
        if (typeof onTextDelta === "function") {
          onTextDelta(delta.content);
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const callPart of delta.tool_calls) {
          let index;
          if (Number.isFinite(callPart.index)) {
            index = callPart.index;
          } else if (typeof callPart.id === "string" && callPart.id) {
            // Provider omitted index: a chunk carrying an id starts a new
            // call, so give it its own synthetic index instead of
            // collapsing every call into slot 0.
            while (toolCallMap.has(nextSyntheticIndex)) nextSyntheticIndex += 1;
            index = nextSyntheticIndex;
            nextSyntheticIndex += 1;
            lastSyntheticIndex = index;
          } else if (lastSyntheticIndex >= 0) {
            // No index and no id: continuation of the latest synthetic call.
            index = lastSyntheticIndex;
          } else {
            index = 0;
          }
          const previous = toolCallMap.get(index) || {
            id: "",
            type: "function",
            function: {
              name: "",
              arguments: "",
            },
          };

          if (typeof callPart.id === "string" && callPart.id) previous.id = callPart.id;
          if (callPart.function && typeof callPart.function === "object") {
            if (typeof callPart.function.name === "string" && callPart.function.name) {
              previous.function.name = callPart.function.name;
            }
            if (typeof callPart.function.arguments === "string" && callPart.function.arguments) {
              previous.function.arguments += callPart.function.arguments;
            }
          }

          toolCallMap.set(index, previous);

          const toolName = previous.function.name;
          const announceKey = `${index}:${toolName}`;
          if (toolName && !announcedToolNames.has(announceKey)) {
            announcedToolNames.add(announceKey);
            emitPhase(onPhase, { type: "tool_request", name: toolName });
          }
        }
      }
    },
    onTail: (rawBuffer) => {
      if (!rawBuffer.trim()) return;
      const fallbackBlock = parseSseDataBlock(rawBuffer);
      if (fallbackBlock && fallbackBlock !== "[DONE]") {
        const chunk = parseJsonSafe(fallbackBlock, null);
        const tailUsage = readOpenAiUsage(chunk && chunk.usage);
        if (tailUsage) streamUsage = tailUsage;
        const choice = chunk && chunk.choices && chunk.choices[0] ? chunk.choices[0] : null;
        if (choice && choice.delta && typeof choice.delta.content === "string" && choice.delta.content) {
          responseText += choice.delta.content;
          if (typeof onTextDelta === "function") {
            onTextDelta(choice.delta.content);
          }
        }
      }
    },
    buildResult: () => ({
      text: responseText,
      toolCalls: Array.from(toolCallMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]),
      usage: streamUsage,
    }),
  });
}

function normalizeAnthropicMessageContent(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      if (item.type === "text") {
        return {
          type: "text",
          text: String(item.text || ""),
        };
      }
      if (item.type === "thinking") {
        return {
          type: "thinking",
          thinking: String(item.thinking || ""),
          signature: String(item.signature || ""),
        };
      }
      if (item.type === "tool_use") {
        return {
          type: "tool_use",
          id: String(item.id || ""),
          name: String(item.name || ""),
          input: item.input && typeof item.input === "object" && !Array.isArray(item.input)
            ? item.input
            : {},
        };
      }
      return null;
    })
    .filter(Boolean);
}

function extractAnthropicToolCalls(content = []) {
  return normalizeAnthropicMessageContent(content)
    .filter((item) => item.type === "tool_use")
    .map((item) => ({
      id: String(item.id || `tool_${randomUUID()}`),
      name: String(item.name || ""),
      args: item.input && typeof item.input === "object" && !Array.isArray(item.input)
        ? item.input
        : {},
    }));
}

// Mark the newest message with a cache breakpoint so the append-only history
// prefix is served from the prompt cache. The payload gets a copy: stamping
// cache_control onto the shared history array would leave stale breakpoints
// behind as later turns append, eventually exceeding the 4-breakpoint limit.
function withAnthropicCacheBreakpoint(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const copy = messages.slice();
  const lastIndex = copy.length - 1;
  const last = copy[lastIndex];
  if (!last || typeof last !== "object" || Array.isArray(last)) return copy;
  if (typeof last.content === "string") {
    if (!last.content) return copy;
    copy[lastIndex] = {
      ...last,
      content: [
        {
          type: "text",
          text: last.content,
          cache_control: { ...ANTHROPIC_CACHE_CONTROL },
        },
      ],
    };
    return copy;
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.slice();
    const blockIndex = blocks.length - 1;
    const block = blocks[blockIndex];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      blocks[blockIndex] = {
        ...block,
        cache_control: { ...ANTHROPIC_CACHE_CONTROL },
      };
      copy[lastIndex] = {
        ...last,
        content: blocks,
      };
    }
  }
  return copy;
}

async function runAnthropicTurn({
  url = "",
  apiKey = "",
  model = "",
  systemPrompt = "",
  systemBlocks = null,
  messages = [],
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
} = {}) {
  const payload = {
    model,
    max_tokens: resolveMaxTokens(DEFAULT_ANTHROPIC_MAX_TOKENS),
    messages: withAnthropicCacheBreakpoint(messages),
    tools: buildAnthropicToolSpecs(),
    stream: true,
  };
  const thinkingBudget = resolveThinkingBudgetTokens();
  if (thinkingBudget > 0) {
    payload.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  }
  if (Array.isArray(systemBlocks) && systemBlocks.length > 0) {
    payload.system = systemBlocksToAnthropicPayload(systemBlocks);
  } else {
    const systemText = String(systemPrompt || "").trim();
    if (systemText) {
      payload.system = [
        {
          type: "text",
          text: systemText,
          cache_control: { ...ANTHROPIC_CACHE_CONTROL },
        },
      ];
    }
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const blockMap = new Map();
  let responseText = "";
  let nextSyntheticBlockIndex = 0;
  let lastBlockIndex = -1;
  const turnUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

  return runSseRequest({
    url,
    headers,
    payload,
    signal,
    timeoutMs,
    onPhase,
    onNonStream: (data) => {
      const content = normalizeAnthropicMessageContent(data && data.content);
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      if (text && typeof onTextDelta === "function") {
        onTextDelta(text);
      }
      addUsageTotals(turnUsage, readAnthropicUsage(data && data.usage, { includeOutput: true }));
      return {
        text,
        assistantContent: content,
        toolCalls: extractAnthropicToolCalls(content),
        usage: turnUsage,
      };
    },
    onEvent: ({ event, data }) => {
      const payloadChunk = parseJsonSafe(data, null);
      if (!payloadChunk || typeof payloadChunk !== "object") return;

      if (event === "error") {
        const errMsg = payloadChunk.error && payloadChunk.error.message
          ? String(payloadChunk.error.message)
          : "anthropic stream error";
        throw new Error(errMsg);
      }

      if (event === "message_start") {
        const messageUsage = readAnthropicUsage(
          payloadChunk.message && typeof payloadChunk.message === "object"
            ? payloadChunk.message.usage
            : null
        );
        if (messageUsage) {
          turnUsage.input = messageUsage.input;
          turnUsage.cacheRead = messageUsage.cacheRead;
          turnUsage.cacheCreation = messageUsage.cacheCreation;
        }
        return;
      }

      if (event === "message_delta") {
        const deltaUsage = payloadChunk.usage && typeof payloadChunk.usage === "object"
          ? payloadChunk.usage
          : {};
        turnUsage.output += toUsageInt(deltaUsage.output_tokens);
        return;
      }

      if (event === "content_block_start") {
        let index;
        if (Number.isFinite(payloadChunk.index)) {
          index = payloadChunk.index;
        } else {
          // Provider omitted index: each start opens a new block, so give
          // it its own synthetic index instead of collapsing every block
          // into slot 0.
          while (blockMap.has(nextSyntheticBlockIndex)) nextSyntheticBlockIndex += 1;
          index = nextSyntheticBlockIndex;
          nextSyntheticBlockIndex += 1;
        }
        lastBlockIndex = index;
        const contentBlock = payloadChunk.content_block && typeof payloadChunk.content_block === "object"
          ? payloadChunk.content_block
          : {};

        if (contentBlock.type === "text") {
          blockMap.set(index, {
            order: index,
            type: "text",
            text: String(contentBlock.text || ""),
          });
        } else if (contentBlock.type === "thinking") {
          blockMap.set(index, {
            order: index,
            type: "thinking",
            text: String(contentBlock.thinking || ""),
            signature: String(contentBlock.signature || ""),
          });
        } else if (contentBlock.type === "tool_use") {
          blockMap.set(index, {
            order: index,
            type: "tool_use",
            id: String(contentBlock.id || ""),
            name: String(contentBlock.name || ""),
            input: contentBlock.input && typeof contentBlock.input === "object" && !Array.isArray(contentBlock.input)
              ? { ...contentBlock.input }
              : {},
            inputJson: "",
          });
          const toolName = String(contentBlock.name || "");
          if (toolName) {
            emitPhase(onPhase, { type: "tool_request", name: toolName });
          }
        }
        return;
      }

      if (event === "content_block_delta") {
        let index;
        if (Number.isFinite(payloadChunk.index)) {
          index = payloadChunk.index;
        } else if (lastBlockIndex >= 0) {
          // No index: continuation of the most recently started block.
          index = lastBlockIndex;
        } else {
          index = 0;
        }
        const delta = payloadChunk.delta && typeof payloadChunk.delta === "object"
          ? payloadChunk.delta
          : {};
        const current = blockMap.get(index) || { order: index, type: "text", text: "" };

        if (delta.type === "text_delta") {
          const deltaText = String(delta.text || "");
          current.type = "text";
          current.text = `${String(current.text || "")}${deltaText}`;
          blockMap.set(index, current);
          if (deltaText) {
            responseText += deltaText;
            emitPhase(onPhase, { type: "text_delta", text: deltaText });
            if (typeof onTextDelta === "function") {
              onTextDelta(deltaText);
            }
          }
          return;
        }

        if (delta.type === "thinking_delta") {
          const deltaText = String(delta.thinking || "");
          current.type = "thinking";
          current.text = `${String(current.text || "")}${deltaText}`;
          blockMap.set(index, current);
          if (deltaText) {
            emitPhase(onPhase, { type: "thinking_delta", text: deltaText });
            if (typeof onThinkingDelta === "function") {
              onThinkingDelta(deltaText);
            }
          }
          return;
        }

        if (delta.type === "signature_delta") {
          // Signed thinking blocks must be replayed verbatim on later turns
          // (tool-use continuation contract), so accumulate the signature
          // alongside the thinking text.
          current.type = "thinking";
          current.signature = `${String(current.signature || "")}${String(delta.signature || "")}`;
          blockMap.set(index, current);
          return;
        }

        if (delta.type === "input_json_delta") {
          current.type = "tool_use";
          current.inputJson = `${String(current.inputJson || "")}${String(delta.partial_json || "")}`;
          blockMap.set(index, current);
          return;
        }
      }
    },
    buildResult: () => {
      const assistantContent = Array.from(blockMap.values())
        .sort((a, b) => a.order - b.order)
        .map((item) => {
          if (item.type === "thinking") {
            // Kept (with signature) so tool-use continuation turns can
            // replay the thinking blocks the API requires.
            return {
              type: "thinking",
              thinking: String(item.text || ""),
              signature: String(item.signature || ""),
            };
          }

          if (item.type === "text") {
            return {
              type: "text",
              text: String(item.text || ""),
            };
          }

          const inputFromDelta = normalizeToolCallArgs(item.inputJson || "");
          const mergedInput = {
            ...(item.input && typeof item.input === "object" ? item.input : {}),
            ...(inputFromDelta && typeof inputFromDelta === "object" ? inputFromDelta : {}),
          };
          return {
            type: "tool_use",
            id: String(item.id || `tool_${randomUUID()}`),
            name: String(item.name || ""),
            input: mergedInput,
          };
        });

      if (!responseText) {
        responseText = assistantContent
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
      }

      return {
        text: responseText,
        assistantContent,
        toolCalls: extractAnthropicToolCalls(assistantContent),
        usage: turnUsage,
      };
    },
  });
}

const {
  createOpenAiChatTransport,
  createAnthropicMessagesTransport,
} = require("./providers");

// Transport descriptors: wire-format only. Plan Mode / leases / policy live in the loop.
const TRANSPORTS = {
  "openai-chat": createOpenAiChatTransport({
    resolveUrl: resolveCompletionUrl,
    runTurn: runOpenAiLikeTurn,
    normalizeToolName,
    normalizeToolCallArgs,
    toJsonString,
    clipText,
  }),
  "anthropic-messages": createAnthropicMessagesTransport({
    resolveUrl: resolveAnthropicMessagesUrl,
    runTurn: runAnthropicTurn,
    toJsonString,
    clipText,
  }),
};

function pendingToolCallId(pending = null) {
  if (!pending || !pending.source) return "";
  return String(pending.source.id || "").trim();
}

function shadowDeclarePendingCalls(ledger, pendingCalls = []) {
  const entries = (Array.isArray(pendingCalls) ? pendingCalls : []).map((pending) => ({
    callId: pendingToolCallId(pending) || `call_${randomUUID()}`,
    name: String(pending && pending.name || "").trim().toLowerCase(),
    args: pending && pending.args != null ? pending.args : {},
  }));
  // Keep source ids aligned when we had to synthesize.
  for (let i = 0; i < entries.length; i += 1) {
    const pending = pendingCalls[i];
    if (pending && pending.source && !pending.source.id) {
      pending.source.id = entries[i].callId;
    }
  }
  return declareCalls(ledger, entries);
}

function shadowResolvePending(ledger, pending, toolResult) {
  if (!ledger) return;
  const callId = pendingToolCallId(pending);
  if (!callId) return;
  resolveCall(ledger, callId, {
    result: toolResult,
    isError: Boolean(!toolResult || toolResult.ok === false),
  });
}

function pendingByIdMap(pendingCalls = []) {
  const map = Object.create(null);
  for (const pending of pendingCalls) {
    const id = pendingToolCallId(pending);
    if (id) map[id] = pending;
  }
  return map;
}

function flushLedgerToolResults(ledger, transport, messages, pendingCalls) {
  return materializeResolvedToolResults(ledger, {
    transport,
    messages,
    pendingById: pendingByIdMap(pendingCalls),
  });
}

async function runNativeLoop({
  transport,
  workspaceRoot = process.cwd(),
  prompt = "",
  systemPrompt = "",
  systemBlocks = null,
  historyMessages = [],
  model = "",
  baseUrl = "",
  apiKey = "",
  provider = "",
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
  onStreamDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  onToolEvent = null,
  onArtifactPersisted = null,
  sessionId = "",
  signal = null,
  guards,
  executionState: initialExecutionState = null,
  resume = false,
} = {}) {
  const requestModel = String(model || "").trim();
  if (!requestModel) {
    throw new Error("ucode model is not configured");
  }

  const requestUrl = transport.resolveUrl(baseUrl);
  if (!requestUrl) {
    throw new Error("ucode baseUrl is not configured");
  }

  const messages = sanitizeModelMessages(cloneMessageList(historyMessages));
  if (!resume) {
    transport.prepareMessages({ messages, systemPrompt, prompt });
  }

  let aggregated = "";
  let streamed = false;
  let toolCallsExecuted = 0;
  let toolErrors = 0;
  let executionState = initialExecutionState && typeof initialExecutionState === "object"
    ? initialExecutionState
    : emptyExecutionState();
  if (typeof executionState.planMode !== "boolean") executionState.planMode = false;
  ensurePendingUserPrompts(executionState);
  const toolBudget = resolveNativeToolBudget();
  const usage = createUsageTotals();
  // Shadow Tool Call Ledger (R1). Observes declare/defer/resolve; does not
  // materialize Provider messages yet. STRICT via UFOO_UCODE_PROTOCOL_STRICT=1.
  let activeLedger = null;
  let lastProtocolLedger = null;
  let planAutoContinues = 0;
  let lastAutoContinueWaitingId = "";
  let consecutiveEmptyAutoContinues = 0;

  if (resume) {
    await withFaultPoint("before_provider_resume", () => {});
  }

  function injectPendingUserReminders() {
    const nudges = drainUserPrompts(executionState);
    if (nudges.length === 0) return;
    const waiting = executionState.planGraph && executionState.planGraph.waitingFor
      ? executionState.planGraph.waitingFor
      : null;
    const content = formatUserReminderMessage(nudges, { waitingFor: waiting });
    if (!content) return;
    messages.push({ role: "user", content });
  }

  /** Deliver mid-loop TaskRun runtime events before the next model call. */
  function injectRuntimeMailboxEvents() {
    const drained = drainAgentMailboxForTurn(executionState);
    if (!drained.text) return false;
    messages.push({ role: "user", content: drained.text });
    return true;
  }

  function nextAutoContinueKey() {
    const waitingId = String(
      (executionState.planGraph && executionState.planGraph.waitingFor
        && executionState.planGraph.waitingFor.id) || ""
    ).trim();
    if (waitingId) return `plan:${waitingId}`;
    const runs = listTaskRunsAwaitingModel(executionState);
    if (runs.length > 0) {
      return `task:${runs.map((run) => run.id).sort().join(",")}`;
    }
    return "mailbox";
  }

  function tryInjectAgentAutoContinue() {
    if (planAutoContinues >= DEFAULT_MAX_PLAN_AUTO_CONTINUES) return false;
    const continueKey = nextAutoContinueKey();
    if (
      consecutiveEmptyAutoContinues >= 2
      && continueKey
      && continueKey === lastAutoContinueWaitingId
    ) {
      return false;
    }

    // Prefer draining fresh runtime mail (task_started, etc.) before nudges.
    if (injectRuntimeMailboxEvents()) {
      planAutoContinues += 1;
      lastAutoContinueWaitingId = continueKey;
      consecutiveEmptyAutoContinues += 1;
      return true;
    }

    if (shouldAutoContinuePlan(executionState)) {
      const reminder = buildPlanAutoContinueReminder(executionState);
      if (!reminder) return false;
      messages.push({ role: "user", content: reminder });
      planAutoContinues += 1;
      lastAutoContinueWaitingId = continueKey;
      consecutiveEmptyAutoContinues += 1;
      return true;
    }

    if (shouldAutoContinueForTaskWake(executionState)) {
      const reminder = buildTaskRunWakeReminder(executionState);
      if (!reminder) return false;
      messages.push({ role: "user", content: reminder });
      planAutoContinues += 1;
      lastAutoContinueWaitingId = continueKey;
      consecutiveEmptyAutoContinues += 1;
      return true;
    }

    return false;
  }

  while (true) {
    guards.ensureActive();

    injectPendingUserReminders();
    injectRuntimeMailboxEvents();

    if (activeLedger) {
      runProviderTurnGate(activeLedger);
    }

    const turnResult = await transport.runTurn({
      url: requestUrl,
      apiKey,
      model: requestModel,
      provider,
      systemPrompt,
      systemBlocks,
      messages,
      signal,
      timeoutMs,
      onPhase,
      onThinkingDelta,
      onTextDelta: (chunk) => {
        const text = String(chunk || "");
        if (!text) return;
        aggregated += text;
        if (typeof onStreamDelta === "function") {
          streamed = true;
          onStreamDelta(text);
        }
      },
    });

    usage.turns += 1;
    addUsageTotals(usage, turnResult && turnResult.usage);

    const toolCalls = transport.getToolCalls(turnResult);

    if (toolCalls.length === 0) {
      const text = String(turnResult.text || "").trim();
      const sideEffects = parseStructuredSideEffects(text);
      const planCommand = sideEffects ? normalizePlanGraphCommand(sideEffects) : null;
      if (planCommand) {
          transport.appendFinalAssistantMessage({ messages, turnResult });
          const planResult = runCoreTool({
            tool: "plan_graph",
            args: planCommand,
            workspaceRoot,
            onToolEvent,
            sessionId,
            onArtifactPersisted,
            executionState,
            origin: { kind: "legacy_side_effect", source: planCommand.source || "legacy" },
          });
          if (planResult && planResult.executionState) {
            executionState = planResult.executionState;
          }
          messages.push({
            role: "user",
            content: JSON.stringify({
              type: "plan_graph_result",
              ...((planResult && planResult.status)
                ? planResult
                : { status: "rejected", ok: false, error: "plan_graph failed" }),
            }),
          });
          continue;
      }
      transport.appendFinalAssistantMessage({ messages, turnResult });
      if (!aggregated.trim() && text) {
        aggregated = text;
      }
      if (tryInjectAgentAutoContinue()) {
        continue;
      }
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
        usage,
        executionState,
        protocolLedger: lastProtocolLedger || snapshotLedger(activeLedger),
      };
    }

    // A tool-using turn resets the empty auto-continue streak (progress possible).
    consecutiveEmptyAutoContinues = 0;

    const pendingCalls = transport.prepareToolCalls({ messages, turnResult, toolCalls });
    if (!pendingCalls) {
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
        usage,
        executionState,
        protocolLedger: lastProtocolLedger || snapshotLedger(activeLedger),
      };
    }

    activeLedger = createToolCallLedger({ provider, sessionId });
    shadowDeclarePendingCalls(activeLedger, pendingCalls);
    lastProtocolLedger = snapshotLedger(activeLedger);
    await withFaultPoint("after_prepare_tool_calls", () => {});
    await withFaultPoint("before_tool_exec", () => {});

    const callNames = pendingCalls.map((call) => String(call.name || "").trim().toLowerCase());
    const hasControlPlane = callNames.some((name) => CONTROL_PLANE_TOOLS.has(name));
    const hasAskUser = callNames.includes("ask_user");
    const hasDataTool = callNames.some((name) => EXECUTABLE_GRAPH_TOOLS.has(name));
    if (hasControlPlane && hasDataTool) {
      // prepareToolCalls already appended the assistant tool_calls / tool_use
      // message; every declared call must get a contiguous tool result via ledger.
      const rejected = {
        ok: false,
        status: "rejected",
        error: "Do not mix plan_graph/task_run with data-plane tools in the same turn",
        code: "MIXED_PLAN_AND_DATA_TOOLS",
      };
      for (const pending of pendingCalls) {
        shadowResolvePending(activeLedger, pending, rejected);
        toolCallsExecuted += 1;
        toolErrors += 1;
      }
      flushLedgerToolResults(activeLedger, transport, messages, pendingCalls);
      lastProtocolLedger = snapshotLedger(activeLedger);
      continue;
    }
    if (hasAskUser && pendingCalls.length > 1) {
      const rejected = {
        ok: false,
        status: "rejected",
        error: "ask_user must be the only tool call in the turn",
        code: "ASK_USER_MUST_BE_ALONE",
      };
      for (const pending of pendingCalls) {
        shadowResolvePending(activeLedger, pending, rejected);
        toolCallsExecuted += 1;
        toolErrors += 1;
      }
      flushLedgerToolResults(activeLedger, transport, messages, pendingCalls);
      lastProtocolLedger = snapshotLedger(activeLedger);
      continue;
    }

    let deferredAskUser = null;
    for (const pending of pendingCalls) {
      const pendingName = String(pending.name || "").trim().toLowerCase();
      if (
        EXECUTABLE_GRAPH_TOOLS.has(pendingName)
        && activePlanRequiresExpansion(executionState.planGraph)
      ) {
        const blocked = {
          ok: false,
          status: "rejected",
          errors: [{
            code: "ACTIVE_PLAN_REQUIRES_EXPANSION",
            message: "Active plan is waiting on a task; use plan_graph expand_node or control.complete_task instead of direct tools",
          }],
        };
        toolCallsExecuted += 1;
        toolErrors += 1;
        shadowResolvePending(activeLedger, pending, blocked);
        continue;
      }
      if (planModeBlocksDirectTool(pendingName, executionState)) {
        const blocked = {
          ok: false,
          status: "rejected",
          errors: [{
            code: "PLAN_MODE_BLOCKS_SIDE_EFFECT",
            message: "Plan mode is on; use plan_graph for write/edit/bash, or ask the user to /plan off",
          }],
        };
        toolCallsExecuted += 1;
        toolErrors += 1;
        shadowResolvePending(activeLedger, pending, blocked);
        continue;
      }
      const leaseCheck = checkWriteAllowed(executionState, {
        tool: pendingName,
        originKind: "agent_loop",
      });
      if (!leaseCheck.ok) {
        const blocked = {
          ok: false,
          status: "rejected",
          errors: [{
            code: leaseCheck.code || "WORKSPACE_WRITE_LEASE_HELD",
            message: leaseCheck.message
              || "Workspace write lease held by an active TaskRun",
            owner: leaseCheck.owner || null,
          }],
        };
        toolCallsExecuted += 1;
        toolErrors += 1;
        shadowResolvePending(activeLedger, pending, blocked);
        continue;
      }

      const toolCallId = pending.source && (pending.source.id || (pending.source.function && pending.source.id))
        ? String(pending.source.id || "")
        : "";
      const resumeForAsk = pendingName === "ask_user"
        ? {
          toolCallId: toolCallId || String((pending.source && pending.source.id) || `call_${randomUUID()}`),
          toolName: "ask_user",
          call: {
            name: pending.name,
            args: pending.args,
            source: pending.source,
          },
        }
        : null;

      markExecuting(activeLedger, pendingToolCallId(pending));
      const toolResult = runCoreTool({
        tool: pending.name,
        args: pending.args,
        workspaceRoot,
        onToolEvent,
        sessionId,
        onArtifactPersisted,
        executionState,
        resume: resumeForAsk,
      });
      if (toolResult && toolResult.executionState) {
        executionState = toolResult.executionState;
      }
      toolCallsExecuted += 1;
      if (!toolResult || toolResult.ok === false) {
        toolErrors += 1;
      }

      if (pendingName === "ask_user" && toolResult && toolResult.deferToolResult) {
        // Attach resume metadata onto pending interaction for contiguous tool_result later.
        const pendingInteraction = getPendingUserInteraction(executionState);
        if (pendingInteraction) {
          pendingInteraction.resume = {
            ...(pendingInteraction.resume || {}),
            ...(resumeForAsk || {}),
            mode: "ask_user",
            transport: provider === "anthropic" ? "anthropic-messages" : "openai-chat",
          };
        }
        deferCall(activeLedger, pendingToolCallId(pending), { reason: "ask_user" });
        deferredAskUser = { call: pending, interactionId: toolResult.interactionId || "" };
        continue;
      }

      enforceNativeToolBudget({
        toolCallsExecuted,
        toolErrors,
        maxToolCalls: toolBudget.maxToolCalls,
        maxToolErrors: toolBudget.maxToolErrors,
        lastTool: pending.name,
        lastError: toolResult && toolResult.error ? String(toolResult.error) : "",
      });
      shadowResolvePending(activeLedger, pending, toolResult);
    }

    flushLedgerToolResults(activeLedger, transport, messages, pendingCalls);
    lastProtocolLedger = snapshotLedger(activeLedger);

    if (deferredAskUser) {
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
        usage,
        executionState,
        waitingUserInteraction: true,
        interactionId: deferredAskUser.interactionId || "",
        protocolLedger: lastProtocolLedger,
      };
    }

    if (hasPendingUserInteraction(executionState)) {
      // Checkpoint approval synced from plan_graph — pause for TUI.
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
        usage,
        executionState,
        waitingUserInteraction: true,
        interactionId: (getPendingUserInteraction(executionState) || {}).id || "",
        protocolLedger: lastProtocolLedger,
      };
    }
  }
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
  onStreamDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  onToolEvent = null,
  onArtifactPersisted = null,
  signal = null,
  executionState = null,
  resume = false,
} = {}) {
  const guards = createGuards({ signal, timeoutMs });
  const nextSessionId = String(sessionId || "").trim() || `native-${randomUUID()}`;
  const promptText = String(prompt || "").trim();
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
    guards.ensureActive();

    if (!resume && !promptText) {
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

    const transport = TRANSPORTS[runtime.transport] || TRANSPORTS["openai-chat"];

    const runResult = await runNativeLoop({
      transport,
      workspaceRoot,
      prompt: resume ? "" : promptText,
      systemPrompt,
      systemBlocks,
      historyMessages: messages,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      provider: runtime.provider,
      timeoutMs,
      onStreamDelta: trackingStreamDelta,
      onThinkingDelta,
      onPhase,
      onToolEvent,
      onArtifactPersisted,
      sessionId: nextSessionId,
      signal,
      guards,
      executionState,
      resume: Boolean(resume),
    });

    const outputText = String(runResult.text || "").trim() || (
      runResult.toolCallsExecuted > 0
        ? `Completed ${runResult.toolCallsExecuted} tool call${runResult.toolCallsExecuted === 1 ? "" : "s"}.`
        : ""
    );

    const usage = runResult.usage && typeof runResult.usage === "object"
      ? runResult.usage
      : createUsageTotals();
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

    return {
      ok: true,
      error: "",
      output: outputText,
      messages: cloneMessageList(runResult.messages),
      sessionId: nextSessionId,
      usage,
      executionState: runResult.executionState || executionState || null,
      // The loop marks streamed=true whenever it receives a stream callback;
      // only report it when the caller actually registered one.
      streamed: Boolean(runResult.streamed) && typeof onStreamDelta === "function",
      waitingUserInteraction: Boolean(runResult.waitingUserInteraction),
      interactionId: runResult.interactionId || "",
      protocolLedger: runResult.protocolLedger || null,
    };
  } catch (err) {
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
    };
  }
}

module.exports = {
  runNativeAgentTask,
  appendAnswerToolResult,
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
  resolveTransport,
  resolveThinkingBudgetTokens,
  resolveReasoningEffort,
  buildCoreToolSpecs,
  buildAnthropicToolSpecs,
};
