const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");
const { spawnSync } = require("child_process");
const EventBus = require("../../coordination/bus");
const { readJSON, writeJSON } = require("../../coordination/bus/utils");
const { createActivityStatePublisher } = require("../activity/activityStatePublisher");
const { createActivityTracker } = require("../activity/activityTracker");
const { loadConfig, normalizeCodexInternalThreadMode } = require("../../config");
const { createCodexThreadProvider } = require("../providers/codexThreadProvider");
const { createClaudeThreadProvider } = require("../providers/claudeThreadProvider");
const { resolveClaudeUpstreamCredentials } = require("../providers/credentials/claude");
const { buildUpstreamAuthFromCredential } = require("../providers/credentials");
const { listToolsForCallerTier, CALLER_TIERS } = require("../../tools");
const { redactToolCallPayload, redactSecrets } = require("../../runtime/privacy/redactor");
const { buildCachedMemoryPrefix } = require("../../coordination/memory");
const { normalizePublisher, shouldForwardStreamToPublisher } = require("../launch/publisherRouting");
const { appendAgentRegistryDiagnostic } = require("../../coordination/state/agentRegistryDiagnostics");
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");
const {
  buildDefaultStartupBootstrapPrompt,
  isValueForCodexOption,
} = require("../prompts/defaultBootstrap");
const { hasSharedUfooProtocolPrompt } = require("../prompts/groupBootstrap");
const { buildPromptInjectionText } = require("../../coordination/bus/promptEnvelope");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWorkerThreadToolMode(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "worker-tier01" || raw === "tier01" || raw === "enabled" || raw === "1" || raw === "true") {
    return "worker-tier01";
  }
  return "disabled";
}

function buildEnv(agentType, sessionId, publisher, nickname) {
  const env = { ...process.env };
  env.AI_BUS_PUBLISHER = publisher || env.AI_BUS_PUBLISHER || "";
  env.UFOO_NICKNAME = nickname || env.UFOO_NICKNAME || "";
  env.UFOO_PARENT_PID = String(process.pid);
  return env;
}

function parseSubscriberId() {
  // Daemon 已经注册，直接使用
  if (process.env.UFOO_SUBSCRIBER_ID) {
    const parts = process.env.UFOO_SUBSCRIBER_ID.split(":");
    if (parts.length === 2) {
      return {
        subscriber: process.env.UFOO_SUBSCRIBER_ID,
        agentType: parts[0],
        sessionId: parts[1],
      };
    }
  }

  throw new Error("Internal runner requires UFOO_SUBSCRIBER_ID set by daemon");
}

function safeSubscriber(subscriber) {
  return subscriber.replace(/:/g, "_");
}

function readFileSafe(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return "";
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

function hasPromptArg(args = []) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const lastIndex = args.length - 1;
  const lastItem = String(args[lastIndex] || "").trim();
  if (!lastItem || lastItem.startsWith("-")) return false;
  return !isValueForCodexOption(args, lastIndex);
}

function consumeClaudeAppendSystemPrompt(args = []) {
  const nextArgs = [];
  const promptSegments = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || "");
    if (item === "--append-system-prompt") {
      const filePath = String(args[index + 1] || "");
      const content = readFileSafe(filePath);
      if (content.trim()) promptSegments.push(content.trim());
      index += 1;
      continue;
    }
    if (item.startsWith("--append-system-prompt=")) {
      const filePath = item.slice("--append-system-prompt=".length);
      const content = readFileSafe(filePath);
      if (content.trim()) promptSegments.push(content.trim());
      continue;
    }
    nextArgs.push(item);
  }
  return {
    args: nextArgs,
    promptText: promptSegments.filter(Boolean).join("\n\n"),
  };
}

