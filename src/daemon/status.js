const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function readBus(projectRoot) {
  const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
  try {
    return JSON.parse(fs.readFileSync(busPath, "utf8"));
  } catch {
    return null;
  }
}

function readDecisions(projectRoot) {
  const DecisionsManager = require("../context/decisions");
  const manager = new DecisionsManager(projectRoot);
  const dir = manager.decisionsDir;
  let open = 0;
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const content = fs.readFileSync(path.join(dir, f), "utf8");
      const match = content.match(/---[\s\S]*?status:\s*([^\n]+)[\s\S]*?---/);
      const status = match ? match[1].trim() : "open";
      if (status === "open") open += 1;
    }
  } catch {
    open = 0;
  }
  return { open };
}

function readUnread(projectRoot) {
  const queuesDir = path.join(projectRoot, ".ufoo", "bus", "queues");
  let total = 0;
  const perSubscriber = {};
  try {
    const dirs = fs.readdirSync(queuesDir);
    for (const d of dirs) {
      const file = path.join(queuesDir, d, "pending.jsonl");
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        total += lines.length;
        perSubscriber[d] = lines.length;
      }
    }
  } catch {
    return { total: 0, perSubscriber: {} };
  }
  return { total, perSubscriber };
}

function isHiddenSubscriber(id, meta) {
  if (!id) return false;
  if (id === "ufoo-agent") return true;
  if (meta && meta.nickname === "ufoo-agent") return true;
  if (meta && meta.agent_type === "ufoo-agent") return true;
  return false;
}

function isPidAlive(pid) {
  if (!pid || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getPidCommand(pid) {
  if (!pid || pid === 0) return "";
  try {
    const res = spawnSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status === 0) {
      return (res.stdout || "").trim();
    }
  } catch {
    // ignore
  }
  return "";
}

function isAgentPidAlive(pid) {
  if (!isPidAlive(pid)) return false;
  const cmd = getPidCommand(pid);
  if (!cmd) return false;
  return /(claude|codex|node)/i.test(cmd);
}

function buildStatus(projectRoot) {
  const bus = readBus(projectRoot);
  const decisions = readDecisions(projectRoot);
  const unread = readUnread(projectRoot);
  const subscribers = bus ? Object.keys(bus.subscribers || {}) : [];

  // 过滤活跃的 subscribers（必须同时满足 status 和 pid 检查）
  const activeEntries = bus
    ? Object.entries(bus.subscribers || {})
        .filter(([, meta]) => {
          // 必须是 active 状态
          if (meta.status !== "active") return false;
          // 如果有 pid，必须进程存活
          if (meta.pid && !isAgentPidAlive(meta.pid)) return false;
          return true;
        })
        .filter(([id, meta]) => !isHiddenSubscriber(id, meta))
        .map(([id, meta]) => ({ id, meta }))
    : [];
  const active = activeEntries.map(({ id }) => id);
  const activeMeta = activeEntries.map(({ id, meta }) => {
    const nickname = meta?.nickname || "";
    const display = nickname ? nickname : id;
    const launch_mode = meta?.launch_mode || "unknown";
    return { id, nickname, display, launch_mode };
  });

  return {
    projectRoot,
    subscribers,
    active,
    active_meta: activeMeta,
    unread,
    decisions,
  };
}

module.exports = { buildStatus };
