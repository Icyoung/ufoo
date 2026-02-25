const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { runUfooAgent } = require("../agent/ufooAgent");
const { launchAgent, closeAgent, getRecoverableAgents, resumeAgents } = require("./ops");
const { buildStatus } = require("./status");
const EventBus = require("../bus");
const { AgentProcessManager } = require("./agentProcessManager");
const NicknameManager = require("../bus/nickname");
const { generateInstanceId, subscriberToSafeName } = require("../bus/utils");
const { createDaemonIpcServer } = require("./ipcServer");
const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES, BUS_STATUS_PHASES } = require("../shared/eventContract");
const { getUfooPaths } = require("../ufoo/paths");
const { scheduleProviderSessionProbe, loadProviderSessionCache } = require("./providerSessions");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { createDaemonCronController } = require("./cronOps");
const { runAssistantTask } = require("../assistant/bridge");
const { runPromptWithAssistant } = require("./promptLoop");
const { handlePromptRequest } = require("./promptRequest");
const { recordAgentReport } = require("./reporting");

let providerSessions = null;
let probeHandles = new Map();
let daemonCronController = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBusAgentType(agentType = "") {
  const value = String(agentType || "").trim().toLowerCase();
  if (!value) return "claude-code";
  if (value === "codex") return "codex";
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "ufoo" || value === "ucode" || value === "ufoo-code") return "ufoo-code";
  return value;
}

function normalizeLaunchAgent(agent = "") {
  const value = String(agent || "").trim().toLowerCase();
  if (value === "codex") return "codex";
  if (value === "claude" || value === "claude-code") return "claude";
  if (value === "ufoo" || value === "ucode" || value === "ufoo-code") return "ufoo";
  return "";
}

async function renameSpawnedAgent(projectRoot, agentType, nickname, startIso) {
  if (!nickname) return null;
  const busPath = getUfooPaths(projectRoot).agentsFile;
  const targetType = normalizeBusAgentType(agentType);
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

function checkPid(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return { alive: false, uncertain: false };
  }
  try {
    process.kill(pid, 0);
    return { alive: true, uncertain: false };
  } catch (err) {
    if (err && err.code === "EPERM") {
      return { alive: true, uncertain: true };
    }
    return { alive: false, uncertain: false };
  }
}

function readProcessArgs(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return "";
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res && res.error) {
      if (res.error.code === "EPERM") return "__EPERM__";
      return "";
    }
    if (res && res.status === 0) {
      return String(res.stdout || "").trim();
    }
  } catch {
    // ignore
  }
  return "";
}

function isLikelyDaemonProcess(pid) {
  const args = readProcessArgs(pid);
  if (!args || args === "__EPERM__") return null;
  const text = args.toLowerCase();
  const hasCliPattern = /\bufoo\s+daemon\s+(--start|start)\b/.test(text);
  const hasNodePattern = /\bufoo\.js\s+daemon\s+(--start|start)\b/.test(text);
  if (hasCliPattern || hasNodePattern) return true;
  if (text.includes("/src/daemon/run.js")) return true;
  return false;
}

function looksLikeRunningDaemon(projectRoot, pid) {
  const state = checkPid(pid);
  if (!state.alive) return false;
  const sock = socketPath(projectRoot);
  if (!fs.existsSync(sock)) return false;
  try {
    const stat = fs.statSync(sock);
    if (!stat.isSocket()) return false;
  } catch {
    return false;
  }
  const procMatch = isLikelyDaemonProcess(pid);
  if (procMatch === true) return true;
  if (procMatch === false) return false;
  if (!state.uncertain) return true;
  const recordedPid = readPid(projectRoot);
  return recordedPid === pid && fs.existsSync(sock);
}

