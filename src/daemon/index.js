const fs = require("fs");
const path = require("path");
const net = require("net");
const { runUfooAgent } = require("../agent/ufooAgent");
const { launchAgent, closeAgent } = require("./ops");
const { buildStatus } = require("./status");
const EventBus = require("../bus");
const { generateInstanceId, subscriberToSafeName } = require("../bus/utils");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameSpawnedAgent(projectRoot, agentType, nickname, startIso) {
  if (!nickname) return null;
  const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
  const targetType = agentType === "codex" ? "codex" : "claude-code";
  const deadline = Date.now() + 10000;
  const eventBus = new EventBus(projectRoot);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
      let entries = Object.entries(bus.subscribers || {})
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
      await eventBus.rename(agentId, nickname);
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
  return path.join(projectRoot, ".ufoo", "run", "ufoo.sock");
}

function pidPath(projectRoot) {
  return path.join(projectRoot, ".ufoo", "run", "ufoo-daemon.pid");
}

function logPath(projectRoot) {
  return path.join(projectRoot, ".ufoo", "run", "ufoo-daemon.log");
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
  const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
  try {
    return JSON.parse(fs.readFileSync(busPath, "utf8"));
  } catch {
    return null;
  }
}

function listSubscribers(projectRoot, agentType) {
  const bus = readBus(projectRoot);
  if (!bus) return [];
  return Object.entries(bus.subscribers || {})
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
  const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entries = Object.entries(bus.subscribers || {})
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
      delete bus.subscribers[agentId];
    }
    fs.writeFileSync(busPath, JSON.stringify(bus, null, 2));
    return { existing: null, cleaned: true };
  } catch {
    return { existing: null, cleaned: false };
  }
}

async function handleOps(projectRoot, ops = []) {
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
        const launchResult = await launchAgent(projectRoot, agent, count, nickname);
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

function startBusBridge(projectRoot, onEvent, onStatus) {
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
      const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
      const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
      const meta = bus.subscribers && bus.subscribers[agentId];
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
    const debugFile = path.join(projectRoot, ".ufoo", "run", "bus-join-debug.txt");
    joinInProgress = true;
    (async () => {
      try {
        fs.writeFileSync(debugFile, `Attempting join at ${new Date().toISOString()}\n`, { flag: "a" });
        // Use fixed ID "ufoo-agent" for daemon's bus identity with explicit nickname
        const sub = await eventBus.join("ufoo-agent", "ufoo-agent", "ufoo-agent");
        if (!sub) {
          fs.writeFileSync(debugFile, "Join returned empty subscriber\n", { flag: "a" });
          return;
        }
        state.subscriber = sub;
        const safe = subscriberToSafeName(sub);
        state.queueFile = path.join(projectRoot, ".ufoo", "bus", "queues", safe, "pending.jsonl");
        fs.writeFileSync(debugFile, `Successfully joined as ${sub}\n`, { flag: "a" });
      } catch (err) {
        fs.writeFileSync(debugFile, `Exception: ${err.message || err}\n`, { flag: "a" });
      } finally {
        joinInProgress = false;
      }
    })();
  }

  function poll() {
    ensureSubscriber();
    if (!state.queueFile) return;
    if (!fs.existsSync(state.queueFile)) return;
    let content;
    try {
      content = fs.readFileSync(state.queueFile, "utf8");
    } catch {
      return;
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
          ts: evt.ts,
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
    try {
      fs.truncateSync(state.queueFile, 0);
    } catch {
      // ignore
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
        fs.writeFileSync(path.join(projectRoot, ".ufoo", "run", "bridge-debug.txt"),
          `subscriber: ${state.subscriber || "NULL"}\nqueue: ${state.queueFile || "NULL"}\n`);
      } catch {}
      return state.subscriber;
    },
    stop() {
      clearInterval(interval);
    },
  };
}

function startDaemon({ projectRoot, provider, model }) {
  if (!fs.existsSync(path.join(projectRoot, ".ufoo"))) {
    throw new Error("Missing .ufoo. Run: ufoo init");
  }

  const runDir = path.join(projectRoot, ".ufoo", "run");
  ensureDir(runDir);
  removeSocket(projectRoot);
  writePid(projectRoot);

  const logFile = fs.createWriteStream(logPath(projectRoot), { flags: "a" });
  const log = (msg) => {
    logFile.write(`[daemon] ${new Date().toISOString()} ${msg}\n`);
  };

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

  const busBridge = startBusBridge(projectRoot, (evt) => {
    sendToSockets({ type: "bus", data: evt });
  }, (status) => {
    sendToSockets({ type: "status", data: status });
  });

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
            const opsResults = await handleOps(projectRoot, result.payload.ops || []);
            log(`ok reply=${Boolean(result.payload.reply)} dispatch=${(result.payload.dispatch || []).length} ops=${(result.payload.ops || []).length}`);
            socket.write(
              `${JSON.stringify({
                type: "response",
                data: result.payload,
                opsResults,
              })}\n`,
            );
          }
        }
      }
    });
  });

  server.listen(socketPath(projectRoot));
  log(`Started pid=${process.pid}`);

  process.on("exit", () => {
    busBridge.stop();
    removeSocket(projectRoot);
  });
  process.on("SIGTERM", () => {
    busBridge.stop();
    removeSocket(projectRoot);
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
  return killed;
}

module.exports = { startDaemon, stopDaemon, isRunning, socketPath };
