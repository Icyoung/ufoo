const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { spawnSync } = require("child_process");
const EventBus = require("../bus");
const { runCliAgent } = require("./cliRunner");
const { normalizeCliOutput } = require("./normalizeOutput");
const { createActivityStatePublisher } = require("./activityStatePublisher");
const { loadConfig, normalizeCodexInternalThreadMode } = require("../config");
const {
  createCodexThreadProvider,
  defaultCodexTransportStreamFactory,
} = require("./codexThreadProvider");
const {
  createClaudeThreadProvider,
  defaultClaudeTransportStreamFactory,
} = require("./claudeThreadProvider");
const { resolveClaudeUpstreamCredentials } = require("./credentials/claude");
const { buildUpstreamAuthFromCredential } = require("./credentials");
const { listToolsForCallerTier, CALLER_TIERS } = require("../tools");
const { redactToolCallPayload, redactSecrets } = require("../providerapi/redactor");

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

function shouldFallbackToLegacyThreadProvider(err, provider) {
  if (provider !== "claude-cli" || !err || typeof err !== "object") {
    return false;
  }
  const code = String(err.code || "").trim().toUpperCase();
  return (
    code === "CLAUDE_AUTH_UNAVAILABLE"
    || code === "CLAUDE_OAUTH_SCHEMA_UNSUPPORTED"
    || code === "ANTHROPIC_SDK_UNAVAILABLE"
  );
}

function drainQueue(queueFile) {
  if (!fs.existsSync(queueFile)) return [];
  const processingFile = `${queueFile}.processing.${process.pid}.${Date.now()}`;
  let content = "";
  let readOk = false;
  try {
    fs.renameSync(queueFile, processingFile);
    content = fs.readFileSync(processingFile, "utf8");
    readOk = true;
  } catch {
    try {
      if (fs.existsSync(processingFile)) {
        fs.renameSync(processingFile, queueFile);
      }
    } catch {
      // ignore rollback errors
    }
    return [];
  } finally {
    if (readOk) {
      try {
        if (fs.existsSync(processingFile)) {
          fs.rmSync(processingFile, { force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }
  if (!content.trim()) return [];
  return content.split(/\r?\n/).filter(Boolean);
}

async function handleEvent(
  projectRoot,
  agentType,
  provider,
  model,
  subscriber,
  nickname,
  evt,
  cliSessionState,
  busSender,
  extraArgs = [],
  threadRuntime = null
) {
  if (!evt || !evt.data || !evt.data.message) return;
  const prompt = evt.data.message;
  const publisher = evt.publisher || "unknown";
  const sandbox = "workspace-write";
  const streamState = { emitted: false, lastChar: "" };

  const emitStreamDelta = (delta) => {
    const text = String(delta || "");
    if (!text) return;
    streamState.emitted = true;
    streamState.lastChar = text.slice(-1);
    busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: text }));
  };

  if (threadRuntime && threadRuntime.enabled && threadRuntime.thread) {
    const threadedResult = await handleThreadedEvent({
      agentType,
      provider,
      publisher,
      prompt,
      busSender,
      emitStreamDelta,
      threadRuntime,
    });
    if (!threadedResult || !threadedResult.fallbackToLegacy) {
      return;
    }
  }

  let res = await runCliAgent({
    provider,
    model,
    prompt,
    sessionId: cliSessionState.cliSessionId,
    sandbox,
    cwd: projectRoot,
    extraArgs,
    onStreamDelta: emitStreamDelta,
  });

  // Handle session errors with immediate retry (only for claude)
  if (!res.ok && provider === "claude-cli") {
    const errMsg = (res.error || "").toLowerCase();
    if (errMsg.includes("session") || errMsg.includes("already in use")) {
      // Clear session and retry immediately with new session
      cliSessionState.cliSessionId = null;
      cliSessionState.needsSave = true;

      res = await runCliAgent({
        provider,
        model,
        prompt,
        sessionId: null, // Let runCliAgent generate new session
        sandbox,
        cwd: projectRoot,
        extraArgs,
        onStreamDelta: emitStreamDelta,
      });
    }
  }

  // Update CLI session ID for continuity (only for claude)
  if (res.ok && res.sessionId && provider === "claude-cli") {
    cliSessionState.cliSessionId = res.sessionId;
    cliSessionState.needsSave = true;
  }

  let reply = "";
  if (res.ok) {
    reply = normalizeCliOutput(res.output) || "";
  } else {
    reply = `[internal:${agentType}] error: ${res.error || "unknown error"}`;
  }

  if (streamState.emitted) {
    if (!res.ok) {
      if (streamState.lastChar !== "\n") {
        busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: "\n" }));
      }
      busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: reply }));
    }
    busSender.enqueue(
      publisher,
      JSON.stringify({ stream: true, done: true, reason: res.ok ? "complete" : "error" })
    );
    await busSender.flush();
    return;
  }

  if (!reply) return;

  busSender.enqueue(publisher, reply);
  await busSender.flush();
}