function isRunning(projectRoot) {
  const pid = readPid(projectRoot);
  if (!pid) return false;
  if (looksLikeRunningDaemon(projectRoot, pid)) {
    return true;
  }
  try {
    fs.unlinkSync(pidPath(projectRoot));
  } catch {
    // ignore
  }
  removeSocket(projectRoot);
  return false;
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

function resolveSubscriberNickname(projectRoot, subscriberId) {
  if (!subscriberId) return "";
  try {
    const busPath = getUfooPaths(projectRoot).agentsFile;
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    return bus.agents?.[subscriberId]?.nickname || "";
  } catch {
    return "";
  }
}

async function handleOps(projectRoot, ops = [], processManager = null) {
  const results = [];
  for (const op of ops) {
    if (op.action === "launch") {
      const count = op.count || 1;
      const agent = normalizeLaunchAgent(op.agent);
      if (!agent) {
        results.push({
          action: "launch",
          ok: false,
          count,
          error: `unsupported launch agent: ${op.agent || "unknown"}`,
        });
        continue;
      }
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
        if (launchResult.mode === "internal" && launchResult.subscriberIds && launchResult.subscriberIds.length > 0) {
          const probeAgentType = agent === "codex"
            ? "codex"
            : (agent === "claude" ? "claude-code" : "");
          for (const subscriberId of launchResult.subscriberIds) {
            if (!probeAgentType) continue;
            const resolvedNickname = resolveSubscriberNickname(projectRoot, subscriberId) || nickname;
            const probeHandle = scheduleProviderSessionProbe({
              projectRoot,
              subscriberId,
              agentType: probeAgentType,
              nickname: resolvedNickname,
              onResolved: (id, resolved) => {
                if (providerSessions) {
                  providerSessions.set(id, {
                    sessionId: resolved.sessionId,
                    source: resolved.source || "",
                    updated_at: new Date().toISOString(),
                  });
                }
                probeHandles.delete(id);
              },
            });
            if (probeHandle) {
              probeHandles.set(subscriberId, probeHandle);
            }
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
    } else if (op.action === "cron") {
      if (!daemonCronController) {
        results.push({
          action: "cron",
          ok: false,
          error: "cron controller unavailable",
        });
        continue;
      }
      try {
        const result = daemonCronController.handleCronOp(op);
        results.push(result);
      } catch (err) {
        results.push({
          action: "cron",
          ok: false,
          error: err && err.message ? err.message : String(err || "cron failed"),
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
        const agentType = provider === "codex-cli" ? "codex" : (provider === "ucode" ? "ufoo-code" : "claude-code");
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
          onStatus({ phase: BUS_STATUS_PHASES.DONE, text: `${displayName} done`, key: evt.publisher });
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
        onStatus({ phase: BUS_STATUS_PHASES.START, text: `${displayName} processing`, key: target });
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
  let recoveredStaleLock = false;
  try {
    // 尝试独占方式打开锁文件（如果已存在且被锁定则失败）
    lockFd = fs.openSync(lockFile, "wx");
    fs.writeSync(lockFd, `${process.pid}\n`);
  } catch (err) {
    if (err.code === "EEXIST") {
      // 锁文件已存在，检查是否仍有效
      let existingPid = null;
      try {
        const raw = fs.readFileSync(lockFile, "utf8").trim();
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          existingPid = parsed;
        }
      } catch {
        // ignore malformed lock file and treat as stale
      }

      let lockHeld = false;
      if (existingPid) {
        lockHeld = looksLikeRunningDaemon(projectRoot, existingPid);
      }

      if (lockHeld) {
        throw new Error(`Daemon already running with PID ${existingPid}`);
      }

      // 进程已死或锁文件损坏，清理旧锁后重试
      try {
        fs.unlinkSync(lockFile);
        recoveredStaleLock = true;
      } catch (unlinkErr) {
        throw new Error(`Failed to remove stale daemon lock: ${unlinkErr.message}`);
      }
      try {
        lockFd = fs.openSync(lockFile, "wx");
        fs.writeSync(lockFd, `${process.pid}\n`);
      } catch (retryErr) {
        throw new Error(`Failed to acquire daemon lock: ${retryErr.message}`);
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
  providerSessions = loadProviderSessionCache(projectRoot);
  probeHandles = new Map();
  daemonCronController = createDaemonCronController({
    projectRoot,
    dispatch: async ({ taskId, target, message }) => {
      await dispatchMessages(projectRoot, [{ target, message }]);
      log(`cron:${taskId} -> ${target}`);
    },
    log,
  });

  const buildRuntimeStatus = () =>
    buildStatus(projectRoot, {
      cronTasks: daemonCronController ? daemonCronController.listTasks() : [],
    });

  const cleanupInactiveSubscribers = () => {
    try {
      const syncBus = new EventBus(projectRoot);
      syncBus.ensureBus();
      syncBus.loadBusData();
      syncBus.subscriberManager.cleanupInactive();
      syncBus.saveBusData();
    } catch {
      // ignore cleanup errors
    }
  };

  let handleIpcRequest = async () => {};
  const ipcServer = createDaemonIpcServer({
    projectRoot,
    parseJsonLines,
    handleRequest: async (req, socket) => handleIpcRequest(req, socket),
    buildStatus: () => buildRuntimeStatus(),
    cleanupInactive: cleanupInactiveSubscribers,
    log,
  });

  const busBridge = startBusBridge(projectRoot, provider, (evt) => {
    ipcServer.sendToSockets({ type: IPC_RESPONSE_TYPES.BUS, data: evt });
  }, (status) => {
    ipcServer.sendToSockets({ type: IPC_RESPONSE_TYPES.STATUS, data: status });
  }, () => ipcServer.hasClients());

  handleIpcRequest = async (req, socket) => {
    if (!req || typeof req !== "object") return;
    if (req.type === IPC_REQUEST_TYPES.STATUS) {
      cleanupInactiveSubscribers();
      const status = buildRuntimeStatus();
      socket.write(`${JSON.stringify({ type: IPC_RESPONSE_TYPES.STATUS, data: status })}
`);
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.PROMPT) {
      await handlePromptRequest({
        projectRoot,
        req,
        socket,
        provider,
        model,
        processManager,
        runPromptWithAssistant,
        runUfooAgent,
        runAssistantTask,
        dispatchMessages,
        handleOps,
        markPending: (target) => busBridge.markPending(target),
        reportTaskStatus: async (report) => {
          await recordAgentReport({
            projectRoot,
            report,
            onStatus: (status) => {
              ipcServer.sendToSockets({
                type: IPC_RESPONSE_TYPES.STATUS,
                data: status,
              });
            },
            log,
          });
        },
        log,
      });
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.AGENT_REPORT) {
      try {
        const report = req.report && typeof req.report === "object" ? req.report : {};
        const { entry } = await recordAgentReport({
          projectRoot,
          report: {
            ...report,
            source: report.source || "cli",
          },
          onStatus: (status) => {
            ipcServer.sendToSockets({
              type: IPC_RESPONSE_TYPES.STATUS,
              data: status,
            });
          },
          log,
        });
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply: `Report received (${entry.phase})`,
              report: entry,
            },
          })}
`,
        );
        ipcServer.sendToSockets({
          type: IPC_RESPONSE_TYPES.STATUS,
          data: buildRuntimeStatus(),
        });
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "agent_report failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.BUS_SEND) {
      // Direct bus send request from chat UI
      const { target, message } = req;
      if (!target || !message) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "bus_send requires target and message",
          })}
`,
        );
        return;
      }
      try {
        const publisher = busBridge.getSubscriber() || "ufoo-agent";
        const eventBus = new EventBus(projectRoot);
        await eventBus.send(target, message, publisher);
        busBridge.markPending(target);
        log(`bus_send target=${target} publisher=${publisher}`);
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.BUS_SEND_OK,
          })}
`,
        );
      } catch (err) {
        log(`bus_send failed: ${err.message}`);
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "bus_send failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.CRON) {
      if (!daemonCronController) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "cron controller unavailable",
          })}
`,
        );
        return;
      }

      try {
        const result = daemonCronController.handleCronOp(req);
        let reply = "";
        if (!result.ok) {
          reply = `Cron failed: ${result.error || "unknown error"}`;
        } else if (result.operation === "list") {
          reply = result.count > 0
            ? `Cron ${result.count} task(s)`
            : "Cron none";
        } else if (result.operation === "stop") {
          if (result.id === "all") {
            reply = `Stopped ${result.stopped || 0} cron task(s)`;
          } else {
            reply = `Stopped cron task ${result.id}`;
          }
        } else if (result.operation === "start" && result.task) {
          if (result.task.mode === "once") {
            reply = `Cron scheduled ${result.task.id} at ${result.task.onceAt || result.task.onceAtMs}`;
          } else {
            reply = `Cron started ${result.task.id}: every ${result.task.interval || result.task.intervalMs}`;
          }
        } else {
          reply = "Cron updated";
        }

        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              cron: result,
              ops: [{ action: "cron", operation: result.operation || String(req.operation || "") }],
            },
          })}
`,
        );
        ipcServer.sendToSockets({
          type: IPC_RESPONSE_TYPES.STATUS,
          data: buildRuntimeStatus(),
        });
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "cron request failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.CLOSE_AGENT) {
      const { agent_id } = req;
      if (!agent_id) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "close_agent requires agent_id",
          })}
`,
        );
        return;
      }
      try {
        const op = { action: "close", agent_id };
        const opsResults = await handleOps(projectRoot, [op], processManager);
        const closeResult = opsResults.find((r) => r.action === "close");
        const ok = closeResult ? closeResult.ok !== false : true;
        const reply = ok
          ? `Closed ${agent_id}`
          : `Close failed: ${closeResult?.error || "unknown error"}`;
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: { reply, dispatch: [], ops: [op] },
            opsResults,
          })}
