const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
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
const { upsertProjectRuntime, markProjectStopped } = require("../projects/registry");
const { scheduleProviderSessionProbe, resolveSessionFromFile, persistProviderSession, loadProviderSessionCache } = require("./providerSessions");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { createDaemonCronController } = require("./cronOps");
const { createGroupOrchestrator } = require("./groupOrchestrator");
const { normalizeFormat, renderGroupDiagramFromTemplate, renderGroupDiagramFromRuntime } = require("../group/diagram");
const { runAssistantTask } = require("../assistant/bridge");
const { runPromptWithAssistant } = require("./promptLoop");
const { handlePromptRequest } = require("./promptRequest");
const { recordAgentReport } = require("./reporting");
const { isGlobalControllerProjectRoot } = require("../globalMode");
const {
  assignSoloRoleToExistingAgent,
  resolveSoloPromptProfile,
  buildSoloBootstrap,
  prepareSoloUcodeBootstrap,
  persistSoloRoleMetadata,
  buildSoloBootstrapFingerprint,
  rollbackLaunchAfterRoleAssignmentFailure,
} = require("./soloBootstrap");
const { applyProjectNicknamePrefix } = require("./nicknameScope");

let providerSessions = null;
let probeHandles = new Map();
let daemonCronController = null;
let daemonGroupOrchestrator = null;
const PROJECT_RUNTIME_HEARTBEAT_MS = 10 * 1000;

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

function pickLaunchSubscriber(projectRoot, launchResult = {}, fallbackTarget = "") {
  if (launchResult && Array.isArray(launchResult.subscriber_ids) && launchResult.subscriber_ids.length > 0) {
    return String(launchResult.subscriber_ids[0] || "").trim();
  }
  if (launchResult && launchResult.agent_id) {
    return String(launchResult.agent_id || "").trim();
  }
  return String(fallbackTarget || "").trim();
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

function connectProjectSocket(sockPath, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let timeoutHandle = null;
    const client = net.createConnection(sockPath, () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      resolve(client);
    });
    client.on("error", (err) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      reject(err);
    });
    timeoutHandle = setTimeout(() => {
      const err = new Error(`connect timeout after ${timeoutMs}ms`);
      err.code = "ETIMEDOUT";
      try {
        client.destroy(err);
      } catch {
        // ignore
      }
      reject(err);
    }, timeoutMs);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  });
}

async function connectProjectSocketWithRetry(sockPath, retries = 25, delayMs = 200, timeoutMs = 8000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await connectProjectSocket(sockPath, timeoutMs);
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }
  return null;
}

async function sendPromptRequestToProject(targetProjectRoot, payload, timeoutMs = 12000) {
  const sock = socketPath(targetProjectRoot);
  const client = await connectProjectSocketWithRetry(sock, 25, 200, 8000);
  if (!client) {
    return { ok: false, error: "Failed to connect target project daemon" };
  }

  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve({ ok: false, error: "Target project daemon request timeout" });
    }, timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      client.removeAllListeners();
      try {
        client.end();
      } catch {
        // ignore
      }
    };

    client.on("data", (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === IPC_RESPONSE_TYPES.RESPONSE) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            ok: true,
            payload: msg.data || {},
            opsResults: msg.opsResults || [],
          });
          return;
        }
        if (msg.type === IPC_RESPONSE_TYPES.ERROR) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({
            ok: false,
            error: msg.error || "Target project daemon error",
          });
          return;
        }
      }
    });

    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, error: err && err.message ? err.message : "Target project daemon error" });
    });

    client.write(`${JSON.stringify(payload)}\n`);
  });
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

