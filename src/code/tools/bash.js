"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { normalizeWorkspaceRoot } = require("./common");

const MAX_TIMEOUT_MS = 600000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_STARTUP_WAIT_MS = 2500;
const MAX_STARTUP_WAIT_MS = 15000;
const DEFAULT_LOG_MAX_BYTES = 32768;
const MIN_LOG_MAX_BYTES = 256;
const MAX_LOG_MAX_BYTES = 200000;
const DEFAULT_LOG_TAIL_LINES = 80;
const DEFAULT_STATUS_TAIL_LINES = 20;
const DEFAULT_STOP_TAIL_LINES = 30;
const MAX_LOG_TAIL_LINES = 500;
const MAX_LOG_WAIT_MS = 10000;
const VALID_ACTIONS = new Set(["run", "logs", "status", "list", "stop"]);
const SAFE_BG_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function normalizeBashInput(input = {}, options = {}) {
  const rawAction = input.action == null ? "run" : String(input.action).trim().toLowerCase();
  const action = rawAction || "run";
  const command = String(input.command || "").trim();
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot, options.cwd);
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(input.timeoutMs)))
    : 60000;
  const background = Boolean(input.background);
  const startupWaitMs = Number.isFinite(input.startupWaitMs)
    ? Math.min(MAX_STARTUP_WAIT_MS, Math.max(0, Math.floor(input.startupWaitMs)))
    : DEFAULT_STARTUP_WAIT_MS;
  const backgroundId = String(input.backgroundId || "").trim();
  const hasOffset = Number.isFinite(input.offset) && input.offset >= 0;
  const offset = hasOffset ? Math.floor(input.offset) : null;
  const tailLines = Number.isFinite(input.tailLines)
    ? Math.min(MAX_LOG_TAIL_LINES, Math.max(1, Math.floor(input.tailLines)))
    : null;
  const maxBytes = Number.isFinite(input.maxBytes)
    ? Math.min(MAX_LOG_MAX_BYTES, Math.max(MIN_LOG_MAX_BYTES, Math.floor(input.maxBytes)))
    : DEFAULT_LOG_MAX_BYTES;
  const waitMs = Number.isFinite(input.waitMs)
    ? Math.min(MAX_LOG_WAIT_MS, Math.max(0, Math.floor(input.waitMs)))
    : 0;
  return {
    action,
    command,
    workspaceRoot,
    timeoutMs,
    background,
    startupWaitMs,
    backgroundId,
    offset,
    tailLines,
    maxBytes,
    waitMs,
  };
}

function getBgDir(workspaceRoot) {
  return path.join(workspaceRoot, ".ufoo", "agent", "bg");
}

function getBgRecordPath(workspaceRoot, backgroundId) {
  return path.join(getBgDir(workspaceRoot), `${backgroundId}.json`);
}

function getBgLogPath(workspaceRoot, backgroundId) {
  return path.join(getBgDir(workspaceRoot), `${backgroundId}.log`);
}

function getRelativeBgLogPath(backgroundId) {
  return path.posix.join(".ufoo", "agent", "bg", `${backgroundId}.log`);
}