`,
        );
        cleanupInactiveSubscribers();
        ipcServer.sendToSockets({
          type: IPC_RESPONSE_TYPES.STATUS,
          data: buildRuntimeStatus(),
        });
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "close_agent failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.LAUNCH_AGENT) {
      log(`launch_agent received: agent=${req.agent} count=${req.count}`);
      const { agent, count, nickname } = req;
      const normalizedAgent = normalizeLaunchAgent(agent);
      if (!normalizedAgent) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "launch_agent requires agent=codex|claude|ucode",
          })}
`,
        );
        return;
      }
      const parsedCount = parseInt(count, 10);
      const finalCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1;
      const op = {
        action: "launch",
        agent: normalizedAgent,
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
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              dispatch: [],
              ops: [op],
            },
            opsResults,
          })}
`,
        );
        cleanupInactiveSubscribers();
        ipcServer.sendToSockets({
          type: IPC_RESPONSE_TYPES.STATUS,
          data: buildRuntimeStatus(),
        });
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "launch_agent failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.RESUME_AGENTS) {
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
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              resume: result,
            },
          })}
`,
        );
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "resume_agents failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.LIST_RECOVERABLE_AGENTS) {
      const target = req.target || "";
      try {
        const result = getRecoverableAgents(projectRoot, target);
        const count = result.recoverable.length;
        const reply = count > 0 ? `Found ${count} recoverable agent(s)` : "No recoverable agents";
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              recoverable: result,
            },
          })}
