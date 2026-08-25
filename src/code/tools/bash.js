const { spawn, spawnSync } = require("child_process");
const { normalizeWorkspaceRoot } = require("./common");

const MAX_TIMEOUT_MS = 600000;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

function normalizeBashInput(input = {}, options = {}) {
  const command = String(input.command || "").trim();
  const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot, options.cwd);
  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(input.timeoutMs)))
    : 60000;
  return { command, workspaceRoot, timeoutMs };
}

function terminateChild(child, signal = "SIGTERM") {
  if (!child) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already have exited; fall back to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // ignore a child that already exited
  }
}

function runBashTool(input = {}, options = {}) {
  try {
    const { command, workspaceRoot, timeoutMs } = normalizeBashInput(input, options);
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
  let command;
  let workspaceRoot;
  let timeoutMs;
  try {
    ({ command, workspaceRoot, timeoutMs } = normalizeBashInput(input, options));
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: err && err.message ? err.message : "bash failed",
    });
  }
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
};