function generateBackgroundId() {
  return `bg_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readBackgroundRecord(workspaceRoot, backgroundId) {
  if (!SAFE_BG_ID_RE.test(backgroundId)) return null;
  const filePath = getBgRecordPath(workspaceRoot, backgroundId);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeBackgroundRecord(workspaceRoot, record) {
  if (!record || !SAFE_BG_ID_RE.test(record.backgroundId || "")) return;
  try {
    writeJsonAtomic(getBgRecordPath(workspaceRoot, record.backgroundId), record);
  } catch {
    // Workspace may have been cleaned up after a test or task finished.
  }
}

function updateBackgroundRecord(workspaceRoot, backgroundId, updater) {
  const current = readBackgroundRecord(workspaceRoot, backgroundId);
  if (!current) return null;
  const next = updater(current);
  if (!next || typeof next !== "object") return current;
  writeBackgroundRecord(workspaceRoot, next);
  return next;
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function terminatePidGroup(pid, signal = "SIGTERM") {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  let signaled = false;
  if (process.platform !== "win32") {
    try {
      process.kill(-num, signal);
      signaled = true;
    } catch {
      // Process group may already have exited; fall back to direct PID.
    }
  }
  if (!signaled) {
    try {
      process.kill(num, signal);
      signaled = true;
    } catch {
      // Process already exited.
    }
  }
  return signaled;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!child) return;
  if (child.pid) {
    terminatePidGroup(child.pid, signal);
    return;
  }
  try {
    child.kill(signal);
  } catch {
    // ignore a child that already exited
  }
}

function reconcileBackgroundRecord(workspaceRoot, backgroundId) {
  const record = readBackgroundRecord(workspaceRoot, backgroundId);
  if (!record) return null;
  const alive = isPidAlive(record.pid);
  if (record.status === "running" && !alive) {
    const updated = {
      ...record,
      status: "exited",
      endedAt: record.endedAt || new Date().toISOString(),
    };
    writeBackgroundRecord(workspaceRoot, updated);
    return { ...updated, running: false };
  }
  return {
    ...record,
    running: record.status === "running" && alive,
  };
}

function getLogSizeBytes(workspaceRoot, backgroundId) {
  try {
    const st = fs.statSync(getBgLogPath(workspaceRoot, backgroundId));
    return Number.isFinite(st.size) ? st.size : 0;
  } catch {
    return 0;
  }
}

function readBackgroundLogSlice(absLogPath, { offset = null, tailLines = DEFAULT_LOG_TAIL_LINES, maxBytes = DEFAULT_LOG_MAX_BYTES } = {}) {
  let totalBytes = 0;
  try {
    const st = fs.statSync(absLogPath);
    totalBytes = Number.isFinite(st.size) ? st.size : 0;
  } catch {
    return { logOutput: "", offset: 0, nextOffset: 0, totalBytes: 0, truncated: false };
  }

  const clampedMaxBytes = Number.isFinite(maxBytes)
    ? Math.min(MAX_LOG_MAX_BYTES, Math.max(MIN_LOG_MAX_BYTES, Math.floor(maxBytes)))
    : DEFAULT_LOG_MAX_BYTES;

  if (Number.isInteger(offset) && offset >= 0) {
    const startOffset = Math.min(totalBytes, offset);
    const toRead = Math.min(clampedMaxBytes, totalBytes - startOffset);
    if (toRead <= 0) {
      return {
        logOutput: "",
        offset: startOffset,
        nextOffset: startOffset,
        totalBytes,
        truncated: false,
      };
    }
    const buf = Buffer.allocUnsafe(toRead);
    let bytesRead = 0;
    const fd = fs.openSync(absLogPath, "r");
    try {
      bytesRead = fs.readSync(fd, buf, 0, toRead, startOffset);
    } finally {
      try { fs.closeSync(fd); } catch {}
    }
    const logOutput = buf.subarray(0, bytesRead).toString("utf8");
    const nextOffset = startOffset + bytesRead;
    return {
      logOutput,
      offset: startOffset,
      nextOffset,
      totalBytes,
      truncated: nextOffset < totalBytes,
    };
  }

  if (totalBytes <= 0) {
    return { logOutput: "", offset: 0, nextOffset: 0, totalBytes: 0, truncated: false };
  }

  const readStart = Math.max(0, totalBytes - clampedMaxBytes);
  const toRead = totalBytes - readStart;
  const buf = Buffer.allocUnsafe(toRead);
  let bytesRead = 0;
  const fd = fs.openSync(absLogPath, "r");
  try {
    bytesRead = fs.readSync(fd, buf, 0, toRead, readStart);
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  const rawChunk = buf.subarray(0, bytesRead).toString("utf8");
  const linesLimit = Number.isFinite(tailLines)
    ? Math.min(MAX_LOG_TAIL_LINES, Math.max(1, Math.floor(tailLines)))
    : DEFAULT_LOG_TAIL_LINES;
  const hasTrailingNewline = rawChunk.endsWith("\n");
  const body = hasTrailingNewline ? rawChunk.slice(0, -1) : rawChunk;
  const allLines = body ? body.split("\n") : [];
  const slicedLines = allLines.length > linesLimit ? allLines.slice(-linesLimit) : allLines;
  const logOutput = slicedLines.length ? `${slicedLines.join("\n")}${hasTrailingNewline ? "\n" : ""}` : "";
  const usedOffset = Math.max(0, totalBytes - Buffer.byteLength(logOutput, "utf8"));
  return {
    logOutput,
    offset: usedOffset,
    nextOffset: totalBytes,
    totalBytes,
    truncated: readStart > 0 || allLines.length > linesLimit,
  };
}

function buildBackgroundPayload(action, workspaceRoot, record, slice, overrides = {}) {
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : null;
  return {
    ok: true,
    kind: "background_bash",
    action,
    workspaceRoot,
    backgroundId: record.backgroundId,
    pid: record.pid,
    running: Boolean(record.running),
    status: record.status,
    code: exitCode,
    exitCode,
    signal: record.signal || "",
    command: record.command || "",
    startedAt: record.startedAt || null,
    endedAt: record.endedAt || null,
    logPath: record.logPath || getRelativeBgLogPath(record.backgroundId),
    offset: slice.offset,
    nextOffset: slice.nextOffset,
    totalBytes: slice.totalBytes,
    truncated: Boolean(slice.truncated),
    logOutput: slice.logOutput,
    stdout: slice.logOutput,
    stderr: "",
    error: "",
    ...overrides,
  };
}

function validateBackgroundIdInput(action, workspaceRoot, backgroundId) {
  if (!backgroundId) {
    return {
      ok: false,
      kind: "background_bash",
      action,
      workspaceRoot,
      error: "backgroundId is required",
    };
  }
  if (!SAFE_BG_ID_RE.test(backgroundId)) {
    return {
      ok: false,
      kind: "background_bash",
      action,
      workspaceRoot,
      backgroundId,
      error: "invalid backgroundId",
    };
  }
  return null;
}

function listBackgroundProcesses(workspaceRoot) {
  const dir = getBgDir(workspaceRoot);
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const backgroundId = name.slice(0, -5);
    const reconciled = reconcileBackgroundRecord(workspaceRoot, backgroundId);
    if (!reconciled) continue;
    records.push({
      backgroundId: reconciled.backgroundId,
      pid: reconciled.pid,
      running: Boolean(reconciled.running),
      status: reconciled.status,
      exitCode: typeof reconciled.exitCode === "number" ? reconciled.exitCode : null,
      signal: reconciled.signal || "",
      command: reconciled.command || "",
      sessionId: reconciled.sessionId || "",
      logPath: reconciled.logPath || getRelativeBgLogPath(reconciled.backgroundId),
      startedAt: reconciled.startedAt || null,
      endedAt: reconciled.endedAt || null,
      totalBytes: getLogSizeBytes(workspaceRoot, reconciled.backgroundId),
    });
  }
  records.sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  return records;
}

function countRunningBackgroundProcesses({ workspaceRoot = process.cwd() } = {}) {
  let root;
  try {
    root = normalizeWorkspaceRoot(workspaceRoot);
  } catch {
    return 0;
  }
  const dir = getBgDir(root);
  if (!fs.existsSync(dir)) return 0;
  return listBackgroundProcesses(root).filter((item) => item.running).length;
}

function spawnDetachedBackgroundProcess(command, workspaceRoot, options = {}) {
  const backgroundId = options.backgroundId || generateBackgroundId();
  const dir = getBgDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const absLogPath = getBgLogPath(workspaceRoot, backgroundId);
  const relLogPath = getRelativeBgLogPath(backgroundId);
  const logFd = fs.openSync(absLogPath, "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(__dirname, "backgroundProcess.js"), getBgRecordPath(workspaceRoot, backgroundId), command], {
      cwd: workspaceRoot,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    try { fs.closeSync(logFd); } catch {}
  }

  const initialRecord = {
    backgroundId,
    pid: child.pid || null,
    command,
    workspaceRoot,
    sessionId: String((options && options.sessionId) || ""),
    logPath: relLogPath,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    exitCode: null,
    signal: "",
  };
  writeBackgroundRecord(workspaceRoot, initialRecord);

  const state = {
    exited: false,
    spawnError: null,
  };

  child.once("error", (err) => {
    state.exited = true;
    state.spawnError = err;
    updateBackgroundRecord(workspaceRoot, backgroundId, (cur) => ({
      ...cur,
      status: "exited",
      exitCode: -1,
      error: err && err.message ? err.message : "bash failed",
      endedAt: cur.endedAt || new Date().toISOString(),
    }));
  });

  child.once("exit", (code, sig) => {
    state.exited = true;
    updateBackgroundRecord(workspaceRoot, backgroundId, (cur) => ({
      ...cur,
      status: cur.status === "stopped" ? "stopped" : "exited",
      exitCode: cur.endedAt ? cur.exitCode : (typeof code === "number" ? code : cur.exitCode),
      signal: sig || cur.signal || "",
      endedAt: cur.endedAt || new Date().toISOString(),
    }));
  });

  if (typeof child.unref === "function") child.unref();

  return {
    child,
    backgroundId,
    absLogPath,
    initialRecord,
    state,
  };
}

function finalizeBackgroundStart(workspaceRoot, launched, maxBytes) {
  const { backgroundId, absLogPath, initialRecord, state } = launched;
  const slice = readBackgroundLogSlice(absLogPath, { offset: 0, maxBytes });
  const record = reconcileBackgroundRecord(workspaceRoot, backgroundId) || {
    ...initialRecord,
    running: false,
  };
  if (state.spawnError) {
    return buildBackgroundPayload("run", workspaceRoot, record, slice, {
      ok: false,
      running: false,
      error: state.spawnError.message || "bash failed",
    });
  }
  if (!record.running && record.exitCode !== 0) {
    const reason = record.signal
      ? `background command killed by signal ${record.signal}`
      : `background command exited with ${record.exitCode ?? -1}`;
    return buildBackgroundPayload("run", workspaceRoot, record, slice, {
      ok: false,
      running: false,
      error: reason,
    });
  }
  return buildBackgroundPayload("run", workspaceRoot, record, slice);
}

function runBackgroundActionSync(parsed, options = {}) {
  const { action, command, workspaceRoot, backgroundId, offset, tailLines, maxBytes } = parsed;

  if (action === "run") {
    if (!command) {
      return { ok: false, kind: "background_bash", action: "run", workspaceRoot, error: "command is required" };
    }
    const launched = spawnDetachedBackgroundProcess(command, workspaceRoot, options);
    return finalizeBackgroundStart(workspaceRoot, launched, maxBytes);
  }

  if (action === "list") {
    const processes = listBackgroundProcesses(workspaceRoot);
    return {
      ok: true,
      kind: "background_bash",
      action: "list",
      workspaceRoot,
      count: processes.length,
      runningCount: processes.filter((item) => item.running).length,
      processes,
      stdout: "",
      stderr: "",
      error: "",
    };
  }

  const invalid = validateBackgroundIdInput(action, workspaceRoot, backgroundId);
  if (invalid) return invalid;

  const record = reconcileBackgroundRecord(workspaceRoot, backgroundId);
  if (!record) {
    return {
      ok: false,
      kind: "background_bash",
      action,
      workspaceRoot,
      backgroundId,
      error: `background process not found: ${backgroundId}`,
    };
  }

  if (action === "logs" || action === "status") {
    const absLogPath = getBgLogPath(workspaceRoot, backgroundId);
    const defaultTail = action === "status" ? DEFAULT_STATUS_TAIL_LINES : DEFAULT_LOG_TAIL_LINES;
    const slice = readBackgroundLogSlice(absLogPath, {
      offset,
      tailLines: tailLines == null ? defaultTail : tailLines,
      maxBytes,
    });
    return buildBackgroundPayload(action, workspaceRoot, record, slice);
  }

  if (action === "stop") {
    if (record.running) {
      terminatePidGroup(record.pid, "SIGTERM");
      if (isPidAlive(record.pid)) terminatePidGroup(record.pid, "SIGKILL");
    }
    const stoppedRecord = updateBackgroundRecord(workspaceRoot, backgroundId, (cur) => ({
      ...cur,
      status: "stopped",
      signal: cur.signal || "SIGTERM",
      endedAt: cur.endedAt || new Date().toISOString(),
    })) || { ...record, status: "stopped", endedAt: new Date().toISOString() };
    const absLogPath = getBgLogPath(workspaceRoot, backgroundId);
    const slice = readBackgroundLogSlice(absLogPath, {
      offset: null,
      tailLines: tailLines == null ? DEFAULT_STOP_TAIL_LINES : tailLines,
      maxBytes,
    });
    return buildBackgroundPayload("stop", workspaceRoot, { ...stoppedRecord, running: false }, slice);
  }

  return {
    ok: false,
    kind: "background_bash",
    action,
    workspaceRoot,
    error: `unsupported bash action: ${action}`,
  };
}

function sleepAbortable(ms, signal) {
  if (!(ms > 0)) return Promise.resolve(false);
  if (signal && signal.aborted) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(false);
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function runBackgroundActionAsync(parsed, options = {}) {
  const {
    action,
    command,
    workspaceRoot,
    startupWaitMs,
    backgroundId,
    offset,
    tailLines,
    maxBytes,
    waitMs,
  } = parsed;
  const signal = options && options.signal;

  if (signal && signal.aborted) {
    return {
      ok: false,
      cancelled: true,
      code: "cancelled",
      error: "CLI cancelled",
      workspaceRoot,
    };
  }

  if (action === "run") {
    if (!command) {
      return { ok: false, kind: "background_bash", action: "run", workspaceRoot, error: "command is required" };
    }
    let launched;
    try {
      launched = spawnDetachedBackgroundProcess(command, workspaceRoot, options);
    } catch (err) {
      return {
        ok: false,
        kind: "background_bash",
        action: "run",
        workspaceRoot,
        error: err && err.message ? err.message : "bash failed",
      };
    }

    if (startupWaitMs > 0 && !launched.state.exited) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          launched.child.removeListener("exit", finish);
          launched.child.removeListener("error", finish);
          if (signal && typeof signal.removeEventListener === "function") {
            signal.removeEventListener("abort", finish);
          }
          resolve();
        };
        const timer = setTimeout(finish, startupWaitMs);
        if (typeof timer.unref === "function") timer.unref();
        launched.child.once("exit", finish);
        launched.child.once("error", finish);
        if (signal && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", finish, { once: true });
        }
      });
    }

    if (signal && signal.aborted) {
      terminatePidGroup(launched.initialRecord.pid, "SIGTERM");
      updateBackgroundRecord(workspaceRoot, launched.backgroundId, (cur) => ({
        ...cur,
        status: "stopped",
        signal: "SIGTERM",
        endedAt: cur.endedAt || new Date().toISOString(),
      }));
      return {
        ok: false,
        cancelled: true,
        code: "cancelled",
        error: "CLI cancelled",
        workspaceRoot,
      };
    }

    return finalizeBackgroundStart(workspaceRoot, launched, maxBytes);
  }

  if (action === "list") {
    return runBackgroundActionSync(parsed, options);
  }

  const invalid = validateBackgroundIdInput(action, workspaceRoot, backgroundId);
  if (invalid) return invalid;

  let record = reconcileBackgroundRecord(workspaceRoot, backgroundId);
  if (!record) {
    return {
      ok: false,
      kind: "background_bash",
      action,
      workspaceRoot,
      backgroundId,
      error: `background process not found: ${backgroundId}`,
    };
  }

  if (action === "logs" || action === "status") {
    if (action === "logs" && waitMs > 0 && record.running) {
      const baselineBytes = Number.isInteger(offset) && offset >= 0
        ? offset
        : getLogSizeBytes(workspaceRoot, backgroundId);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const currentBytes = getLogSizeBytes(workspaceRoot, backgroundId);
        if (currentBytes > baselineBytes || !isPidAlive(record.pid)) break;
        const aborted = await sleepAbortable(Math.min(100, deadline - Date.now()), signal);
        if (aborted) {
          return {
            ok: false,
            cancelled: true,
            code: "cancelled",
            error: "CLI cancelled",
            workspaceRoot,
          };
        }
      }
      record = reconcileBackgroundRecord(workspaceRoot, backgroundId) || record;
    }

    const absLogPath = getBgLogPath(workspaceRoot, backgroundId);
    const defaultTail = action === "status" ? DEFAULT_STATUS_TAIL_LINES : DEFAULT_LOG_TAIL_LINES;
    const slice = readBackgroundLogSlice(absLogPath, {
      offset,
      tailLines: tailLines == null ? defaultTail : tailLines,
      maxBytes,
    });
    return buildBackgroundPayload(action, workspaceRoot, record, slice);
  }

  if (action === "stop") {
    if (record.running) {
      terminatePidGroup(record.pid, "SIGTERM");
      const termDeadline = Date.now() + 400;
      while (Date.now() < termDeadline && isPidAlive(record.pid)) {
        await sleepAbortable(50, null);
      }
      if (isPidAlive(record.pid)) {
        terminatePidGroup(record.pid, "SIGKILL");
        const killDeadline = Date.now() + 150;
        while (Date.now() < killDeadline && isPidAlive(record.pid)) {
          await sleepAbortable(30, null);
        }
      }
    }
    const stoppedRecord = updateBackgroundRecord(workspaceRoot, backgroundId, (cur) => ({
      ...cur,
      status: "stopped",
      signal: cur.signal || "SIGTERM",
      endedAt: cur.endedAt || new Date().toISOString(),
    })) || { ...record, status: "stopped", endedAt: new Date().toISOString() };
    const absLogPath = getBgLogPath(workspaceRoot, backgroundId);
    const slice = readBackgroundLogSlice(absLogPath, {
      offset: null,
      tailLines: tailLines == null ? DEFAULT_STOP_TAIL_LINES : tailLines,
      maxBytes,
    });
    return buildBackgroundPayload("stop", workspaceRoot, { ...stoppedRecord, running: false }, slice);
  }

  return {
    ok: false,
    kind: "background_bash",
    action,
    workspaceRoot,
    error: `unsupported bash action: ${action}`,
  };
}

function runBashTool(input = {}, options = {}) {
  try {
    const parsed = normalizeBashInput(input, options);
    if (!VALID_ACTIONS.has(parsed.action)) {
      return {
        ok: false,
        kind: "background_bash",
        action: parsed.action,
        workspaceRoot: parsed.workspaceRoot,
        error: `unsupported bash action: ${parsed.action}`,
      };
    }
    if (parsed.action !== "run" || parsed.background) {
      return runBackgroundActionSync(parsed, options);
    }

    const { command, workspaceRoot, timeoutMs } = parsed;
    if (!command) {
      return {
        ok: false,
        error: "command is required",
      };
    }
    const result = spawnSync(command, {
      cwd: workspaceRoot,
      shell: true,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });

    if (result.error) {
      return {
        ok: false,
        workspaceRoot,
        code: typeof result.status === "number" ? result.status : -1,
        signal: result.signal || "",
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
        error: result.error.message || "bash failed",
      };
    }

    if (typeof result.status !== "number") {
      return {
        ok: false,
        workspaceRoot,
        code: -1,
        signal: result.signal || "",
        stdout: String(result.stdout || ""),
        stderr: String(result.stderr || ""),
        error: `command killed by signal ${result.signal || "unknown"}`,
      };
    }

    const code = result.status;
    return {
      ok: code === 0,
      workspaceRoot,
      code,
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      error: code === 0 ? "" : `command exited with ${code}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "bash failed",
    };
  }
}

