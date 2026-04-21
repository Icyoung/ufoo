const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { redactSecrets } = require("../providerapi/redactor");

const REPORT_PHASES = {
  START: "start",
  PROGRESS: "progress",
  DONE: "done",
  ERROR: "error",
};

function getReportPaths(projectRoot) {
  const { agentDir } = getUfooPaths(projectRoot);
  return {
    reportsFile: path.join(agentDir, "reports.jsonl"),
    stateFile: path.join(agentDir, "report-state.json"),
  };
}

function ensureReportDir(projectRoot) {
  const { agentDir } = getUfooPaths(projectRoot);
  fs.mkdirSync(agentDir, { recursive: true });
}

function normalizePhase(value = "") {
  const phase = String(value || "").trim().toLowerCase();
  if (phase === REPORT_PHASES.START) return REPORT_PHASES.START;
  if (phase === REPORT_PHASES.PROGRESS) return REPORT_PHASES.PROGRESS;
  if (phase === REPORT_PHASES.ERROR) return REPORT_PHASES.ERROR;
  return REPORT_PHASES.DONE;
}

function normalizeScope(value = "") {
  const scope = String(value || "").trim().toLowerCase();
  if (scope === "private") return "private";
  return "public";
}

function normalizeReportInput(input = {}, options = {}) {
  const ts = options.ts || new Date().toISOString();
  let phase = normalizePhase(input.phase || options.phase);
  const entryId = String(
    input.entry_id
      || input.entryId
      || options.entry_id
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  ).trim();

  const taskId = String(
    input.task_id
      || input.taskId
      || input.task
      || options.task_id
      || options.taskId
      || `task-${Date.now()}`
  ).trim();
  const agentId = String(
    input.agent_id
      || input.agentId
      || options.agent_id
      || options.agentId
      || "unknown-agent"
  ).trim() || "unknown-agent";
  const message = String(input.message || "").trim();
  const summary = String(input.summary || "").trim();
  const error = String(input.error || "").trim();
  const source = String(input.source || options.source || "cli").trim() || "cli";
  const scope = normalizeScope(input.scope || options.scope);
  const controllerId = String(
    input.controller_id
      || input.controllerId
      || options.controller_id
      || options.controllerId
      || "ufoo-agent"
  ).trim() || "ufoo-agent";
  const ok = input.ok !== false && phase !== REPORT_PHASES.ERROR && !error;
  if (!ok && phase !== REPORT_PHASES.START && phase !== REPORT_PHASES.PROGRESS) {
    phase = REPORT_PHASES.ERROR;
  }

  const meta = input.meta && typeof input.meta === "object" ? input.meta : {};

  return {
    entry_id: entryId,
    ts,
    phase,
    task_id: taskId,
    agent_id: agentId,
    message,
    summary,
    error,
    ok,
    source,
    scope,
    controller_id: controllerId,
    meta,
  };
}

function appendReport(projectRoot, entry) {
  ensureReportDir(projectRoot);
  const { reportsFile } = getReportPaths(projectRoot);
  fs.appendFileSync(reportsFile, `${JSON.stringify(redactSecrets(entry))}\n`, "utf8");
}

function parseJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return rows;
}

function listReports(projectRoot, options = {}) {
  const { reportsFile } = getReportPaths(projectRoot);
  const num = Number.isFinite(options.num) && options.num > 0 ? options.num : 20;
  const filterAgent = String(options.agent || options.agent_id || "").trim();
  let rows = parseJsonLines(reportsFile);
  if (filterAgent) {
    rows = rows.filter((row) => String(row.agent_id || "").trim() === filterAgent);
  }
  rows.sort((a, b) => {
    const left = new Date(a.ts || 0).getTime();
    const right = new Date(b.ts || 0).getTime();
    return right - left;
  });
  return rows.slice(0, num);
}

function loadReportState(projectRoot) {
  const { stateFile } = getReportPaths(projectRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return { updated_at: "", agents: {} };
    if (!parsed.agents || typeof parsed.agents !== "object") parsed.agents = {};
    if (typeof parsed.updated_at !== "string") parsed.updated_at = "";
    return parsed;
  } catch {
    return { updated_at: "", agents: {} };
  }
}

function saveReportState(projectRoot, state) {
  ensureReportDir(projectRoot);
  const { stateFile } = getReportPaths(projectRoot);
  fs.writeFileSync(stateFile, JSON.stringify(redactSecrets(state), null, 2));
}

