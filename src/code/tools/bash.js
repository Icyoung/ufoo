const { spawnSync } = require("child_process");
const { normalizeWorkspaceRoot } = require("./common");

const MAX_TIMEOUT_MS = 600000;

function runBashTool(input = {}, options = {}) {
  try {
    const command = String(input.command || "").trim();
    if (!command) {
      return {
        ok: false,
        error: "command is required",
      };
    }
    const workspaceRoot = normalizeWorkspaceRoot(options.workspaceRoot, options.cwd);
    const timeoutMs = Number.isFinite(input.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(input.timeoutMs)))
      : 60000;
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

module.exports = {
  runBashTool,
};