function resolveInternalBootstrap({
  projectRoot = process.cwd(),
  agentType = "codex",
  extraArgs = [],
  env = process.env,
} = {}) {
  const normalizedAgent = String(agentType || "").trim().toLowerCase();
  const bootstrapAgentType = normalizedAgent === "claude" || normalizedAgent === "claude-code"
    ? "claude-code"
    : (normalizedAgent === "codex" ? "codex" : "");
  const args = Array.isArray(extraArgs) ? extraArgs.slice() : [];
  if (!bootstrapAgentType) {
    return { promptText: "", extraArgs: args };
  }

  let promptText = "";
  let nextArgs = args;

  if (bootstrapAgentType === "claude-code") {
    const consumed = consumeClaudeAppendSystemPrompt(args);
    promptText = consumed.promptText;
    nextArgs = consumed.args;
  } else if (hasPromptArg(args)) {
    promptText = String(args[args.length - 1] || "").trim();
    nextArgs = args.slice(0, -1);
  } else {
    promptText = String(env.UFOO_STARTUP_BOOTSTRAP_TEXT || "").trim();
  }

  if (!hasSharedUfooProtocolPrompt(promptText)) {
    const defaultPrompt = buildDefaultStartupBootstrapPrompt({
      agentType: bootstrapAgentType,
      projectRoot,
    }).trim();
    promptText = [defaultPrompt, promptText.trim()].filter(Boolean).join("\n\n");
  }

  return {
    promptText,
    extraArgs: nextArgs,
  };
}

function buildMemoryPrefix(projectRoot, limit = 50) {
  try {
    return buildCachedMemoryPrefix(projectRoot, { limit }).prefix.trim();
  } catch {
    return "";
  }
}

function readAgentsMap(projectRoot) {
  try {
    const data = readJSON(getUfooPaths(projectRoot).agentsFile, null);
    return data && data.agents && typeof data.agents === "object" ? data.agents : {};
  } catch {
    return {};
  }
}

function buildInternalPromptMessage(projectRoot, subscriber, evt = {}) {
  const message = String((evt.data && evt.data.message) || "");
  if (evt.__agentViewRaw) return message;
  return buildPromptInjectionText(evt, subscriber, readAgentsMap(projectRoot));
}

function createBusSender(projectRoot, subscriber) {
  const eventBus = new EventBus(projectRoot);
  let sendQueue = Promise.resolve();

  function enqueue(target, message) {
    if (!target || !message) return;
    sendQueue = sendQueue
      .then(() => eventBus.send(target, message, subscriber))
      .catch(() => {
        // ignore per-message bus send errors to keep runner loop alive
      });
  }

  async function flush() {
    try {
      await sendQueue;
    } catch {
      // ignore flush errors
    }
  }

  return { enqueue, flush };
}

function isChatUiSource(source = "") {
  const value = String(source || "").trim();
  return value === "chat-direct"
    || value === "chat-agent-view"
    || value === "chat-internal-agent-view";
}

function isUfooAgentDispatchSource(source = "") {
  const value = String(source || "").trim();
  return value === "ufoo-agent" || value === "ufoo-agent-gate-router";
}

function shouldStreamReplyToPublisher(projectRoot, publisher, evt = {}) {
  const source = evt && evt.data ? evt.data.source : "";
  if (isChatUiSource(source)) return true;
  if (normalizePublisher(publisher) === "ufoo-agent" && isUfooAgentDispatchSource(source)) return true;
  return shouldForwardStreamToPublisher(projectRoot, publisher);
}

function claimQueuedEvents(queueFile) {
  const queue = new DeliveryQueue(queueFile);
  const claims = [];
  while (true) {
    const claim = queue.claimNext();
    if (!claim) break;
    claims.push({ ...claim, queue });
  }
  return claims;
}

function parseAgentViewRawInput(message) {
  if (typeof message !== "string" || !message.trim()) return null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && parsed.raw === true && typeof parsed.data === "string") {
      return parsed.data;
    }
  } catch {
    // Not a raw agent-view envelope.
  }
  return null;
}

