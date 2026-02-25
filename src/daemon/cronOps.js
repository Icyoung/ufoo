const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const {
  parseIntervalMs,
  formatIntervalMs,
} = require("../chat/cronScheduler");

function splitTargets(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeCronTargets(op = {}) {
  const fromArray = Array.isArray(op.targets)
    ? op.targets.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  if (fromArray.length > 0) return Array.from(new Set(fromArray));

  const merged = [
    op.target,
    op.agent,
    op.to,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(",");

  return Array.from(new Set(splitTargets(merged)));
}

function resolveCronOperation(op = {}) {
  const raw = String(op.operation || op.op || op.command || "").trim().toLowerCase();
  if (raw) return raw;
  if (op.list === true) return "list";
  if (op.stop === true) return "stop";
  if (op.id || op.task_id || op.taskId) return "stop";
  return "start";
}

function resolveCronIntervalMs(op = {}) {
  const numeric = Number(op.interval_ms ?? op.intervalMs);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }

  const everyRaw = String(op.every || op.interval || op.ms || "").trim();
  if (!everyRaw) return 0;
  return parseIntervalMs(everyRaw);
}

function parseCronAtMs(value = "") {
  const text = String(value || "").trim();
  if (!text) return 0;

  if (/^\d+$/.test(text)) {
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return text.length <= 10 ? parsed * 1000 : parsed;
  }

  const normalized = text.replace(/\//g, "-");
  const direct = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (direct) {
    const seconds = direct[3] || "00";
    const parsed = Date.parse(`${direct[1]}T${direct[2]}:${seconds}`);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCronAtMs(value = 0) {
  const ts = Number(value) || 0;
  if (ts <= 0) return "";
  const d = new Date(ts);
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resolveCronOnceAtMs(op = {}) {
  const numeric = Number(
    op.once_at_ms
      ?? op.onceAtMs
      ?? op.at_ms
      ?? op.atMs
      ?? op.run_at_ms
      ?? op.runAtMs
  );
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }

  const combined = (op.date && op.time)
    ? `${String(op.date).trim()} ${String(op.time).trim()}`
    : "";

  const raw = String(
    op.at
      || op.once
      || op.run_at
      || op.runAt
      || op.datetime
      || op.date_time
      || combined
      || ""
  ).trim();

  if (!raw) return 0;
  return parseCronAtMs(raw);
}

function resolveCronPrompt(op = {}) {
  return String(op.prompt || op.message || op.msg || "").trim();
}

function resolveCronTaskId(op = {}) {
  return String(op.id || op.task_id || op.taskId || "").trim();
}

function sanitizeSummaryText(value = "") {
  return String(value || "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeCronTask(task = {}) {
  const id = String(task.id || "");
  const targets = Array.isArray(task.targets) ? task.targets.join("+") : "";
  const promptRaw = sanitizeSummaryText(task.prompt || "");
  const prompt = promptRaw.length > 24 ? `${promptRaw.slice(0, 24)}...` : promptRaw;

  if (Number(task.onceAtMs) > 0) {
    return `${id}@once(${formatCronAtMs(task.onceAtMs)})->${targets}: ${prompt || "(empty)"}`;
  }

  const interval = formatIntervalMs(task.intervalMs || 0);
  return `${id}@${interval}->${targets}: ${prompt || "(empty)"}`;
}

function formatCronTask(task = {}) {
  const onceAtMs = Number(task.onceAtMs) || 0;
  return {
    id: String(task.id || ""),
    mode: onceAtMs > 0 ? "once" : "interval",
    intervalMs: Number(task.intervalMs) || 0,
    interval: Number(task.intervalMs) > 0 ? formatIntervalMs(task.intervalMs) : "",
    onceAtMs,
    onceAt: onceAtMs > 0 ? formatCronAtMs(onceAtMs) : "",
    targets: Array.isArray(task.targets) ? task.targets.slice() : [],
    prompt: String(task.prompt || ""),
    createdAt: Number(task.createdAt) || 0,
    lastRunAt: Number(task.lastRunAt) || 0,
    tickCount: Number(task.tickCount) || 0,
    summary: summarizeCronTask(task),
  };
}

function createDaemonCronController(options = {}) {
  const {
    projectRoot = "",
    dispatch = async () => {},
    log = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = () => Date.now(),
    fsModule = fs,
    pathModule = path,
    getUfooPathsImpl = getUfooPaths,
    storageFile = "",
  } = options;

  let seq = 0;
  const tasks = [];

  const persistedFile = storageFile
    || (projectRoot ? pathModule.join(getUfooPathsImpl(projectRoot).runDir, "cron.tasks.json") : "");

  function nextTaskId() {
    seq += 1;
    return `c${seq}`;
  }

  function persistState() {
    if (!persistedFile) return;
    const state = {
      version: 1,
      seq,
      tasks: tasks.map((task) => ({
        id: task.id,
        intervalMs: task.intervalMs,
        onceAtMs: task.onceAtMs,
        targets: task.targets.slice(),
        prompt: task.prompt,
        createdAt: task.createdAt,
        lastRunAt: task.lastRunAt,
        tickCount: task.tickCount,
      })),
    };

    try {
      fsModule.mkdirSync(pathModule.dirname(persistedFile), { recursive: true });
      const tmpFile = `${persistedFile}.tmp`;
      fsModule.writeFileSync(tmpFile, JSON.stringify(state, null, 2), "utf8");
      fsModule.renameSync(tmpFile, persistedFile);
    } catch (err) {
      const detail = err && err.message ? err.message : String(err || "persist failed");
      log(`cron persist failed: ${detail}`);
    }
  }

  function clearTaskTimer(task) {
    if (!task || !task.timer) return;
    if (task.onceAtMs > 0) {
      clearTimeoutFn(task.timer);
    } else {
      clearIntervalFn(task.timer);
    }
    task.timer = null;
  }

  function runTask(task) {
    task.lastRunAt = nowFn();
    task.tickCount += 1;

    for (const target of task.targets) {
      try {
        Promise.resolve(dispatch({
          taskId: task.id,
          target,
          message: task.prompt,
        })).catch((err) => {
          const detail = err && err.message ? err.message : String(err || "dispatch failed");
          log(`cron dispatch failed task=${task.id} target=${target}: ${detail}`);
        });
      } catch (err) {
        const detail = err && err.message ? err.message : String(err || "dispatch failed");
        log(`cron dispatch failed task=${task.id} target=${target}: ${detail}`);
      }
    }
  }

  function stopTask(taskId = "") {
    const id = String(taskId || "").trim();
    if (!id) return false;
    const idx = tasks.findIndex((task) => task.id === id);
    if (idx < 0) return false;

    const task = tasks[idx];
    clearTaskTimer(task);
    tasks.splice(idx, 1);
    persistState();
    return true;
  }

  function attachTaskTimer(task) {
    if (task.onceAtMs > 0) {
      const delay = Math.max(0, task.onceAtMs - nowFn());
      task.timer = setTimeoutFn(() => {
        runTask(task);
        stopTask(task.id);
      }, delay);
      return;
    }

    task.timer = setIntervalFn(() => {
      runTask(task);
      persistState();
    }, task.intervalMs);
  }

  function addTask({ intervalMs = 0, onceAtMs = 0, targets = [], prompt = "" } = {}) {
    const safeInterval = Number.parseInt(intervalMs, 10);
    const safeOnceAt = Number.parseInt(onceAtMs, 10);
    const safeTargets = Array.isArray(targets)
      ? targets.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const safePrompt = String(prompt || "").trim();

    if (!safePrompt || safeTargets.length === 0) return null;

    const useOnce = Number.isFinite(safeOnceAt) && safeOnceAt > 0;
    if (!useOnce) {
      if (!Number.isFinite(safeInterval) || safeInterval < 1000) return null;
    }

    const task = {
      id: nextTaskId(),
      intervalMs: useOnce ? 0 : safeInterval,
      onceAtMs: useOnce ? safeOnceAt : 0,
      targets: Array.from(new Set(safeTargets)),
      prompt: safePrompt,
      createdAt: nowFn(),
      lastRunAt: 0,
      tickCount: 0,
      timer: null,
    };

    attachTaskTimer(task);
    tasks.push(task);
    persistState();

    return formatCronTask(task);
  }

  function listTasks() {
    return tasks.map((task) => formatCronTask(task));
  }

  function stopAll() {
    if (tasks.length === 0) return 0;
    const count = tasks.length;
    while (tasks.length > 0) {
      const task = tasks.pop();
      clearTaskTimer(task);
    }
    persistState();
    return count;
  }

  function recoverPersistedTasks() {
    if (!persistedFile) return;
    if (!fsModule.existsSync(persistedFile)) return;

    let payload = null;
    try {
      payload = JSON.parse(fsModule.readFileSync(persistedFile, "utf8"));
    } catch (err) {
      const detail = err && err.message ? err.message : String(err || "read failed");
      log(`cron load failed: ${detail}`);
      return;
    }

    const persistedSeq = Number(payload && payload.seq);
    if (Number.isFinite(persistedSeq) && persistedSeq > 0) {
      seq = Math.floor(persistedSeq);
    }

    const rawTasks = Array.isArray(payload && payload.tasks) ? payload.tasks : [];
    if (rawTasks.length === 0) {
      persistState();
      return;
    }

    const now = nowFn();
    let changed = false;

    for (const item of rawTasks) {
      const rawId = String(item && item.id ? item.id : "").trim();
      const parsedId = rawId.match(/^c(\d+)$/i);
      if (parsedId) {
        const numericId = Number.parseInt(parsedId[1], 10);
        if (Number.isFinite(numericId) && numericId > seq) {
          seq = numericId;
        }
      }

      const intervalMs = Number(item && item.intervalMs);
      const onceAtMs = Number(item && item.onceAtMs);
      const targets = Array.isArray(item && item.targets)
        ? item.targets.map((v) => String(v || "").trim()).filter(Boolean)
        : [];
      const prompt = String(item && item.prompt ? item.prompt : "").trim();

      if (!prompt || targets.length === 0) {
        changed = true;
        continue;
      }

      if (Number.isFinite(onceAtMs) && onceAtMs > 0) {
        if (onceAtMs <= now) {
          changed = true;
          continue;
        }
      } else if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
        changed = true;
        continue;
      }

      const task = {
        id: rawId || nextTaskId(),
        intervalMs: Number.isFinite(intervalMs) ? Math.floor(intervalMs) : 0,
        onceAtMs: Number.isFinite(onceAtMs) ? Math.floor(onceAtMs) : 0,
        targets: Array.from(new Set(targets)),
        prompt,
        createdAt: Number(item && item.createdAt) || now,
        lastRunAt: Number(item && item.lastRunAt) || 0,
        tickCount: Number(item && item.tickCount) || 0,
        timer: null,
      };

      attachTaskTimer(task);
      tasks.push(task);
    }

    if (changed) {
      persistState();
    }
  }

  recoverPersistedTasks();

  function handleCronOp(op = {}) {
    const operation = resolveCronOperation(op);

    if (operation === "list" || operation === "ls") {
      const listed = listTasks();
      return {
        action: "cron",
        operation: "list",
        ok: true,
        count: listed.length,
        tasks: listed,
      };
    }

    if (operation === "stop" || operation === "rm" || operation === "remove") {
      const id = resolveCronTaskId(op);
      if (!id) {
        return {
          action: "cron",
          operation: "stop",
          ok: false,
          error: "cron stop requires id or all",
        };
      }

      if (id === "all") {
        const stopped = stopAll();
        return {
          action: "cron",
          operation: "stop",
          ok: true,
          id: "all",
          stopped,
        };
      }

      const ok = stopTask(id);
      if (!ok) {
        return {
          action: "cron",
          operation: "stop",
          ok: false,
          id,
          error: `cron task not found: ${id}`,
        };
      }

      return {
        action: "cron",
        operation: "stop",
        ok: true,
        id,
        stopped: 1,
      };
    }

    if (operation !== "start" && operation !== "add" && operation !== "create") {
      return {
        action: "cron",
        operation,
        ok: false,
        error: `unsupported cron operation: ${operation}`,
      };
    }

    const intervalMs = resolveCronIntervalMs(op);
    const onceAtMs = resolveCronOnceAtMs(op);

    if (intervalMs > 0 && onceAtMs > 0) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "cron start accepts either every or at/once, not both",
      };
    }

    if (onceAtMs > 0 && onceAtMs <= nowFn()) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "one-time cron time must be in the future",
      };
    }

    if (intervalMs <= 0 && onceAtMs <= 0) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "cron start requires every or at/once",
      };
    }

    if (intervalMs > 0 && intervalMs < 1000) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "invalid cron interval (min 1s)",
      };
    }

    const targets = normalizeCronTargets(op);
    if (targets.length === 0) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "cron start requires at least one target",
      };
    }

    const prompt = resolveCronPrompt(op);
    if (!prompt) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "cron start requires prompt",
      };
    }

    const task = addTask({
      intervalMs,
      onceAtMs,
      targets,
      prompt,
    });

    if (!task) {
      return {
        action: "cron",
        operation: "start",
        ok: false,
        error: "failed to create cron task",
      };
    }

    return {
      action: "cron",
      operation: "start",
      ok: true,
      task,
    };
  }

  return {
    handleCronOp,
    listTasks,
    stopAll,
  };
}

module.exports = {
  createDaemonCronController,
  normalizeCronTargets,
  resolveCronOperation,
  resolveCronIntervalMs,
  resolveCronOnceAtMs,
  resolveCronPrompt,
  resolveCronTaskId,
  parseCronAtMs,
  formatCronTask,
};