function checkAndCleanupNickname(projectRoot, nickname, { tty = "", agentType = "" } = {}) {
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
      const [existingId, existingMeta] = activeAgent;
      // Allow takeover when the existing holder is a pre-registered stub
      // (same agent type, no TTY) or occupies the same TTY — the new
      // registration is the real agent replacing the placeholder.
      const sameType = agentType && existingMeta.agent_type === agentType;
      // A stub is a pre-registered entry with no TTY AND no meaningful activity
      // state. Internal-mode agents also lack a TTY but will have activity_state
      // set once they start working — don't evict those.
      const isStub = sameType && !existingMeta.tty && !existingMeta.activity_state;
      const sameTty = tty && existingMeta.tty === tty;
      if (isStub || sameTty) {
        delete bus.agents[existingId];
        fs.writeFileSync(busPath, JSON.stringify(bus, null, 2));
        return { existing: null, cleaned: true };
      }
      return { existing: existingId, cleaned: false };
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
      const requestedNickname = String(op.nickname || "").trim();
      const nickname = applyProjectNicknamePrefix(projectRoot, requestedNickname, { agentType: agent });
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
            cleaned: Boolean(cleaned),
            message: `Agent '${nickname}' already exists`,
          });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const launchResult = await launchAgent(projectRoot, agent, count, nickname, processManager, {
          launchScope: op.launch_scope || "",
          terminalApp: op.terminal_app || "",
          tmuxLayoutContext:
            op.tmux_layout_context && typeof op.tmux_layout_context === "object"
              ? op.tmux_layout_context
              : ((op.tmuxLayoutContext && typeof op.tmuxLayoutContext === "object")
                ? op.tmuxLayoutContext
                : null),
          extraEnv:
            op.extra_env && typeof op.extra_env === "object"
              ? op.extra_env
              : ((op.extraEnv && typeof op.extraEnv === "object") ? op.extraEnv : null),
          extraArgs:
            Array.isArray(op.extra_args) ? op.extra_args
              : (Array.isArray(op.extraArgs) ? op.extraArgs : []),
          hostInjectSock: op.host_inject_sock || op.hostInjectSock || "",
          hostDaemonSock: op.host_daemon_sock || op.hostDaemonSock || "",
          hostName: op.host_name || op.hostName || "",
          hostSessionId: op.host_session_id || op.hostSessionId || "",
          hostCapabilities:
            (op.host_capabilities && typeof op.host_capabilities === "object")
            ? op.host_capabilities
            : ((op.hostCapabilities && typeof op.hostCapabilities === "object")
              ? op.hostCapabilities
              : null),
          requireActivityMonitor:
            op.require_activity_monitor === true || op.requireActivityMonitor === true,
        });
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
              agentCwd: projectRoot,
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
          nickname: nickname || undefined,
          launch_scope: launchResult.launchScope || undefined,
          subscriber_ids: Array.isArray(launchResult.subscriberIds) ? launchResult.subscriberIds.slice() : [],
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
      const closeResult = await closeAgent(projectRoot, op.agent_id);
      const normalizedClose = closeResult && typeof closeResult === "object"
        ? closeResult
        : { ok: Boolean(closeResult) };
      results.push({
        action: "close",
        agent_id: op.agent_id,
        ...normalizedClose,
      });
    } else if (op.action === "rename") {
      const agentId = op.agent_id || "";
      const requestedNickname = String(op.nickname || "").trim();
      let nickname = "";
      if (!agentId || !requestedNickname) {
        results.push({
          action: "rename",
          ok: false,
          agent_id: agentId,
          nickname: requestedNickname,
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
          if (!resolved) {
            const scopedTarget = applyProjectNicknamePrefix(projectRoot, agentId);
            if (scopedTarget && scopedTarget !== agentId) {
              const scopedResolved = nicknameManager.resolveNickname(scopedTarget);
              if (scopedResolved) targetId = scopedResolved;
            }
          }
        }
        if (!eventBus.busData?.agents?.[targetId]) {
          results.push({
            action: "rename",
            ok: false,
            agent_id: agentId,
            nickname: requestedNickname,
            error: `agent not found: ${agentId}`,
          });
          continue;
        }
        const targetMeta = eventBus.busData.agents[targetId] || {};
        nickname = applyProjectNicknamePrefix(projectRoot, requestedNickname, {
          agentType: targetMeta.agent_type || "",
        });
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
          nickname: nickname || requestedNickname,
          error: err && err.message ? err.message : String(err || "rename failed"),
        });
      }
    } else if (op.action === "role") {
      const roleTarget = String(op.target || op.agent_id || "").trim();
      const roleProfile = String(op.prompt_profile || op.profile || "").trim();
      if (!roleTarget || !roleProfile) {
        results.push({
          action: "role",
          ok: false,
          error: "role requires target and prompt_profile",
        });
        continue;
      }
      try {
        const roleResult = await assignSoloRoleToExistingAgent(projectRoot, roleTarget, roleProfile, {
          bootstrapOptions: {
            timeoutMs: 15000,
            retryDelayMs: 250,
            protectionMs: 3000,
            workingGraceMs: 10000,
          },
        });
        results.push({
          action: "role",
          ok: roleResult.ok !== false,
          target: roleTarget,
          prompt_profile: roleProfile,
          resolved_profile: roleResult.resolved_profile || "",
          skipped: roleResult.skipped || false,
          error: roleResult.error || "",
        });
      } catch (err) {
        results.push({
          action: "role",
          ok: false,
          target: roleTarget,
          prompt_profile: roleProfile,
          error: err && err.message ? err.message : String(err || "role assignment failed"),
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
    const sendOptions = {
      injectionMode: item.injection_mode,
      source: item.source,
    };
    try {
      if (item.target === "broadcast") {
        await eventBus.broadcast(item.message, pub, sendOptions);
      } else {
        await eventBus.send(item.target, item.message, pub, sendOptions);
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
  const publishProjectRuntime = (status = "running") => {
    if (isGlobalControllerProjectRoot(projectRoot)) {
      return;
    }
    try {
      upsertProjectRuntime({
        projectRoot,
        daemonPid: process.pid,
        socketPath: socketPath(projectRoot),
        status,
        lastSeen: new Date().toISOString(),
      });
    } catch (err) {
      log(`project runtime update failed (${status}): ${err.message || err}`);
    }
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
  daemonGroupOrchestrator = createGroupOrchestrator({
    projectRoot,
    handleOps,
    processManager,
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
        forwardProjectPrompt: async ({
          targetProjectRoot,
          targetProjectName,
          prompt,
          routeReason,
          requestMeta = {},
        }) => {
          const root = String(targetProjectRoot || "").trim();
          if (!root) {
            return { ok: false, error: "target project root is required" };
          }
          if (!fs.existsSync(root)) {
            return { ok: false, error: `target project not found: ${root}` };
          }
          const targetPaths = getUfooPaths(root);
          if (!fs.existsSync(targetPaths.ufooDir)) {
            const repoRoot = path.join(__dirname, "..", "..");
            const init = new (require("../init"))(repoRoot);
            await init.init({ modules: "context,bus", project: root });
          }
          if (!isRunning(root)) {
            const daemonBin = path.join(__dirname, "..", "..", "bin", "ufoo.js");
            const child = spawn(process.execPath, [daemonBin, "daemon", "--start"], {
              detached: true,
              stdio: "ignore",
              cwd: root,
              env: process.env,
            });
            child.unref();
          }

          const nextMeta = {
            ...(requestMeta && typeof requestMeta === "object" ? requestMeta : {}),
            via_global_router: true,
            global_controller_project_root: projectRoot,
            routed_project_root: root,
            routed_project_name: targetProjectName || path.basename(root),
            routed_reason: routeReason || "",
          };
          delete nextMeta.force_project_root;
          delete nextMeta.force_project_name;

          return sendPromptRequestToProject(root, {
            type: IPC_REQUEST_TYPES.PROMPT,
            text: String(prompt || ""),
            request_meta: nextMeta,
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
          type: IPC_RESPONSE_TYPES.BUS,
          data: {
            event: "controller_report",
            publisher: entry.agent_id,
            message: entry.summary || entry.message || entry.task_id,
            report: entry,
          },
        });
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
      const { target, message, injection_mode, source } = req;
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
        await eventBus.send(target, message, publisher, {
          injectionMode: injection_mode,
          source,
        });
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
            reply = `Cron scheduled ${result.task.id}: ${result.task.label || result.task.onceAt || result.task.onceAtMs}`;
          } else {
            reply = `Cron started ${result.task.id}: ${result.task.label || result.task.interval || result.task.intervalMs}`;
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
          ? (closeResult && closeResult.already_stopped
            ? `Closed ${agent_id} (already stopped)`
            : `Closed ${agent_id}`)
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
      const {
        agent,
        count,
        nickname,
        prompt_profile,
        launch_scope,
        terminal_app,
        host_inject_sock,
        host_daemon_sock,
        host_name,
        host_session_id,
        host_capabilities,
      } = req;
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
      const requestedProfile = String(prompt_profile || "").trim();
      const explicitNickname = applyProjectNicknamePrefix(projectRoot, String(nickname || "").trim(), {
        agentType: normalizedAgent,
      });
      if (requestedProfile && finalCount > 1) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "prompt_profile requires count=1",
          })}
`,
        );
        return;
      }
      const op = {
        action: "launch",
        agent: normalizedAgent,
        count: finalCount,
        nickname: explicitNickname,
        launch_scope: launch_scope || "",
        terminal_app: terminal_app || "",
        host_inject_sock: host_inject_sock || "",
        host_daemon_sock: host_daemon_sock || "",
        host_name: host_name || "",
        host_session_id: host_session_id || "",
        host_capabilities:
          host_capabilities && typeof host_capabilities === "object"
            ? host_capabilities
            : null,
      };
      let soloLaunchBootstrap = null;
      if (requestedProfile && normalizedAgent === "ufoo") {
        const soloNickname = explicitNickname || "ucode";
        const profileResult = resolveSoloPromptProfile(projectRoot, requestedProfile);
        if (!profileResult.ok) {
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.ERROR,
              error: profileResult.error || "prompt profile resolution failed",
            })}
`,
          );
          return;
        }
        const built = buildSoloBootstrap({
          nickname: soloNickname,
          agentType: "ufoo-code",
          requestedProfile: profileResult.requested_profile,
          profile: profileResult.profile,
        });
        if (built.required) {
          try {
            const prepared = prepareSoloUcodeBootstrap(projectRoot, soloNickname, built.promptText);
            op.extra_env = {
              ...(op.extra_env && typeof op.extra_env === "object" ? op.extra_env : {}),
              UFOO_UCODE_BOOTSTRAP_FILE: prepared.file,
            };
            soloLaunchBootstrap = {
              requested_profile: profileResult.requested_profile,
              resolved_profile: profileResult.profile.id,
              promptText: built.promptText,
            };
          } catch (err) {
            socket.write(
              `${JSON.stringify({
                type: IPC_RESPONSE_TYPES.ERROR,
                error: err.message || "failed to prepare ucode bootstrap",
              })}
`,
            );
            return;
          }
        }
      }
      try {
        const opsResults = await handleOps(projectRoot, [op], processManager);
        const launchResult = opsResults.find((r) => r.action === "launch");
        if (soloLaunchBootstrap && launchResult && launchResult.ok !== false) {
          const subscriberId = pickLaunchSubscriber(projectRoot, launchResult, explicitNickname || "");
          if (subscriberId) {
            persistSoloRoleMetadata(projectRoot, subscriberId, {
              requested_profile: soloLaunchBootstrap.requested_profile,
              resolved_profile: soloLaunchBootstrap.resolved_profile,
              bootstrap_fingerprint: buildSoloBootstrapFingerprint({
                subscriberId,
                requestedProfile: soloLaunchBootstrap.requested_profile,
                resolvedProfile: soloLaunchBootstrap.resolved_profile,
                promptText: soloLaunchBootstrap.promptText,
              }),
              bootstrapped_subscriber_id: subscriberId,
            });
          }
        } else if (requestedProfile && launchResult && launchResult.ok !== false) {
          const roleTarget = pickLaunchSubscriber(projectRoot, launchResult, explicitNickname || "");
          const roleResult = await assignSoloRoleToExistingAgent(projectRoot, roleTarget, requestedProfile, {
            bootstrapOptions: {
              timeoutMs: 15000,
              retryDelayMs: 250,
              protectionMs: 3000,
              workingGraceMs: 10000,
            },
          });
          if (!roleResult.ok) {
            const rollback = await rollbackLaunchAfterRoleAssignmentFailure(
              projectRoot,
              launchResult,
              roleTarget,
              handleOps,
              processManager
            );
            const roleError = roleResult.error || "role assignment failed";
            const error = rollback.skipped
              ? roleError
              : (rollback.ok
                ? `${roleError}; launched agent rolled back: ${rollback.target}`
                : `${roleError}; rollback failed for ${rollback.target || "unknown"}: ${rollback.error || "close failed"}`);
            socket.write(
              `${JSON.stringify({
                type: IPC_RESPONSE_TYPES.ERROR,
                error,
              })}
`,
            );
            return;
          }
        }
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
    if (req.type === IPC_REQUEST_TYPES.ASSIGN_ROLE) {
      const target = String(req.target || "").trim();
      const promptProfile = String(req.prompt_profile || req.profile || "").trim();
      if (!target || !promptProfile) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "assign_role requires target and prompt_profile",
          })}
`,
        );
        return;
      }
      try {
        const result = await assignSoloRoleToExistingAgent(projectRoot, target, promptProfile, {
          bootstrapOptions: {
            timeoutMs: 15000,
            retryDelayMs: 250,
            protectionMs: 3000,
            workingGraceMs: 10000,
          },
        });
        if (!result.ok) {
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.ERROR,
              error: result.error || "role assignment failed",
            })}
`,
          );
          return;
        }
        const reply = result.skipped
          ? `Role already applied: ${result.resolved_profile}`
          : `Assigned role ${result.resolved_profile} to ${result.subscriber_id}`;
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              role: result,
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
            error: err.message || "assign_role failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.LAUNCH_GROUP) {
      if (!daemonGroupOrchestrator) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "group orchestrator unavailable",
          })}
