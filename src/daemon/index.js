const fs = require("fs");
const path = require("path");
const net = require("net");
const { runUfooAgent } = require("../agent/ufooAgent");
const { launchAgent, closeAgent, resumeAgents } = require("./ops");
const { buildStatus } = require("./status");
const EventBus = require("../bus");
const NicknameManager = require("../bus/nickname");
const { generateInstanceId, subscriberToSafeName } = require("../bus/utils");
const { getUfooPaths } = require("../ufoo/paths");
const { scheduleProviderSessionProbe, loadProviderSessionCache } = require("./providerSessions");
const { loadConfig } = require("../config");

/**
 * Agent 进程管理器 - daemon 作为父进程监控所有 internal agents
 */
class AgentProcessManager {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.processes = new Map(); // subscriber_id -> child_process
  }

  /**
   * 注册子进程并监听退出事件
   */
  register(subscriberId, childProcess) {
    if (!subscriberId || !childProcess) return;

    this.processes.set(subscriberId, childProcess);

    childProcess.on("exit", (code, signal) => {
      this.processes.delete(subscriberId);

      // 自动清理 bus 状态
      try {
        const eventBus = new EventBus(this.projectRoot);
        eventBus.loadBusData();
        if (eventBus.busData.agents?.[subscriberId]) {
          eventBus.busData.agents[subscriberId].status = "inactive";
          eventBus.busData.agents[subscriberId].last_seen = new Date().toISOString();
          eventBus.saveBusData();
          console.log(`[daemon] Agent ${subscriberId} exited (code=${code}, signal=${signal}), marked inactive`);
        }
      } catch (err) {
        console.error(`[daemon] Failed to cleanup ${subscriberId}:`, err.message);
      }
    });

    childProcess.on("error", (err) => {
      console.error(`[daemon] Agent ${subscriberId} error:`, err.message);
      this.processes.delete(subscriberId);
    });
  }

  /**
   * 获取运行中的进程
   */
  get(subscriberId) {
    return this.processes.get(subscriberId);
  }

  /**
   * 获取所有进程数量
   */
  count() {
    return this.processes.size;
  }

  /**
   * 清理所有子进程
   */
  cleanup() {
    for (const [subscriberId, child] of this.processes.entries()) {
      try {
        child.kill("SIGTERM");
        console.log(`[daemon] Killed agent ${subscriberId}`);
      } catch {
        // ignore
      }
    }
    this.processes.clear();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameSpawnedAgent(projectRoot, agentType, nickname, startIso) {
  if (!nickname) return null;
  const busPath = getUfooPaths(projectRoot).agentsFile;
  const targetType = agentType === "codex" ? "codex" : "claude-code";
  const deadline = Date.now() + 10000;
  const eventBus = new EventBus(projectRoot);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
      let entries = Object.entries(bus.agents || {})
        .filter(([, meta]) => meta && meta.agent_type === targetType && meta.status === "active");
      if (startIso) {
        entries = entries.filter(([, meta]) => (meta.joined_at || "") >= startIso);
      }
      if (entries.length === 0) {
        await sleep(200);
        continue;
      }
      let candidates = entries.filter(([, meta]) => !meta.nickname);
      if (candidates.length === 0) candidates = entries;
      candidates.sort((a, b) => (a[1].joined_at || "").localeCompare(b[1].joined_at || ""));
      const [agentId] = candidates[candidates.length - 1];
      await eventBus.rename(agentId, nickname, "ufoo-agent");
      return { ok: true, agent_id: agentId, nickname };
    } catch (err) {
      lastError = err && err.message ? err.message : String(err || "rename failed");
      // ignore and retry
    }
    await sleep(200);
  }
  return { ok: false, nickname, error: lastError || "rename timeout" };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function socketPath(projectRoot) {
  return getUfooPaths(projectRoot).ufooSock;
}

function pidPath(projectRoot) {
  return getUfooPaths(projectRoot).ufooDaemonPid;
}

function logPath(projectRoot) {
  return getUfooPaths(projectRoot).ufooDaemonLog;
}

function writePid(projectRoot) {
  fs.writeFileSync(pidPath(projectRoot), String(process.pid));
}

