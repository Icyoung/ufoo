const fs = require("fs");
const path = require("path");
const { runToolCall } = require("./dispatch");

function getRuntimePaths(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot || process.cwd());
  const runtimeDir = path.join(root, ".ufoo", "agent", "ucode");
  return {
    projectRoot: root,
    runtimeDir,
    tasksFile: path.join(runtimeDir, "tasks.jsonl"),
    resultsFile: path.join(runtimeDir, "results.jsonl"),
    stateFile: path.join(runtimeDir, "state.json"),
  };
}

function ensureRuntimeDir(projectRoot = process.cwd()) {
  const { runtimeDir } = getRuntimePaths(projectRoot);
  fs.mkdirSync(runtimeDir, { recursive: true });
}

function parseJsonLines(filePath = "") {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return [];
    const rows = [];
    for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // ignore malformed line
      }
    }
    return rows;
  } catch {
    return [];
  }
}

function appendJsonLine(filePath = "", payload = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function loadState(projectRoot = process.cwd()) {
  const { stateFile } = getRuntimePaths(projectRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const offset = Number.isFinite(parsed.offset) ? Math.max(0, Math.floor(parsed.offset)) : 0;
    return { offset };
  } catch {
    return { offset: 0 };
  }
}

function saveState(projectRoot = process.cwd(), state = {}) {
  const { stateFile } = getRuntimePaths(projectRoot);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function createTaskId() {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTask(input = {}) {
  const tool = String(input.tool || input.name || "").trim().toLowerCase();
  const args = input.args && typeof input.args === "object" ? input.args : {};
  return {
    task_id: String(input.task_id || input.taskId || createTaskId()).trim(),
    created_at: new Date().toISOString(),
    tool,
    args,
    workspace_root: String(input.workspace_root || input.workspaceRoot || "").trim(),
    meta: input.meta && typeof input.meta === "object" ? input.meta : {},
  };
}

function submitTask(projectRoot = process.cwd(), input = {}) {
  ensureRuntimeDir(projectRoot);
  const task = normalizeTask(input);
  const { tasksFile } = getRuntimePaths(projectRoot);
  appendJsonLine(tasksFile, task);
  return task;
}

function normalizeMax(value, fallback = 1) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.max(1, Math.floor(value));
  return Math.min(n, 500);
}

function runOnce(projectRoot = process.cwd(), options = {}) {
  ensureRuntimeDir(projectRoot);
  const paths = getRuntimePaths(projectRoot);
  const state = loadState(projectRoot);
  const tasks = parseJsonLines(paths.tasksFile);
  const startOffset = Number.isFinite(state.offset) ? state.offset : 0;
  const maxTasks = normalizeMax(options.maxTasks, 1);
  const selected = tasks.slice(startOffset, startOffset + maxTasks);
  const results = [];

  for (const task of selected) {
    const startedAt = new Date().toISOString();
    const run = runToolCall(
      { tool: task.tool, args: task.args },
      {
        workspaceRoot: task.workspace_root || options.workspaceRoot || projectRoot,
        cwd: projectRoot,
      }
    );
    const finishedAt = new Date().toISOString();
    const resultEntry = {
      task_id: String(task.task_id || ""),
      tool: String(task.tool || ""),
      ok: run.ok !== false,
      error: run && typeof run.error === "string" ? run.error : "",
      output: run,
      started_at: startedAt,
      finished_at: finishedAt,
      created_at: String(task.created_at || ""),
    };
    appendJsonLine(paths.resultsFile, resultEntry);
    results.push(resultEntry);
  }

  const nextOffset = startOffset + selected.length;
  saveState(projectRoot, { offset: nextOffset });
  return {
    processed: selected.length,
    offset: nextOffset,
    results,
  };
}

function listResults(projectRoot = process.cwd(), options = {}) {
  const paths = getRuntimePaths(projectRoot);
  const rows = parseJsonLines(paths.resultsFile);
  const num = normalizeMax(options.num, 20);
  if (rows.length <= num) return rows;
  return rows.slice(rows.length - num);
}

module.exports = {
  getRuntimePaths,
  ensureRuntimeDir,
  parseJsonLines,
  loadState,
  saveState,
  submitTask,
  runOnce,
  listResults,
};