`,
        );
        return;
      }
      const alias = req.alias || req.template || "";
      const instance = req.instance || req.group_id || "";
      const dryRun = req.dry_run === true || req.dryRun === true;
      const hostInjectSock = req.host_inject_sock || req.hostInjectSock || "";
      const hostDaemonSock = req.host_daemon_sock || req.hostDaemonSock || "";
      const hostName = req.host_name || req.hostName || "";
      const hostSessionId = req.host_session_id || req.hostSessionId || "";
      const hostCapabilities =
        req.host_capabilities && typeof req.host_capabilities === "object"
          ? req.host_capabilities
          : ((req.hostCapabilities && typeof req.hostCapabilities === "object")
            ? req.hostCapabilities
            : null);
      try {
        const result = await daemonGroupOrchestrator.runGroup({
          alias,
          instance,
          dry_run: dryRun,
          host_inject_sock: hostInjectSock,
          host_daemon_sock: hostDaemonSock,
          host_name: hostName,
          host_session_id: hostSessionId,
          host_capabilities: hostCapabilities,
        });
        const ok = result && result.ok !== false;
        let reply = "";
        if (!ok) {
          reply = `Group run failed: ${result?.error || "unknown error"}`;
        } else if (result.dry_run) {
          reply = `Group dry-run ${result.group_id}: ${Array.isArray(result.members) ? result.members.length : 0} member(s)`;
        } else {
          reply = `Group started ${result.group_id}`;
        }
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              group: result,
            },
          })}
`,
        );
        if (!dryRun) {
          cleanupInactiveSubscribers();
          ipcServer.sendToSockets({
            type: IPC_RESPONSE_TYPES.STATUS,
            data: buildRuntimeStatus(),
          });
        }
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "launch_group failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.STOP_GROUP) {
      if (!daemonGroupOrchestrator) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "group orchestrator unavailable",
          })}