/**
 * Async bash execution for the native agent loop. Unlike spawnSync this path
 * can observe an AbortSignal while a command is running and terminate the
 * whole shell process group instead of waiting for the command's timeout.
 */
function runBashToolAsync(input = {}, options = {}) {
  let parsed;
  try {
    parsed = normalizeBashInput(input, options);
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: err && err.message ? err.message : "bash failed",
    });
  }

  if (!VALID_ACTIONS.has(parsed.action)) {
    return Promise.resolve({
      ok: false,
      kind: "background_bash",
      action: parsed.action,
      workspaceRoot: parsed.workspaceRoot,
      error: `unsupported bash action: ${parsed.action}`,
    });
  }

  if (parsed.action !== "run" || parsed.background) {
    return runBackgroundActionAsync(parsed, options);
  }

  const { command, workspaceRoot, timeoutMs } = parsed;
  const signal = options && options.signal;
  if (!command) {
    return Promise.resolve({ ok: false, error: "command is required" });
  }
  if (signal && signal.aborted) {
    return Promise.resolve({
      ok: false,
      cancelled: true,
      code: "cancelled",
      error: "CLI cancelled",
      workspaceRoot,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let overflow = false;
    let timer = null;
    let killTimer = null;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      resolve({
        workspaceRoot,
        stdout,
        stderr,
        ...result,
      });
    };
    const kill = (reason) => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "cancelled") cancelled = true;
      terminateChild(child, "SIGTERM");
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 250);
      if (typeof killTimer.unref === "function") killTimer.unref();
    };
    const onAbort = () => kill("cancelled");
    let child;
    try {
      child = spawn(command, {
        cwd: workspaceRoot,
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      finish({
        ok: false,
        code: -1,
        signal: "",
        error: err && err.message ? err.message : "bash failed",
      });
      return;
    }

    const collect = (target, chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (target === "stdout") stdout += text;
      else stderr += text;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_BUFFER_BYTES) {
        overflow = true;
        kill("overflow");
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.once("error", (err) => {
      finish({
        ok: false,
        code: -1,
        signal: "",
        cancelled,
        error: err && err.message ? err.message : "bash failed",
      });
    });
    child.once("close", (code, signalName) => {
      if (cancelled) {
        finish({ ok: false, cancelled: true, code: "cancelled", signal: signalName || "SIGTERM", error: "CLI cancelled" });
        return;
      }
      if (timedOut) {
        finish({ ok: false, timedOut: true, code: -1, signal: signalName || "SIGTERM", error: `command timed out after ${timeoutMs}ms` });
        return;
      }
      if (overflow) {
        finish({ ok: false, code: -1, signal: signalName || "SIGTERM", error: "command output exceeded 2 MB" });
        return;
      }
      if (typeof code !== "number") {
        finish({ ok: false, code: -1, signal: signalName || "", error: `command killed by signal ${signalName || "unknown"}` });
        return;
      }
      finish({ ok: code === 0, code, signal: signalName || "", error: code === 0 ? "" : `command exited with ${code}` });
    });
    timer = setTimeout(() => kill("timeout"), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = {
  runBashTool,
  runBashToolAsync,
  listBackgroundProcesses,
  countRunningBackgroundProcesses,
};