function readPid(projectRoot) {
  try {
    return parseInt(fs.readFileSync(pidPath(projectRoot), "utf8"), 10);
  } catch {
    return null;
  }
}

function isRunning(projectRoot) {
  const pid = readPid(projectRoot);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    try {
      fs.unlinkSync(pidPath(projectRoot));
    } catch {
      // ignore
    }
    removeSocket(projectRoot);
    return false;
  }
}

function removeSocket(projectRoot) {
  const sock = socketPath(projectRoot);
  if (fs.existsSync(sock)) fs.unlinkSync(sock);
}

function parseJsonLines(buffer) {
  const lines = buffer.split(/\r?\n/).filter(Boolean);
  const items = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line));
    } catch {
      // ignore
    }
  }
  return items;
}

function readBus(projectRoot) {
  const busPath = getUfooPaths(projectRoot).agentsFile;
  try {
    return JSON.parse(fs.readFileSync(busPath, "utf8"));
  } catch {
    return null;
  }
}

function listSubscribers(projectRoot, agentType) {
  const bus = readBus(projectRoot);
  if (!bus) return [];
  return Object.entries(bus.agents || {})
    .filter(([, meta]) => meta && meta.agent_type === agentType)
    .map(([id]) => id);
}

async function waitForNewSubscriber(projectRoot, agentType, existing, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = listSubscribers(projectRoot, agentType);
    const diff = current.find((id) => !existing.includes(id));
    if (diff) return diff;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function checkAndCleanupNickname(projectRoot, nickname) {
  if (!nickname) return { existing: null, cleaned: false };
  const busPath = getUfooPaths(projectRoot).agentsFile;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entries = Object.entries(bus.agents || {})
      .filter(([, meta]) => meta && meta.nickname === nickname);

    if (entries.length === 0) {
      return { existing: null, cleaned: false };
    }

    // Check for active agent with same nickname
    const activeAgent = entries.find(([, meta]) => meta.status === "active");
    if (activeAgent) {
      return { existing: activeAgent[0], cleaned: false };
    }

    // Clean up offline agents with same nickname
    for (const [agentId] of entries) {
      delete bus.agents[agentId];
    }
    fs.writeFileSync(busPath, JSON.stringify(bus, null, 2));
    return { existing: null, cleaned: true };
  } catch {
    return { existing: null, cleaned: false };
  }
}