`,
        );
        return;
      }
      const groupId = req.group_id || req.groupId || req.instance || "";
      try {
        const result = await daemonGroupOrchestrator.stopGroup({ group_id: groupId });
        const ok = result && result.ok !== false;
        const reply = ok
          ? `Stopped group ${result.group_id}`
          : `Group stop failed: ${result?.error || "unknown error"}`;
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              group: result,
            },
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
            error: err.message || "stop_group failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.GROUP_STATUS) {
      if (!daemonGroupOrchestrator) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "group orchestrator unavailable",
          })}
`,
        );
        return;
      }
      const groupId = req.group_id || req.groupId || req.instance || "";
      try {
        const result = daemonGroupOrchestrator.getStatus({ group_id: groupId });
        const ok = result && result.ok !== false;
        const reply = ok
          ? (groupId
            ? `Group ${groupId}: ${result.group?.status || "unknown"}`
            : `Group instances: ${result.count || 0}`)
          : `Group status failed: ${result?.error || "unknown error"}`;
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              group: result,
            },
          })}
`,
        );
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "group_status failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.GROUP_TEMPLATE_VALIDATE) {
      if (!daemonGroupOrchestrator) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "group orchestrator unavailable",
          })}
`,
        );
        return;
      }
      const target = req.alias || req.path || req.target || "";
      try {
        const result = daemonGroupOrchestrator.validateTemplateTarget(target);
        const reply = result.ok
          ? `Template valid: ${result.entry?.alias || target}`
          : `Template invalid: ${result.error || "unknown error"}`;
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply,
              group: {
                ok: result.ok,
                target,
                alias: result.entry?.alias || "",
                source: result.entry?.source || "",
                filePath: result.entry?.filePath || "",
                errors: result.errors || [],
                prompt_profiles: result.promptProfiles || [],
              },
            },
          })}