`,
        );
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "list_recoverable_agents failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.REGISTER_AGENT) {
      // Manual agent launch requests daemon to register it
      const { agentType, nickname, parentPid, launchMode, tmuxPane, tty, skipProbe } = req;
      if (!agentType) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "register_agent requires agentType",
          })}
`,
        );
        return;
      }
      try {
        const crypto = require("crypto");
        const requestedReuse = req.reuseSession && typeof req.reuseSession === "object"
          ? req.reuseSession
          : null;
        const reuseSessionId = typeof requestedReuse?.sessionId === "string"
          ? requestedReuse.sessionId.trim()
          : "";
        const reuseSubscriberId = typeof requestedReuse?.subscriberId === "string"
          ? requestedReuse.subscriberId.trim()
          : "";
        const reuseProviderSessionId = typeof requestedReuse?.providerSessionId === "string"
          ? requestedReuse.providerSessionId.trim()
          : "";

        let sessionId = crypto.randomBytes(4).toString("hex");
        let subscriberId = `${agentType}:${sessionId}`;
        if (reuseSessionId && reuseSubscriberId === `${agentType}:${reuseSessionId}`) {
          sessionId = reuseSessionId;
          subscriberId = reuseSubscriberId;
        } else if (reuseSessionId || reuseSubscriberId) {
          log(`register_agent ignored invalid reuseSession for ${agentType}`);
        }

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
          tty: tty || "",
          reuseSessionId,
          reuseProviderSessionId,
        };
        if (skipProbe) joinOptions.skipProbe = true;

        let finalNickname = nickname || "";
        if (finalNickname) {
          const nickCheck = checkAndCleanupNickname(projectRoot, finalNickname);
          if (nickCheck.existing) {
            finalNickname = "";
          }
        }
        await eventBus.join(
          sessionId,
          normalizeBusAgentType(agentType),
          finalNickname,
          joinOptions,
        );
        if (finalNickname) {
          eventBus.rename(subscriberId, finalNickname, "ufoo-agent");
        }
        eventBus.saveBusData();
        const resolvedNickname = resolveSubscriberNickname(projectRoot, subscriberId) || finalNickname || "";

        if (!skipProbe && reuseProviderSessionId) {
          if (providerSessions) {
            providerSessions.set(subscriberId, {
              sessionId: reuseProviderSessionId,
              source: "reuse",
              updated_at: new Date().toISOString(),
            });
          }
        }

        if (!skipProbe) {
          const probeHandle = scheduleProviderSessionProbe({
            projectRoot,
            subscriberId,
            agentType,
            nickname: resolvedNickname,
            onResolved: (id, resolved) => {
              if (providerSessions) {
                providerSessions.set(id, {
                  sessionId: resolved.sessionId,
                  source: resolved.source || "",
                  updated_at: new Date().toISOString(),
                });
              }
              probeHandles.delete(id);
            },
          });
          if (probeHandle) {
            probeHandles.set(subscriberId, probeHandle);
          }
        }
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.REGISTER_OK,
            subscriberId,
            nickname: resolvedNickname,
          })}
