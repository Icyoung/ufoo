const { spawn } = require("child_process");
const path = require("path");
const {
  DEFAULT_ASSISTANT_TIMEOUT_MS,
  DEFAULT_ASSISTANT_TIMEOUT_GRACE_MS,
  normalizeAssistantTimeoutMs,
} = require("./constants");

function resolveAssistantCommand() {
  const raw = String(process.env.UFOO_ASSISTANT_CMD || "ufoo-assistant-agent").trim();
  if (!raw || raw === "ufoo-assistant-agent") {
    return {
      command: process.execPath,
      args: [path.resolve(__dirname, "../../bin/ufoo-assistant-agent.js")],
    };
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return {
      command: process.execPath,
      args: [path.resolve(__dirname, "../../bin/ufoo-assistant-agent.js")],
    };
  }
  return { command: parts[0], args: parts.slice(1) };
}

function parseAssistantOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Continue to line-based fallback.
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // ignore malformed line
    }
  }
  return null;
}

function normalizeResponse(parsed, fallbackError = "") {
  if (!parsed || typeof parsed !== "object") {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: fallbackError || "assistant returned invalid JSON",
      metrics: {},
    };
  }

  return {
    ok: parsed.ok !== false,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    logs: Array.isArray(parsed.logs) ? parsed.logs : [],
    error: typeof parsed.error === "string" ? parsed.error : "",
    metrics: parsed.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {},
  };
}

async function runAssistantTask({
  projectRoot,
  provider = "",
  fallbackProvider = "",
  model = "",
  task = "",
  kind = "mixed",
  context = "",
  expect = "",
  timeoutMs = DEFAULT_ASSISTANT_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const effectiveTimeoutMs = normalizeAssistantTimeoutMs(timeoutMs, DEFAULT_ASSISTANT_TIMEOUT_MS);
    const { command, args } = resolveAssistantCommand();
    const payload = {
      request_id: `assistant-${startedAt}`,
      project_root: projectRoot,
      provider,
      fallback_provider: fallbackProvider,
      model,
      task,
      kind,
      context,
      expect,
      timeout_ms: effectiveTimeoutMs,
    };

    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...process.env, UFOO_ASSISTANT_MODE: "private" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish({
        ok: false,
        summary: "",
        artifacts: [],
        logs: [],
        error: "assistant timeout",
        metrics: { duration_ms: Date.now() - startedAt },
      });
    }, effectiveTimeoutMs + DEFAULT_ASSISTANT_TIMEOUT_GRACE_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        summary: "",
        artifacts: [],
        logs: [],
        error: err && err.message ? err.message : "assistant spawn failed",
        metrics: { duration_ms: Date.now() - startedAt },
      });
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const parsed = parseAssistantOutput(stdout);
      const fallbackError = code === 0
        ? ""
        : (stderr || `assistant exited with code ${code}`);
      const normalized = normalizeResponse(parsed, fallbackError);
      normalized.metrics = {
        ...normalized.metrics,
        duration_ms: Date.now() - startedAt,
      };
      if (!normalized.ok && !normalized.error) {
        normalized.error = fallbackError || "assistant failed";
      }
      finish(normalized);
    });

    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      child.stdin.end();
    } catch {
      // stdin may already be closed.
    }
  });
}

module.exports = {
  runAssistantTask,
  parseAssistantOutput,
  normalizeResponse,
  resolveAssistantCommand,
};