`,
        );
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "group_template_validate failed",
          })}
`,
        );
      }
      return;
    }
    if (req.type === IPC_REQUEST_TYPES.GROUP_DIAGRAM) {
      if (!daemonGroupOrchestrator) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "group orchestrator unavailable",
          })}
`,
        );
        return;
      }
      const target = req.group_id || req.groupId || req.instance || req.alias || req.target || "";
      if (!target) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: "group diagram requires alias|group_id",
          })}
`,
        );
        return;
      }
      const format = normalizeFormat(req.format || (req.mermaid ? "mermaid" : "ascii"));
      try {
        const runtimeState = daemonGroupOrchestrator.getStatus({ group_id: target });
        if (runtimeState && runtimeState.ok === false && runtimeState.error === "invalid group_id") {
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.RESPONSE,
              data: {
                reply: "Group diagram failed: invalid group_id",
                group: {
                  ok: false,
                  mode: "runtime",
                  target,
                  format,
                  error: "invalid group_id",
                },
              },
            })}
`,
          );
          return;
        }
        if (runtimeState && runtimeState.ok && runtimeState.group) {
          const diagram = renderGroupDiagramFromRuntime(runtimeState.group, { format });
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.RESPONSE,
              data: {
                reply: `Group diagram (${format}) for runtime ${target}`,
                group: {
                  ok: true,
                  mode: "runtime",
                  target,
                  format,
                  diagram,
                  group_id: runtimeState.group.group_id || target,
                  status: runtimeState.group.status || "",
                },
              },
            })}
`,
          );
          return;
        }

        const templateState = daemonGroupOrchestrator.validateTemplateTarget(target, { allowPath: false });
        if (!templateState || !templateState.ok || !templateState.entry) {
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.RESPONSE,
              data: {
                reply: `Group diagram failed: ${templateState?.error || "template not found"}`,
                group: {
                  ok: false,
                  mode: "template",
                  target,
                  format,
                  error: templateState?.error || "template not found",
                  errors: templateState?.errors || [],
                },
              },
            })}