function updateReportState(projectRoot, entry) {
  const state = loadReportState(projectRoot);
  const current = state.agents[entry.agent_id] && typeof state.agents[entry.agent_id] === "object"
    ? state.agents[entry.agent_id]
    : {};
  const pending = current.pending && typeof current.pending === "object"
    ? { ...current.pending }
    : {};

  if (entry.phase === REPORT_PHASES.START || entry.phase === REPORT_PHASES.PROGRESS) {
    pending[entry.task_id] = entry;
  } else {
    delete pending[entry.task_id];
  }

  state.agents[entry.agent_id] = {
    ...current,
    pending,
    pending_count: Object.keys(pending).length,
    last: entry,
    updated_at: entry.ts,
  };
  state.updated_at = entry.ts;
  saveReportState(projectRoot, state);
  return state;
}

function isSummaryHiddenEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const scope = normalizeScope(entry.scope);
  if (scope !== "private") return false;
  const controllerId = String(entry.controller_id || "").trim();
  return controllerId === "ufoo-agent";
}

function controllerToSafeName(controllerId = "") {
  return String(controllerId || "ufoo-agent")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getControllerInboxFile(projectRoot, controllerId = "ufoo-agent") {
  const { agentDir } = getUfooPaths(projectRoot);
  const inboxDir = path.join(agentDir, "private-inbox");
  const safe = controllerToSafeName(controllerId);
  return path.join(inboxDir, `${safe}.jsonl`);
}

function appendControllerInboxEntry(projectRoot, controllerId, entry) {
  const file = getControllerInboxFile(projectRoot, controllerId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(redactSecrets(entry))}\n`, "utf8");
}

function listControllerInboxEntries(projectRoot, controllerId = "ufoo-agent", options = {}) {
  const file = getControllerInboxFile(projectRoot, controllerId);
  const rows = parseJsonLines(file);
  const num = Number.isFinite(options.num) && options.num > 0 ? options.num : rows.length;
  if (rows.length <= num) return rows;
  return rows.slice(rows.length - num);
}

function countControllerInboxEntries(projectRoot, controllerId = "ufoo-agent") {
  const file = getControllerInboxFile(projectRoot, controllerId);
  return parseJsonLines(file).length;
}

function clearControllerInbox(projectRoot, controllerId = "ufoo-agent") {
  const file = getControllerInboxFile(projectRoot, controllerId);
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    // ignore clear errors
  }
}

function consumeControllerInboxEntries(projectRoot, controllerId = "ufoo-agent", consumed = []) {
  const file = getControllerInboxFile(projectRoot, controllerId);
  if (!fs.existsSync(file)) return { removed: 0, remaining: 0 };
  const list = Array.isArray(consumed) ? consumed : [];
  if (list.length === 0) {
    const current = parseJsonLines(file);
    return { removed: 0, remaining: current.length };
  }

  const idSet = new Set();
  const legacySerialized = new Set();
  for (const item of list) {
    if (!item) continue;
    if (typeof item === "string") {
      idSet.add(item);
      continue;
    }
    if (typeof item === "object") {
      if (item.entry_id) {
        idSet.add(String(item.entry_id));
      } else {
        legacySerialized.add(JSON.stringify(item));
      }
    }
  }

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { removed: 0, remaining: 0 };
  }

  const keptLines = [];
  let removed = 0;
  for (const line of lines) {
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      const id = parsed.entry_id ? String(parsed.entry_id) : "";
      if (id && idSet.has(id)) {
        removed += 1;
        continue;
      }
      if (!id && legacySerialized.has(JSON.stringify(parsed))) {
        removed += 1;
        continue;
      }
    }
    keptLines.push(line);
  }

  if (keptLines.length === 0) {
    fs.rmSync(file, { force: true });
    return { removed, remaining: 0 };
  }

  fs.writeFileSync(file, `${keptLines.join("\n")}\n`, "utf8");
  return { removed, remaining: keptLines.length };
}

function readReportSummary(projectRoot) {
  const state = loadReportState(projectRoot);
  const agents = Object.entries(state.agents || {}).map(([agentId, value]) => {
    const pending = value && value.pending && typeof value.pending === "object"
      ? Object.values(value.pending).filter((entry) => !isSummaryHiddenEntry(entry))
      : [];
    return {
      agent_id: agentId,
      pending_count: pending.length,
      pending,
      last: value && value.last ? value.last : null,
      updated_at: value && value.updated_at ? value.updated_at : "",
    };
  });
  return {
    updated_at: state.updated_at || "",
    pending_total: agents.reduce((sum, item) => sum + item.pending_count, 0),
    agents,
  };
}

module.exports = {
  REPORT_PHASES,
  getReportPaths,
  normalizePhase,
  normalizeScope,
  normalizeReportInput,
  appendReport,
  listReports,
  loadReportState,
  saveReportState,
  updateReportState,
  readReportSummary,
  controllerToSafeName,
  getControllerInboxFile,
  appendControllerInboxEntry,
  listControllerInboxEntries,
  countControllerInboxEntries,
  clearControllerInbox,
  consumeControllerInboxEntries,
};