function createInteractiveInputSession({ write = () => {} } = {}) {
  let buffer = "";

  function writePrompt() {
    write("> ");
  }

  function handleRaw(data) {
    const submissions = [];
    const text = String(data || "");
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        const submitted = buffer.trim();
        buffer = "";
        write("\r\n");
        if (submitted) submissions.push(submitted);
        else writePrompt();
        continue;
      }

      if (char === "\u0003") {
        buffer = "";
        write("^C\r\n");
        writePrompt();
        continue;
      }

      if (char === "\u007f" || char === "\b") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          write("\b \b");
        }
        continue;
      }

      if (char >= " " && char !== "\u007f") {
        buffer += char;
        write(char);
      }
    }
    return submissions;
  }

  return {
    handleRaw,
    writePrompt,
    writeResponsePrompt: () => {
      write("\r\n");
      writePrompt();
    },
    getBuffer: () => buffer,
  };
}

async function handleEvent(
  projectRoot,
  agentType,
  provider,
  model,
  subscriber,
  nickname,
  evt,
  busSender,
  extraArgs = [],
  threadRuntime = null,
  bootstrapText = "",
  tracker = null
) {
  if (!evt || !evt.data || !evt.data.message) return;
  const memoryPrefix = buildMemoryPrefix(projectRoot);
  const promptMessage = buildInternalPromptMessage(projectRoot, subscriber, evt);
  const prompt = [bootstrapText, memoryPrefix, promptMessage]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const publisher = evt.publisher || "unknown";
  const streamToPublisher = shouldStreamReplyToPublisher(projectRoot, publisher, evt);

  const emitStreamDelta = (delta) => {
    const text = String(delta || "");
    if (!text) return;
    if (!streamToPublisher) return;
    busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: text }));
  };

  if (threadRuntime && threadRuntime.enabled && threadRuntime.thread) {
    return handleThreadedEvent({
      agentType,
      provider,
      publisher,
      prompt,
      busSender,
      emitStreamDelta,
      streamToPublisher,
      threadRuntime,
      tracker,
    });
  }

  const errorText = `[internal:${agentType}] error: no thread runtime available for provider ${provider}; cliRunner fallback has been removed`;
  // eslint-disable-next-line no-console
  console.error(errorText);
  if (streamToPublisher) {
    busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: errorText }));
    busSender.enqueue(publisher, JSON.stringify({ stream: true, done: true, reason: "error" }));
  } else {
    busSender.enqueue(publisher, errorText);
  }
  await busSender.flush();
}