async function handleOps(projectRoot, ops = [], processManager = null) {
  const results = [];
  for (const op of ops) {
    if (op.action === "launch") {
      const count = op.count || 1;
      const agent = op.agent === "codex" ? "codex" : "claude";
      const nickname = op.nickname || "";
      const startTime = new Date(Date.now() - 1000);
      const startIso = startTime.toISOString();
      if (nickname && count > 1) {
        results.push({
          action: "launch",
          ok: false,
          agent,
          count,
          error: "nickname requires count=1",
        });
        continue;
      }
      try {
        // Check for existing agent with same nickname
        const { existing, cleaned } = checkAndCleanupNickname(projectRoot, nickname);
        if (existing) {
          // Agent with this nickname already exists and is active
          results.push({
            action: "launch",
            ok: true,
            agent,
            count,
            nickname: nickname || undefined,
            agent_id: existing,
            skipped: true,
            message: `Agent '${nickname}' already exists`,
          });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const launchResult = await launchAgent(projectRoot, agent, count, nickname, processManager);
        if (launchResult.subscriberIds && launchResult.subscriberIds.length > 0) {
          for (const subscriberId of launchResult.subscriberIds) {
            scheduleProviderSessionProbe({
              projectRoot,
              subscriberId,
              agentType: agent === "codex" ? "codex" : "claude-code",
              onResolved: (id, resolved) => {
                providerSessions.set(id, {
                  sessionId: resolved.sessionId,
                  source: resolved.source || "",
                  updated_at: new Date().toISOString(),
                });
              },
            });
          }
        }
        results.push({
          action: "launch",
          mode: launchResult.mode,
          ok: true,
          agent,
          count,
          nickname: nickname || undefined
        });
        if (nickname) {
          // eslint-disable-next-line no-await-in-loop
          const renameResult = await renameSpawnedAgent(projectRoot, agent, nickname, startIso);
          if (renameResult) {
            results.push({ action: "rename", ...renameResult });
          }
        }
      } catch (err) {
        results.push({ action: "launch", ok: false, agent, count, error: err.message });
      }
    } else if (op.action === "close") {
      const ok = await closeAgent(projectRoot, op.agent_id);
      results.push({ action: "close", ok, agent_id: op.agent_id });
    } else if (op.action === "rename") {
      const agentId = op.agent_id || "";
      const nickname = op.nickname || "";
      if (!agentId || !nickname) {
        results.push({
          action: "rename",
          ok: false,
          agent_id: agentId,
          nickname,
          error: "rename requires agent_id and nickname",
        });
        continue;
      }
      try {
        const eventBus = new EventBus(projectRoot);
        eventBus.ensureBus();
        eventBus.loadBusData();
        let targetId = agentId;
        if (!eventBus.busData?.agents?.[targetId]) {
          const nicknameManager = new NicknameManager(eventBus.busData || { agents: {} });
          const resolved = nicknameManager.resolveNickname(agentId);
          if (resolved) targetId = resolved;
        }
        if (!eventBus.busData?.agents?.[targetId]) {
          results.push({
            action: "rename",
            ok: false,
            agent_id: agentId,
            nickname,
            error: `agent not found: ${agentId}`,
          });
          continue;
        }
        const result = await eventBus.rename(targetId, nickname, "ufoo-agent");
        results.push({
          action: "rename",
          ok: true,
          agent_id: result.subscriber,
          nickname: result.newNickname,
          old_nickname: result.oldNickname,
        });
      } catch (err) {
        results.push({
          action: "rename",
          ok: false,
          agent_id: agentId,
          nickname,
          error: err && err.message ? err.message : String(err || "rename failed"),
        });
      }
    }
  }
  return results;
}

async function dispatchMessages(projectRoot, dispatch = []) {
  const eventBus = new EventBus(projectRoot);
  // Always use "ufoo-agent" as the publisher for daemon messages
  const defaultPublisher = "ufoo-agent";
  for (const item of dispatch) {
    if (!item || !item.target || !item.message) continue;
    const pub = item.publisher || defaultPublisher;
    try {
      if (item.target === "broadcast") {
        await eventBus.broadcast(item.message, pub);
      } else {
        await eventBus.send(item.target, item.message, pub);
      }
    } catch {
      // ignore dispatch failures
    }
  }
}

function startBusBridge(projectRoot, provider, onEvent, onStatus, shouldDrain) {
  const state = {
    subscriber: null,
    queueFile: null,
    pending: new Set(),
  };
  const eventBus = new EventBus(projectRoot);
  let joinInProgress = false;

  function getAgentNickname(agentId) {
    if (!agentId) return agentId;
    try {
      const busPath = getUfooPaths(projectRoot).agentsFile;
      const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
      const meta = bus.agents && bus.agents[agentId];
      if (meta && meta.nickname) {
        return meta.nickname;
      }
    } catch {
      // Ignore errors, return original ID
    }
    return agentId;
  }

  function ensureSubscriber() {
    if (state.subscriber || joinInProgress) return;
    const debugFile = path.join(getUfooPaths(projectRoot).runDir, "bus-join-debug.txt");
    joinInProgress = true;
    (async () => {
      try {
        fs.writeFileSync(debugFile, `Attempting join at ${new Date().toISOString()}\n`, { flag: "a" });
        // Determine agent type based on provider configuration
        const agentType = provider === "codex-cli" ? "codex" : "claude-code";
        // Use fixed ID "ufoo-agent" for daemon's bus identity with explicit nickname
        const sub = await eventBus.join("ufoo-agent", agentType, "ufoo-agent");
        if (!sub) {
          fs.writeFileSync(debugFile, "Join returned empty subscriber\n", { flag: "a" });
          return;
        }
        state.subscriber = sub;
        const safe = subscriberToSafeName(sub);
        state.queueFile = path.join(getUfooPaths(projectRoot).busQueuesDir, safe, "pending.jsonl");
        fs.writeFileSync(debugFile, `Successfully joined as ${sub} (type: ${agentType})\n`, { flag: "a" });
      } catch (err) {
        fs.writeFileSync(debugFile, `Exception: ${err.message || err}\n`, { flag: "a" });
      } finally {
        joinInProgress = false;
      }
    })();
  }

  function poll() {
    ensureSubscriber();
    if (typeof shouldDrain === "function" && !shouldDrain()) return;
    if (!state.queueFile) return;
    if (!fs.existsSync(state.queueFile)) return;
    let content = "";
    let readOk = false;
    const processingFile = `${state.queueFile}.processing.${process.pid}.${Date.now()}`;
    try {
      fs.renameSync(state.queueFile, processingFile);
      content = fs.readFileSync(processingFile, "utf8");
      readOk = true;
    } catch {
      try {
        if (fs.existsSync(processingFile)) {
          fs.renameSync(processingFile, state.queueFile);
        }
      } catch {
        // ignore rollback errors
      }
      return;
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

    const lines = content.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    for (const line of lines) {
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt) continue;
      if (onEvent) {
        onEvent({
          event: evt.event,
          publisher: evt.publisher,
          target: evt.target,
          message: evt.data?.message || "",
          ts: evt.timestamp || evt.ts,
        });
      }
      if (evt.publisher && state.pending.has(evt.publisher)) {
        state.pending.delete(evt.publisher);
        if (onStatus) {
          const displayName = getAgentNickname(evt.publisher);
          onStatus({ phase: "done", text: `${displayName} done`, key: evt.publisher });
        }
      }
    }
  }

  const interval = setInterval(poll, 1000);
  return {
    markPending(target) {
      if (!target) return;
      state.pending.add(target);
      if (onStatus) {
        const displayName = getAgentNickname(target);
        onStatus({ phase: "start", text: `${displayName} processing`, key: target });
      }
    },
    getSubscriber() {
      ensureSubscriber();
      try {
        fs.writeFileSync(path.join(getUfooPaths(projectRoot).runDir, "bridge-debug.txt"),
          `subscriber: ${state.subscriber || "NULL"}\nqueue: ${state.queueFile || "NULL"}\n`);
      } catch {}
      return state.subscriber;
    },
    stop() {
      clearInterval(interval);
    },
  };
}

function startDaemon({ projectRoot, provider, model, resumeMode = "auto" }) {
  const paths = getUfooPaths(projectRoot);
  if (!fs.existsSync(paths.ufooDir)) {
    throw new Error("Missing .ufoo. Run: ufoo init");
  }

  const runDir = paths.runDir;
  ensureDir(runDir);

  // 文件锁机制：防止多个 daemon 同时启动
  const lockFile = path.join(runDir, "daemon.lock");
  let lockFd;
  try {
    // 尝试独占方式打开锁文件（如果已存在且被锁定则失败）
    lockFd = fs.openSync(lockFile, "wx");
    fs.writeSync(lockFd, `${process.pid}\n`);
  } catch (err) {
    if (err.code === "EEXIST") {
      // 锁文件已存在，检查是否仍有效
      try {
        const existingPid = parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
        // 检查该进程是否还活着
        try {
          process.kill(existingPid, 0);
          throw new Error(`Daemon already running with PID ${existingPid}`);
        } catch {
          // 进程已死，清理旧锁
          fs.unlinkSync(lockFile);
          lockFd = fs.openSync(lockFile, "wx");
          fs.writeSync(lockFd, `${process.pid}\n`);
        }
      } catch (readErr) {
        throw new Error(`Failed to acquire daemon lock: ${readErr.message}`);
      }
    } else {
      throw err;
    }
  }

  removeSocket(projectRoot);
  writePid(projectRoot);

  const logFile = fs.createWriteStream(logPath(projectRoot), { flags: "a" });
  const log = (msg) => {
    logFile.write(`[daemon] ${new Date().toISOString()} ${msg}\n`);
  };

  // 创建进程管理器 - daemon 作为父进程监控所有 internal agents
  const processManager = new AgentProcessManager(projectRoot);
  log(`Process manager initialized`);

  // Provider session cache (in-memory)
  const providerSessions = loadProviderSessionCache(projectRoot);

  const sockets = new Set();
  const sendToSockets = (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    for (const sock of sockets) {
      if (!sock || sock.destroyed) continue;
      try {
        sock.write(line);
      } catch {
        // ignore write errors
      }
    }
  };

  const busBridge = startBusBridge(projectRoot, provider, (evt) => {
    sendToSockets({ type: "bus", data: evt });
  }, (status) => {
    sendToSockets({ type: "status", data: status });
  }, () => sockets.size > 0);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", async (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      const complete = lines.filter((l) => l.trim());
      for (const line of complete) {
        const items = parseJsonLines(line);
        for (const req of items) {
          if (!req || typeof req !== "object") continue;
          if (req.type === "status") {
            // 先清理不活跃的订阅者，确保状态准确
            try {
              const eventBus = new EventBus(projectRoot);
              eventBus.ensureBus();
              eventBus.loadBusData();
              eventBus.subscriberManager.cleanupInactive();
              eventBus.saveBusData();
            } catch {
              // ignore cleanup errors, proceed with status
            }
            const status = buildStatus(projectRoot);
            socket.write(`${JSON.stringify({ type: "status", data: status })}\n`);
            continue;
          }
          if (req.type === "prompt") {
            log(`prompt ${String(req.text || "").slice(0, 200)}`);
            let result;
            try {
              result = await runUfooAgent({
                projectRoot,
                prompt: req.text || "",
                provider,
                model,
              });
            } catch (err) {
              log(`error ${err.message || String(err)}`);
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: err.message || String(err),
                })}\n`,
              );
              continue;
            }
            if (!result.ok) {
              log(`agent-fail ${result.error || "agent failed"}`);
              socket.write(
                `${JSON.stringify({ type: "error", error: result.error || "agent failed" })}\n`,
              );
              continue;
            }
            for (const item of result.payload.dispatch || []) {
              if (item && item.target && item.target !== "broadcast") {
                busBridge.markPending(item.target);
              }
            }
            await dispatchMessages(projectRoot, result.payload.dispatch || []);
            const opsResults = await handleOps(projectRoot, result.payload.ops || [], processManager);
            log(`ok reply=${Boolean(result.payload.reply)} dispatch=${(result.payload.dispatch || []).length} ops=${(result.payload.ops || []).length}`);
            socket.write(
              `${JSON.stringify({
                type: "response",
                data: result.payload,
                opsResults,
              })}\n`,
            );
            continue;
          }
          if (req.type === "bus_send") {
            // Direct bus send request from chat UI
            const { target, message } = req;
            if (!target || !message) {
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: "bus_send requires target and message",
                })}\n`,
              );
              continue;
            }
            try {
              const publisher = busBridge.getSubscriber() || "ufoo-agent";
              const eventBus = new EventBus(projectRoot);
              await eventBus.send(target, message, publisher);
              log(`bus_send target=${target} publisher=${publisher}`);
              socket.write(
                `${JSON.stringify({
                  type: "bus_send_ok",
                })}\n`,
              );
            } catch (err) {
              log(`bus_send failed: ${err.message}`);
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: err.message || "bus_send failed",
                })}\n`,
              );
            }
            continue;
          }
          if (req.type === "launch_agent") {
            const { agent, count, nickname } = req;
            if (!agent || (agent !== "codex" && agent !== "claude")) {
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: "launch_agent requires agent=codex|claude",
                })}\n`,
              );
              continue;
            }
            const parsedCount = parseInt(count, 10);
            const finalCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1;
            const op = {
              action: "launch",
              agent,
              count: finalCount,
              nickname: nickname || "",
            };
            try {
              const opsResults = await handleOps(projectRoot, [op], processManager);
              const launchResult = opsResults.find((r) => r.action === "launch");
              const ok = launchResult ? launchResult.ok !== false : true;
              const reply = ok
                ? `Launched ${op.count} ${agent} agent(s)`
                : `Launch failed: ${launchResult?.error || "unknown error"}`;
              socket.write(
                `${JSON.stringify({
                  type: "response",
                  data: {
                    reply,
                    dispatch: [],
                    ops: [op],
                  },
                  opsResults,
                })}\n`,
              );
            } catch (err) {
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: err.message || "launch_agent failed",
                })}\n`,
              );
            }
            continue;
          }
          if (req.type === "resume_agents") {
            const target = req.target || "";
            try {
              const result = await resumeAgents(projectRoot, target, processManager);
              const resumedCount = result.resumed.length;
              const skippedCount = result.skipped.length;
              const reply = resumedCount > 0
                ? `Resumed ${resumedCount} agent(s)` + (skippedCount ? `, skipped ${skippedCount}` : "")
                : (skippedCount ? `No agents resumed (skipped ${skippedCount})` : "No agents resumed");
              socket.write(
                `${JSON.stringify({
                  type: "response",
                  data: {
                    reply,
                    resume: result,
                  },
                })}\n`,
              );
            } catch (err) {
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: err.message || "resume_agents failed",
                })}\n`,
              );
            }
            continue;
          }
          if (req.type === "register_agent") {
            // Manual agent launch requests daemon to register it
            const { agentType, nickname, parentPid, launchMode, tmuxPane, tty, skipProbe } = req;
            if (!agentType) {
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: "register_agent requires agentType",
                })}\n`,
              );
              continue;
            }
            try {
              const crypto = require("crypto");
              const sessionId = crypto.randomBytes(4).toString("hex");
              const subscriberId = `${agentType}:${sessionId}`;

              // Daemon registers the agent in bus
              const eventBus = new EventBus(projectRoot);
              await eventBus.init();
              eventBus.loadBusData();
              const parsedParentPid = Number.parseInt(parentPid, 10);
              if (!Number.isFinite(parsedParentPid) || parsedParentPid <= 0) {
                throw new Error("register_agent requires valid parentPid");
              }
              const joinOptions = {
                parentPid: Number.isFinite(parsedParentPid) ? parsedParentPid : undefined,
                launchMode: launchMode || "",
                tmuxPane: tmuxPane || "",
              };
              if (Object.prototype.hasOwnProperty.call(req, "tty")) {
                const ttyValue = typeof tty === "string" ? tty.trim() : "";
                joinOptions.tty = ttyValue;
                if (!ttyValue) {
                  log(`register_agent warning: missing tty for ${subscriberId}`);
                }
              }
              await eventBus.subscriberManager.join(sessionId, agentType, nickname || "", joinOptions);
              eventBus.saveBusData();

              const finalNickname = eventBus.busData?.agents?.[subscriberId]?.nickname || "";
              log(`register_agent type=${agentType} nickname=${finalNickname || "(none)"} id=${subscriberId}`);
              if (!skipProbe) {
                scheduleProviderSessionProbe({
                  projectRoot,
                  subscriberId,
                  agentType,
                  onResolved: (id, resolved) => {
                    providerSessions.set(id, {
                      sessionId: resolved.sessionId,
                      source: resolved.source || "",
                      updated_at: new Date().toISOString(),
                    });
                  },
                });
              }
              socket.write(
                `${JSON.stringify({
                  type: "register_ok",
                  subscriberId,
                  nickname: finalNickname || "",
                })}\n`,
              );
            } catch (err) {
              log(`register_agent failed: ${err.message}`);
              socket.write(
                `${JSON.stringify({
                  type: "error",
                  error: err.message || "register_agent failed",
                })}\n`,
              );
            }
            continue;
          }
        }
      }
    });
  });

  server.listen(socketPath(projectRoot));
  log(`Started pid=${process.pid}`);

  // 清理旧 daemon 留下的孤儿 internal agent 进程
  const EventBus = require("../bus");
  const { spawnSync } = require("child_process");
  const eventBus = new EventBus(projectRoot);
  try {
    eventBus.ensureBus();
    eventBus.loadBusData();
    const agents = eventBus.busData.agents || {};

    // 查找所有 agent-runner 进程
    const psResult = spawnSync("ps", ["aux"], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const lines = psResult.stdout ? psResult.stdout.split("\n") : [];
    const runnerProcesses = [];

    for (const line of lines) {
      if (line.includes("agent-pty-runner") || line.includes("agent-runner")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
          const pid = parseInt(parts[1], 10);
          if (Number.isFinite(pid)) {
            runnerProcesses.push({ pid, line });
          }
        }
      }
    }

    // 检查每个 runner 的父进程
    for (const runner of runnerProcesses) {
      try {
        const ppidResult = spawnSync("ps", ["-p", String(runner.pid), "-o", "ppid="], { encoding: "utf8" });
        const ppid = parseInt(ppidResult.stdout.trim(), 10);

        if (Number.isFinite(ppid)) {
          // 检查父进程是否存在
          try {
            process.kill(ppid, 0);
            // 父进程还活着，检查是否是 daemon
            const ppidCmd = spawnSync("ps", ["-p", String(ppid), "-o", "command="], { encoding: "utf8" });
            const cmd = ppidCmd.stdout.trim();

            if (!cmd.includes("daemon start")) {
              // 父进程不是 daemon，这是孤儿进程
              log(`Found orphan agent-runner process ${runner.pid} (parent ${ppid} is not a daemon)`);
              try {
                process.kill(runner.pid, "SIGTERM");
                log(`Killed orphan agent-runner ${runner.pid}`);
              } catch {
                // ignore
              }
            }
          } catch {
            // 父进程已死，杀掉孤儿进程
            log(`Found orphan agent-runner process ${runner.pid} (parent ${ppid} is dead)`);
            try {
              process.kill(runner.pid, "SIGTERM");
              log(`Killed orphan agent-runner ${runner.pid}`);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }

    // 标记对应的 agents 为 inactive
    for (const [subscriberId, meta] of Object.entries(agents)) {
      if (meta.launch_mode && meta.launch_mode.startsWith("internal")) {
        if (meta.pid) {
          try {
            process.kill(meta.pid, 0);
            // 父 daemon 还活着，跳过
          } catch {
            // 父 daemon 已死，标记为 inactive
            // 注意：不更新 last_seen，保持原有时间戳，这样会自动超时
            meta.status = "inactive";
            log(`Marked orphan internal agent ${subscriberId} as inactive (parent daemon ${meta.pid} is dead)`);
          }
        }
      }
    }
    eventBus.saveBusData();
  } catch (err) {
    log(`Failed to cleanup orphan agents: ${err.message}`);
  }

  const config = loadConfig(projectRoot);
  const autoResume = config.autoResume !== false;
  const shouldResume = resumeMode === "force" || (resumeMode === "auto" && autoResume);
  if (shouldResume) {
    setTimeout(() => {
      resumeAgents(projectRoot, "", processManager).catch((err) => {
        log(`auto resume failed: ${err.message || String(err)}`);
      });
    }, 1500);
  }

  const cleanup = () => {
    log(`Shutting down daemon (managed agents: ${processManager.count()})`);

    // 清理所有子进程
    processManager.cleanup();

    busBridge.stop();
    removeSocket(projectRoot);

    // 释放锁文件
    try {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
      }
      const lockFile = path.join(getUfooPaths(projectRoot).runDir, "daemon.lock");
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
    } catch {
      // ignore cleanup errors
    }
  };

  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
}

function stopDaemon(projectRoot) {
  const pid = readPid(projectRoot);
  if (!pid) {
    removeSocket(projectRoot);
    return false;
  }
  let killed = false;
  try {
    process.kill(pid, "SIGTERM");
    const started = Date.now();
    while (Date.now() - started < 1500) {
      try {
        process.kill(pid, 0);
      } catch {
        killed = true;
        break;
      }
    }
    // Force kill if still alive.
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      killed = true;
    } catch {
      // ignore if already dead
    }
  } catch {
    // ignore kill errors (e.g., already dead)
  }
  try {
    fs.unlinkSync(pidPath(projectRoot));
  } catch {
    // ignore
  }
  removeSocket(projectRoot);

  // 清理锁文件
  try {
    const lockFile = path.join(getUfooPaths(projectRoot).runDir, "daemon.lock");
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
    }
  } catch {
    // ignore
  }

  return killed;
}

module.exports = { startDaemon, stopDaemon, isRunning, socketPath };