async function handleThreadedEvent({
  agentType,
  provider,
  publisher,
  prompt,
  busSender,
  emitStreamDelta,
  threadRuntime,
}) {
  try {
    for await (const event of threadRuntime.thread.runStreamed(prompt, {})) {
      if (!event || typeof event !== "object") continue;
      if (event.type === "text_delta" && event.delta) {
        emitStreamDelta(event.delta);
      } else if (event.type === "turn_failed") {
        throw new Error(event.error || `thread turn failed for ${agentType}`);
      }
    }

    busSender.enqueue(
      publisher,
      JSON.stringify({ stream: true, done: true, reason: "complete" })
    );
    await busSender.flush();
  } catch (err) {
    if (shouldFallbackToLegacyThreadProvider(err, provider)) {
      return { fallbackToLegacy: true };
    }
    if (threadRuntime && typeof threadRuntime.rebuildThread === "function") {
      await threadRuntime.rebuildThread();
    }
    busSender.enqueue(
      publisher,
      JSON.stringify({
        stream: true,
        delta: `[internal:${agentType}] error: ${err && err.message ? err.message : "unknown error"}`,
      })
    );
    busSender.enqueue(
      publisher,
      JSON.stringify({ stream: true, done: true, reason: "error" })
    );
    await busSender.flush();
    return { fallbackToLegacy: false };
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
  if (raw === "api") return "api";
  return "legacy";
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

function createThreadRuntime({ projectRoot, provider, model, extraArgs = [], subscriber = "" }) {
  const disabledRuntime = {
    enabled: false,
    thread: null,
    toolRuntime: { enabled: false, mode: "disabled", tools: [] },
    close: async () => {},
    rebuildThread: async () => {},
  };

  if (provider === "codex-cli") {
    if (getCodexThreadMode(projectRoot) !== "sdk") {
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
        streamFactory: defaultCodexTransportStreamFactory,
      });
      let thread = providerInstance.startThread();

      return {
        enabled: true,
        toolRuntime,
        get thread() {
          return thread;
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
            streamFactory: defaultCodexTransportStreamFactory,
          });
          thread = providerInstance.startThread();
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
    if (typeof createClaudeThreadProvider !== "function" || typeof resolveClaudeUpstreamCredentials !== "function") {
      return disabledRuntime;
    }

    try {
      let providerInstance = createClaudeThreadProvider({
        model,
        authProvider: buildClaudeAuthProvider(projectRoot),
        streamFactory: defaultClaudeTransportStreamFactory,
      });
      let thread = providerInstance.startThread();

      return {
        enabled: true,
        get thread() {
          return thread;
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createClaudeThreadProvider({
            model,
            authProvider: buildClaudeAuthProvider(projectRoot),
            streamFactory: defaultClaudeTransportStreamFactory,
          });
          thread = providerInstance.startThread();
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
  if (normalizedAgentType === "ufoo" || normalizedAgentType === "ucode" || normalizedAgentType === "ufoo-code") {
    throw new Error("ufoo core is not supported by headless internal runner; use internal-pty");
  }
  const provider = normalizedAgentType === "codex" ? "codex-cli" : "claude-cli";
  const model = process.env.UFOO_AGENT_MODEL || "";
  const busSender = createBusSender(projectRoot, subscriber);
  const threadRuntime = createThreadRuntime({
    projectRoot,
    provider,
    model,
    extraArgs,
    subscriber,
  });

  // Session state management for CLI continuity
  // Use stable path based on nickname (if exists) or agent type, NOT subscriber ID
  const stableKey = nickname || `${agentType}-default`;
  const sessionDir = path.join(getUfooPaths(projectRoot).agentDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, `${stableKey}.json`);

  let cliSessionId = null;
  // Only load session for claude (codex doesn't support sessions)
  if (provider === "claude-cli") {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      cliSessionId = state.cliSessionId;
    } catch {
      // No previous session
    }
  }

  let running = true;
  let processing = false;
  let lastHeartbeat = 0;
  const HEARTBEAT_INTERVAL = 30000; // 30秒心跳间隔

  const stop = () => {
    running = false;
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const cliSessionState = { cliSessionId, needsSave: false };
  const agentsFile = getUfooPaths(projectRoot).agentsFile;
  const activityPublisher = createActivityStatePublisher({
    agentsFile, subscriber, projectRoot,
  });

  function setActivityState(state) {
    activityPublisher.publish(state);
  }

  setActivityState("ready");

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
        const lines = drainQueue(queueFile);
        if (lines.length > 0) {
          setActivityState("working");
          const events = [];
          for (const line of lines) {
            try {
              events.push(JSON.parse(line));
            } catch {
              // ignore malformed line
            }
          }

          for (const evt of events) {
            // eslint-disable-next-line no-await-in-loop
            await handleEvent(
              projectRoot,
              parsedAgentType,
              provider,
              model,
              subscriber,
              nickname,
              evt,
              cliSessionState,
              busSender,
              extraArgs,
              threadRuntime
            );
          }

          // Persist CLI session state after processing (only if changed and for claude)
          if (cliSessionState.needsSave && provider === "claude-cli") {
            try {
              fs.writeFileSync(stateFile, JSON.stringify({
                cliSessionId: cliSessionState.cliSessionId,
                nickname: nickname || "",
                updated_at: new Date().toISOString(),
              }));
              cliSessionState.needsSave = false;
            } catch {
              // ignore save errors
            }
          }

          // 处理消息后更新心跳
          updateHeartbeat();
          lastHeartbeat = now;
          setActivityState("idle");
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
  createThreadRuntime,
  getCodexThreadMode,
  getWorkerThreadToolMode,
  buildWorkerThreadToolRuntime,
  normalizeWorkerThreadToolMode,
  getClaudeThreadMode,
  buildClaudeAuthProvider,
  shouldFallbackToLegacyThreadProvider,
};