`,
        );
      } catch (err) {
        log(`register_agent failed: ${err.message}`);
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "register_agent failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.AGENT_READY) {
      const { subscriberId } = req;
      if (!subscriberId) {
        return;
      }
      log(`agent_ready id=${subscriberId} - triggering probe immediately`);
      const probeHandle = probeHandles.get(subscriberId);
      if (probeHandle && typeof probeHandle.triggerNow === "function") {
        probeHandle.triggerNow().catch((err) => {
          log(`agent_ready probe trigger failed for ${subscriberId}: ${err.message}`);
        });
      } else {
        log(`agent_ready no probe handle found for ${subscriberId}`);
      }
      return;
    }
  };

  ipcServer.listen(socketPath(projectRoot));

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
    const adapterRouter = createTerminalAdapterRouter();
    for (const [subscriberId, meta] of Object.entries(agents)) {
      const launchMode = meta.launch_mode || "";
      const adapter = adapterRouter.getAdapter({ launchMode, agentId: subscriberId });
      if (launchMode && adapter.capabilities.supportsInternalQueueLoop) {
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

  const shouldResume = resumeMode === "force" || (resumeMode === "auto" && recoveredStaleLock);
  if (shouldResume) {
    const reason = resumeMode === "force" ? "forced by caller" : "stale daemon state detected";
    log(`Auto-recover enabled: ${reason}`);
    setTimeout(() => {
      resumeAgents(projectRoot, "", processManager).catch((err) => {
        log(`auto resume failed: ${err.message || String(err)}`);
      });
    }, 1500);
  }

  const cleanup = () => {
    log(`Shutting down daemon (managed agents: ${processManager.count()})`);

    if (daemonCronController) {
      daemonCronController.stopAll();
      daemonCronController = null;
    }

    // 清理所有子进程
    processManager.cleanup();

    ipcServer.stop();
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