function compactToolDetail(value = "", maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeThreadToolCall(event = {}) {
  const name = String(event.name || event.tool || event.tool_name || "tool").trim() || "tool";
  const args = event.args && typeof event.args === "object" ? event.args : {};
  const detail = args.command
    || args.cmd
    || args.code
    || args.path
    || args.file
    || args.target
    || args.query
    || "";
  return [name, compactToolDetail(detail)].filter(Boolean).join(" · ");
}

function toNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

// Normalizes provider usage payloads (claude/codex thread events) onto the
// metric fields read by extractModelMetrics in agents/controller/loopRuntime.js.
function normalizeTurnUsage(usage = null) {
  const item = usage && typeof usage === "object" ? usage : {};
  return {
    input_tokens: toNonNegativeInt(item.input_tokens || item.prompt_tokens),
    output_tokens: toNonNegativeInt(item.output_tokens || item.completion_tokens),
    cache_read_tokens: toNonNegativeInt(
      item.cache_read_tokens
        || item.cache_read_input_tokens
        || item.cached_input_tokens
        || (item.input_tokens_details && item.input_tokens_details.cached_tokens)
    ),
    cache_creation_tokens: toNonNegativeInt(
      item.cache_creation_tokens || item.cache_creation_input_tokens
    ),
  };
}

async function handleThreadedEvent({
  agentType,
  provider,
  publisher,
  prompt,
  busSender,
  emitStreamDelta,
  streamToPublisher = true,
  threadRuntime,
  tracker = null,
}) {
  try {
    const plainReplyParts = [];
    let turnUsage = null;
    let stopReason = "";
    if (tracker && typeof tracker.notifyTurnStart === "function") {
      tracker.notifyTurnStart();
    }
    for await (const event of threadRuntime.thread.runStreamed(prompt, {})) {
      if (!event || typeof event !== "object") continue;
      if (typeof threadRuntime.syncProviderSessionId === "function") {
        threadRuntime.syncProviderSessionId();
      }
      if (tracker && typeof tracker.onProviderEvent === "function") {
        tracker.onProviderEvent(event);
      }
      if (event.type === "text_delta" && event.delta) {
        if (streamToPublisher) {
          emitStreamDelta(event.delta);
        } else {
          plainReplyParts.push(String(event.delta));
        }
      } else if (event.type === "tool_call") {
        const summary = summarizeThreadToolCall(event);
        if (streamToPublisher && summary) {
          emitStreamDelta(`\nTool: ${summary}\n`);
        }
      } else if (event.type === "usage" && event.usage) {
        turnUsage = normalizeTurnUsage(event.usage);
      } else if (event.type === "turn_completed") {
        if (event.usage) turnUsage = normalizeTurnUsage(event.usage);
        if (event.stopReason) stopReason = String(event.stopReason);
      } else if (event.type === "turn_failed") {
        throw new Error(event.error || `thread turn failed for ${agentType}`);
      }
    }
    if (typeof threadRuntime.syncProviderSessionId === "function") {
      threadRuntime.syncProviderSessionId();
    }

    if (streamToPublisher) {
      const doneEnvelope = { stream: true, done: true, reason: "complete" };
      if (turnUsage) doneEnvelope.usage = turnUsage;
      busSender.enqueue(publisher, JSON.stringify(doneEnvelope));
    } else {
      const reply = plainReplyParts.join("").trim();
      if (reply) busSender.enqueue(publisher, reply);
    }
    await busSender.flush();
    return {
      ok: true,
      meta: {
        ...(turnUsage || normalizeTurnUsage(null)),
        stop_reason: stopReason,
      },
    };
  } catch (err) {
    if (threadRuntime && typeof threadRuntime.rebuildThread === "function") {
      await threadRuntime.rebuildThread();
    }
    if (tracker && typeof tracker.markIdle === "function") {
      tracker.markIdle();
    }
    const errorText = `[internal:${agentType}] error: ${err && err.message ? err.message : "unknown error"}`;
    // eslint-disable-next-line no-console
    console.error(errorText);
    if (streamToPublisher) {
      busSender.enqueue(
        publisher,
        JSON.stringify({ stream: true, delta: errorText })
      );
      busSender.enqueue(
        publisher,
        JSON.stringify({ stream: true, done: true, reason: "error" })
      );
    } else {
      busSender.enqueue(publisher, errorText);
    }
    await busSender.flush();
    return { ok: false, error: errorText };
  }
}

function getCodexThreadMode(projectRoot) {
  const envValue = process.env.UFOO_CODEX_INTERNAL_THREAD_MODE;
  if (typeof envValue === "string" && envValue.trim()) {
    return normalizeCodexInternalThreadMode(envValue);
  }
  return loadConfig(projectRoot).codexInternalThreadMode;
}

function getWorkerThreadToolMode() {
  return normalizeWorkerThreadToolMode(process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS);
}

function buildWorkerThreadToolRuntime({ projectRoot, subscriber, observer }) {
  const mode = getWorkerThreadToolMode();
  if (mode !== "worker-tier01") {
    return {
      enabled: false,
      mode,
      tools: [],
      executeToolCall: null,
    };
  }

  const eventBus = new EventBus(projectRoot);
  const toolDefinitions = listToolsForCallerTier(CALLER_TIERS.WORKER);
  const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const emitAudit = (phase, payload) => {
    if (observer && typeof observer.onToolCall === "function") {
      try { observer.onToolCall({ phase, payload }); } catch { /* ignore observer errors */ }
    }
  };

  return {
    enabled: toolDefinitions.length > 0,
    mode,
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    })),
    // Keep a shared-handler executor ready for a future continuation-capable SDK path.
    // The current Codex seam injects tool descriptors only and does not execute live
    // tool calls inside the SDK stream yet.
    async executeToolCall(toolCall = {}) {
      const name = String(toolCall.name || "").trim();
      const definition = toolsByName.get(name);
      const rawArgs = toolCall.arguments || toolCall.args || {};
      // Slice 1 (§10.7 tool pre-call): build a redacted audit envelope before
      // the handler receives args, so observability consumers never see raw secrets.
      const redactedPayload = redactToolCallPayload({
        name,
        args: rawArgs,
        tool_call_id: toolCall.tool_call_id || toolCall.toolCallId || "",
        caller_tier: CALLER_TIERS.WORKER,
      });
      emitAudit("pre_call", redactedPayload);
      if (!definition) {
        const errorResult = {
          ok: false,
          error: {
            code: "unsupported_tool",
            message: `worker tool is unavailable: ${name}`,
          },
        };
        emitAudit("post_call", { ...redactedPayload, result: errorResult });
        return errorResult;
      }

      try {
        const result = await definition.handler({
          caller_tier: CALLER_TIERS.WORKER,
          projectRoot,
          subscriber,
          eventBus,
          tool_call_id: toolCall.tool_call_id || toolCall.toolCallId || "",
          turn_id: toolCall.turn_id || toolCall.turnId || "",
        }, rawArgs);
        const safeResult = redactSecrets(result);
        emitAudit("post_call", { ...redactedPayload, result: safeResult });
        return safeResult;
      } catch (err) {
        const errorResult = {
          ok: false,
          error: {
            code: err && err.code ? err.code : "tool_execution_failed",
            message: err && err.message ? err.message : String(err || "tool execution failed"),
          },
        };
        const safeErrorResult = redactSecrets(errorResult);
        emitAudit("post_call", { ...redactedPayload, result: safeErrorResult });
        return safeErrorResult;
      }
    },
  };
}