`,
          );
          return;
        }

        const diagram = renderGroupDiagramFromTemplate(templateState.entry.data, { format });
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: {
              reply: `Group diagram (${format}) for template ${templateState.entry.alias || target}`,
              group: {
                ok: true,
                mode: "template",
                target,
                format,
                diagram,
                alias: templateState.entry.alias || "",
                source: templateState.entry.source || "",
                filePath: templateState.entry.filePath || "",
              },
            },
          })}
`,
        );
      } catch (err) {
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error: err.message || "group_diagram failed",
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
      const {
        agentType,
        nickname,
        parentPid,
        launchMode,
        tmuxPane,
        tty,
        hostInjectSock,
        hostDaemonSock,
        hostName,
        hostSessionId,
        hostCapabilities,
        skipProbe,
      } = req;
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
          hostInjectSock: hostInjectSock || "",
          hostDaemonSock: hostDaemonSock || "",
          hostName: hostName || "",
          hostSessionId: hostSessionId || "",
          hostCapabilities: hostCapabilities && typeof hostCapabilities === "object"
            ? hostCapabilities
            : null,
          reuseSessionId,
          reuseProviderSessionId,
        };
        if (skipProbe) joinOptions.skipProbe = true;

        let finalNickname = nickname || "";
        if (finalNickname) {
          const nickCheck = checkAndCleanupNickname(projectRoot, finalNickname, {
            tty: tty || "",
            agentType: normalizeBusAgentType(agentType),
          });
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
            agentCwd: projectRoot,
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
      const { subscriberId, agentPid } = req;
      if (!subscriberId) {
        return;
      }
      log(`agent_ready id=${subscriberId} pid=${agentPid || 0} - resolving session`);

      // Try direct file read first if we have agentPid (fast path)
      const parsedAgentPid = Number.parseInt(agentPid, 10);
      if (Number.isFinite(parsedAgentPid) && parsedAgentPid > 0) {
        const agentType = subscriberId.split(":")[0] || "";
        const resolved = resolveSessionFromFile(agentType, {
          pid: parsedAgentPid,
          cwd: projectRoot,
        });
        if (resolved && resolved.sessionId) {
          log(`agent_ready session resolved from file for ${subscriberId}: ${resolved.sessionId}`);
          persistProviderSession(projectRoot, subscriberId, resolved);
          if (providerSessions) {
            providerSessions.set(subscriberId, {
              sessionId: resolved.sessionId,
              source: resolved.source || "",
              updated_at: new Date().toISOString(),
            });
          }
          // Cancel the scheduled probe to prevent /ufoo injection
          const handle = probeHandles.get(subscriberId);
          if (handle && typeof handle.cancel === "function") {
            handle.cancel();
          }
          probeHandles.delete(subscriberId);
          return;
        }
      }

      // Fallback: trigger scheduled probe
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
  publishProjectRuntime("running");
  const runtimeHeartbeat = setInterval(() => {
    publishProjectRuntime("running");
  }, PROJECT_RUNTIME_HEARTBEAT_MS);

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

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    log(`Shutting down daemon (managed agents: ${processManager.count()})`);
    clearInterval(runtimeHeartbeat);
    try {
      if (!isGlobalControllerProjectRoot(projectRoot)) {
        markProjectStopped(projectRoot);
      }
    } catch {
      // ignore cleanup errors
    }

    if (daemonCronController) {
      daemonCronController.stopAll();
      daemonCronController = null;
    }
    daemonGroupOrchestrator = null;

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

  try {
    if (!isGlobalControllerProjectRoot(projectRoot)) {
      markProjectStopped(projectRoot);
    }
  } catch {
    // ignore
  }

  return killed;
}

module.exports = { startDaemon, stopDaemon, isRunning, socketPath };
