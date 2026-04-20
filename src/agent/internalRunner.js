const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { spawnSync } = require("child_process");
const EventBus = require("../bus");
const { runCliAgent } = require("./cliRunner");
const { normalizeCliOutput } = require("./normalizeOutput");
const { createActivityStatePublisher } = require("./activityStatePublisher");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  extraArgs = []
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
              extraArgs
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
}

module.exports = {
  runInternalRunner,
  createBusSender,
  handleEvent,
};