function getClaudeThreadMode() {
  const envValue = process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;
  const raw = String(envValue || "").trim().toLowerCase();
  if (raw === "legacy" || raw === "off" || raw === "disabled" || raw === "0") return "legacy";
  if (raw === "api") return "api";
  return "api";
}

function buildClaudeAuthProvider(projectRoot) {
  const config = loadConfig(projectRoot);
  return async () => {
    const credential = await resolveClaudeUpstreamCredentials({
      profile: config.claudeOauthProfile,
      tokenPath: config.claudeOauthTokenPath,
      refreshWindowMs: Number(config.claudeOauthRefreshWindowSec || 300) * 1000,
    });
    return buildUpstreamAuthFromCredential(credential);
  };
}

function persistProviderSessionId(projectRoot, subscriber, providerSessionId) {
  const id = String(providerSessionId || "").trim();
  if (!projectRoot || !subscriber || !id) return false;
  try {
    const agentsFile = getUfooPaths(projectRoot).agentsFile;
    const parsed = fs.existsSync(agentsFile)
      ? readJSON(agentsFile, null)
      : {};
    if (!parsed) return false;
    if (!parsed.agents || typeof parsed.agents !== "object") return false;
    if (!parsed.agents[subscriber] || typeof parsed.agents[subscriber] !== "object") {
      appendAgentRegistryDiagnostic(agentsFile, "provider_session_subscriber_missing", {
        source: "agent.internalRunner.persistProviderSessionId",
        subscriber,
        known_ids: Object.keys(parsed.agents || {}).sort(),
      });
      return false;
    }
    if (parsed.agents[subscriber].provider_session_id === id) return false;
    parsed.agents[subscriber].provider_session_id = id;
    parsed.agents[subscriber].provider_session_updated_at = new Date().toISOString();
    writeJSON(agentsFile, parsed);
    return true;
  } catch {
    return false;
  }
}

