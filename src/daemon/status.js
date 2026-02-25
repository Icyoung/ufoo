const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { isMetaActive } = require("../bus/utils");
const { readReportSummary } = require("../report/store");

function readBus(projectRoot) {
  const busPath = getUfooPaths(projectRoot).agentsFile;
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
  const queuesDir = getUfooPaths(projectRoot).busQueuesDir;
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

function normalizeCronTasks(raw = []) {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((task) => ({
    id: String(task && task.id ? task.id : ""),
    mode: String(task && task.mode ? task.mode : ((task && task.onceAtMs) ? "once" : "interval")),
    intervalMs: Number(task && task.intervalMs ? task.intervalMs : 0) || 0,
    interval: String(task && task.interval ? task.interval : ""),
    onceAtMs: Number(task && task.onceAtMs ? task.onceAtMs : 0) || 0,
    onceAt: String(task && task.onceAt ? task.onceAt : ""),
    targets: Array.isArray(task && task.targets) ? task.targets.slice() : [],
    prompt: String(task && task.prompt ? task.prompt : ""),
    summary: String(task && task.summary ? task.summary : ""),
    createdAt: Number(task && task.createdAt ? task.createdAt : 0) || 0,
    lastRunAt: Number(task && task.lastRunAt ? task.lastRunAt : 0) || 0,
    tickCount: Number(task && task.tickCount ? task.tickCount : 0) || 0,
  }));
}

function buildStatus(projectRoot, options = {}) {
  const bus = readBus(projectRoot);
  const decisions = readDecisions(projectRoot);
  const unread = readUnread(projectRoot);
  const reports = readReportSummary(projectRoot);
  const subscribers = bus ? Object.keys(bus.agents || {}) : [];
  const cronTasks = normalizeCronTasks(options.cronTasks || []);

  const activeEntries = bus
    ? Object.entries(bus.agents || {})
        .filter(([, meta]) => isMetaActive(meta))
        .filter(([id, meta]) => !isHiddenSubscriber(id, meta))
        .map(([id, meta]) => ({ id, meta }))
    : [];
  const active = activeEntries.map(({ id }) => id);
  const activeMeta = activeEntries.map(({ id, meta }) => {
    const nickname = meta?.nickname || "";
    const display = nickname ? nickname : id;
    const launch_mode = meta?.launch_mode || "unknown";
    const tmux_pane = meta?.tmux_pane || "";
    const tty = meta?.tty || "";
    return { id, nickname, display, launch_mode, tmux_pane, tty };
  });

  return {
    projectRoot,
    subscribers,
    active,
    active_meta: activeMeta,
    unread,
    decisions,
    reports,
    cron: {
      count: cronTasks.length,
      tasks: cronTasks,
    },
  };
}

module.exports = { buildStatus };