function createThreadRuntime({ projectRoot, provider, model, extraArgs = [], subscriber = "", providerSessionId = "" }) {
  const disabledRuntime = {
    enabled: false,
    thread: null,
    toolRuntime: { enabled: false, mode: "disabled", tools: [] },
    close: async () => {},
    rebuildThread: async () => {},
    syncProviderSessionId: () => false,
  };

  const initialProviderSessionId = String(providerSessionId || "").trim();
  let savedProviderSessionId = initialProviderSessionId;

  function rememberProviderSessionId(thread) {
    const id = String(thread && thread.id ? thread.id : "").trim();
    if (!id || id === savedProviderSessionId) return false;
    const changed = persistProviderSessionId(projectRoot, subscriber, id);
    if (changed) savedProviderSessionId = id;
    return changed;
  }

  if (provider === "codex-cli") {
    if (getCodexThreadMode(projectRoot) !== "api") {
      return disabledRuntime;
    }

    try {
      const toolRuntime = buildWorkerThreadToolRuntime({
        projectRoot,
        subscriber,
      });
      let providerInstance = createCodexThreadProvider({
        model,
        cwd: projectRoot,
        extraArgs,
        tools: toolRuntime.tools,
      });
      let thread = initialProviderSessionId
        ? providerInstance.resumeThread(initialProviderSessionId)
        : providerInstance.startThread();

      return {
        enabled: true,
        toolRuntime,
        get thread() {
          return thread;
        },
        syncProviderSessionId() {
          return rememberProviderSessionId(thread);
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createCodexThreadProvider({
            model,
            cwd: projectRoot,
            extraArgs,
            tools: toolRuntime.tools,
          });
          thread = savedProviderSessionId
            ? providerInstance.resumeThread(savedProviderSessionId)
            : providerInstance.startThread();
        },
        async close() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
        },
      };
    } catch {
      return disabledRuntime;
    }
  }

  if (provider === "claude-cli") {
    if (getClaudeThreadMode() !== "api") {
      return disabledRuntime;
    }
    if (typeof createClaudeThreadProvider !== "function") {
      return disabledRuntime;
    }

    try {
      let providerInstance = createClaudeThreadProvider({
        model,
        cwd: projectRoot,
        extraArgs,
      });
      let thread = initialProviderSessionId
        ? providerInstance.resumeThread(initialProviderSessionId)
        : providerInstance.startThread();

      return {
        enabled: true,
        get thread() {
          return thread;
        },
        syncProviderSessionId() {
          return rememberProviderSessionId(thread);
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createClaudeThreadProvider({
            model,
            cwd: projectRoot,
            extraArgs,
          });
          thread = savedProviderSessionId
            ? providerInstance.resumeThread(savedProviderSessionId)
            : providerInstance.startThread();
        },
        async close() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
        },
      };
    } catch {
      return disabledRuntime;
    }
  }

  return disabledRuntime;
}

async function runInternalRunner({ projectRoot, agentType = "codex", extraArgs = [] }) {
  // Internal runner 必须由 daemon 启动，UFOO_SUBSCRIBER_ID 应该已经设置
  const { subscriber, agentType: parsedAgentType, sessionId } = parseSubscriberId();
  const nickname = process.env.UFOO_NICKNAME || "";

  const queueDir = path.join(getUfooPaths(projectRoot).busQueuesDir, safeSubscriber(subscriber));
  const queueFile = path.join(queueDir, "pending.jsonl");
  const normalizedAgentType = String(agentType || "").trim().toLowerCase();
  const provider = normalizedAgentType === "codex" ? "codex-cli" : "claude-cli";
  const model = process.env.UFOO_AGENT_MODEL || "";
  const bootstrap = resolveInternalBootstrap({
    projectRoot,
    agentType: normalizedAgentType,
    extraArgs,
    env: process.env,
  });
  const busSender = createBusSender(projectRoot, subscriber);
  const interactiveSessions = new Map();
  const threadRuntime = createThreadRuntime({
    projectRoot,
    provider,
    model,
    extraArgs: bootstrap.extraArgs,
    subscriber,
    providerSessionId: process.env.UFOO_PROVIDER_SESSION_ID || "",
  });

  let running = true;
  let processing = false;
  let lastHeartbeat = 0;
  const HEARTBEAT_INTERVAL = 30000; // 30秒心跳间隔

  const stop = () => {
    running = false;
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const agentsFile = getUfooPaths(projectRoot).agentsFile;
  const activityPublisher = createActivityStatePublisher({
    agentsFile, subscriber, projectRoot,
  });
  const activityTracker = createActivityTracker({ publisher: activityPublisher });

  function getInteractiveSession(publisher) {
    const key = String(publisher || "unknown");
    if (interactiveSessions.has(key)) return interactiveSessions.get(key);
    const session = createInteractiveInputSession({
      write: (delta) => {
        busSender.enqueue(key, JSON.stringify({ stream: true, delta: String(delta || "") }));
      },
    });
    interactiveSessions.set(key, session);
    return session;
  }

  activityTracker.notifyStarting("runner");
  if (threadRuntime && threadRuntime.enabled) {
    activityTracker.notifyReady(provider || "");
  } else {
    activityTracker.notifyReady("");
  }

  // 心跳更新函数
  const updateHeartbeat = () => {
    try {
      spawnSync("ufoo", ["bus", "check", subscriber], {
        cwd: projectRoot,
        env: { ...process.env, UFOO_SUBSCRIBER_ID: subscriber },
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // ignore heartbeat errors
    }
  };

  while (running) {
    // 定期心跳更新
    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      updateHeartbeat();
      lastHeartbeat = now;
    }

    if (!processing) {
      processing = true;
      try {
        const claims = claimQueuedEvents(queueFile);
        if (claims.length > 0) {
          let handledAny = false;

          for (const claim of claims) {
            const evt = claim.event;
            const runnableEvents = [];
            const rawInput = parseAgentViewRawInput(evt && evt.data ? evt.data.message : "");
            if (rawInput === null) {
              runnableEvents.push(evt);
            } else {
              const session = getInteractiveSession(evt.publisher || "unknown");
              const submissions = session.handleRaw(rawInput);
              for (const message of submissions) {
                runnableEvents.push({
                  ...evt,
                  __agentViewRaw: true,
                  data: {
                    ...(evt.data || {}),
                    message,
                  },
                });
              }
            }

            if (runnableEvents.length > 0) {
              activityTracker.notifyTurnStart("thinking");
            }

            try {
              for (const runnableEvent of runnableEvents) {
                // eslint-disable-next-line no-await-in-loop
                await handleEvent(
                  projectRoot,
                  parsedAgentType,
                  provider,
                  model,
                  subscriber,
                  nickname,
                  runnableEvent,
                  busSender,
                  bootstrap.extraArgs,
                  threadRuntime,
                  bootstrap.promptText,
                  activityTracker
                );
                if (runnableEvent.__agentViewRaw) {
                  getInteractiveSession(runnableEvent.publisher || "unknown").writeResponsePrompt();
                }
              }
              claim.queue.completeClaim(claim);
              if (runnableEvents.length > 0) handledAny = true;
            } catch (err) {
              claim.queue.restoreClaim(claim);
              throw err;
            }
          }
          // 处理消息后更新心跳
          updateHeartbeat();
          lastHeartbeat = now;
          if (handledAny) {
            activityTracker.markIdle();
          }
          await busSender.flush();
        }
      } finally {
        processing = false;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }

  await threadRuntime.close();
}

module.exports = {
  runInternalRunner,
  createBusSender,
  handleEvent,
  handleThreadedEvent,
  createThreadRuntime,
  getCodexThreadMode,
  getWorkerThreadToolMode,
  buildWorkerThreadToolRuntime,
  normalizeWorkerThreadToolMode,
  getClaudeThreadMode,
  buildClaudeAuthProvider,
  parseAgentViewRawInput,
  createInteractiveInputSession,
  resolveInternalBootstrap,
  persistProviderSessionId,
};
