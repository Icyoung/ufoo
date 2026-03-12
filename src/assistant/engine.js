const { spawn } = require("child_process");
const { loadConfig, normalizeAssistantEngine } = require("../config");
const { DEFAULT_ASSISTANT_TIMEOUT_MS, normalizeAssistantTimeoutMs } = require("./constants");

function splitCommand(raw, fallback = "ufoo-engine") {
  const text = String(raw || "").trim();
  if (!text) return { command: fallback, args: [] };
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { command: fallback, args: [] };
  return { command: parts[0], args: parts.slice(1) };
}

function resolveAssistantEngine({
  projectRoot,
  requestedProvider = "",
  requestedModel = "",
  fallbackProvider = "",
} = {}) {
  const config = loadConfig(projectRoot);

  const requested = normalizeAssistantEngine(requestedProvider);
  const fallback = normalizeAssistantEngine(fallbackProvider) || "codex";

  let selected = requested;
  // Omitted/auto assistant providers inherit the active ufoo-agent provider.
  if (selected === "auto") selected = fallback;
  if (selected === "auto") selected = "codex";

  const model =
    String(requestedModel || "").trim()
    || String(process.env.UFOO_ASSISTANT_MODEL || "").trim()
    || String(config.assistantModel || "").trim()
    || "";

  if (selected === "claude") {
    return {
      engine: "claude",
      kind: "cli",
      provider: "claude-cli",
      model,
    };
  }

  if (selected === "ufoo") {
    const { command, args } = splitCommand(
      process.env.UFOO_ASSISTANT_UFOO_CMD || config.assistantUfooCmd,
      "ufoo-engine"
    );
    return {
      engine: "ufoo",
      kind: "external",
      command,
      args,
      model,
    };
  }

  return {
    engine: "codex",
    kind: "cli",
    provider: "codex-cli",
    model,
  };
}

function parseEngineJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue to line fallback
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // ignore bad lines
    }
  }
  return null;
}

function isUnsupportedArgError(errText) {
  const text = String(errText || "").toLowerCase();
  return text.includes("unknown option")
    || text.includes("unknown argument")
    || text.includes("unexpected argument")
    || text.includes("unrecognized option");
}

function buildExternalEngineArgs(engine = {}, payload = {}) {
  const args = Array.isArray(engine.args) ? [...engine.args] : [];
  args.push("--assistant-task", "--json");
  if (payload.model) args.push("--model", String(payload.model));
  if (payload.session_id) args.push("--session-id", String(payload.session_id));
  if (payload.project_root) args.push("--cwd", String(payload.project_root));
  if (payload.kind) args.push("--kind", String(payload.kind));
  if (payload.context) args.push("--context", String(payload.context));
  if (payload.expect) args.push("--expect", String(payload.expect));
  if (Number.isFinite(payload.timeout_ms)) {
    args.push("--timeout-ms", String(normalizeAssistantTimeoutMs(payload.timeout_ms)));
  }
  args.push(String(payload.task || ""));
  return args;
}

function extractSessionId(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  return String(parsed.session_id || parsed.sessionId || parsed.session || "").trim();
}

async function runExternalAssistantEngine({
  engine,
  payload,
  timeoutMs = DEFAULT_ASSISTANT_TIMEOUT_MS,
}) {
  const startedAt = Date.now();
  const effectiveTimeoutMs = normalizeAssistantTimeoutMs(timeoutMs, DEFAULT_ASSISTANT_TIMEOUT_MS);

  const runAttempt = (attempt = {}) => new Promise((resolve) => {
    const child = spawn(engine.command, attempt.args || [], {
      cwd: payload.project_root || process.cwd(),
      env: { ...process.env, UFOO_ASSISTANT_ENGINE: engine.engine || "ufoo" },
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
        mode: attempt.mode,
        code: -1,
        stdout,
        stderr,
        error: "assistant engine timeout",
      });
    }, effectiveTimeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        mode: attempt.mode,
        code: -1,
        stdout,
        stderr,
        error: err && err.message ? err.message : "assistant engine spawn failed",
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
      finish({
        ok: code === 0,
        mode: attempt.mode,
        code,
        stdout,
        stderr,
        error: "",
      });
    });

    try {
      if (attempt.input) child.stdin.write(attempt.input);
      child.stdin.end();
    } catch {
      // ignore stdin errors
    }
  });

  const argsAttempt = {
    mode: "args",
    args: buildExternalEngineArgs(engine, payload),
    input: "",
  };
  let result = await runAttempt(argsAttempt);

  if (!result.ok && isUnsupportedArgError(result.stderr || result.stdout || result.error)) {
    result = await runAttempt({
      mode: "stdin-json",
      args: Array.isArray(engine.args) ? [...engine.args] : [],
      input: `${JSON.stringify(payload)}\n`,
    });
  }

  const parsed = parseEngineJson(result.stdout);
  if (parsed && typeof parsed === "object") {
    return {
      ...parsed,
      sessionId: extractSessionId(parsed),
      metrics: {
        ...(parsed.metrics && typeof parsed.metrics === "object" ? parsed.metrics : {}),
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  if (result.ok) {
    const summary = String(result.stdout || "").trim();
    return {
      ok: true,
      summary,
      artifacts: [],
      logs: [],
      error: "",
      sessionId: "",
      metrics: { duration_ms: Date.now() - startedAt },
    };
  }

  return {
    ok: false,
    summary: "",
    artifacts: [],
    logs: [],
    error: String(result.stderr || result.stdout || result.error || `assistant engine exited with code ${result.code}`).trim(),
    sessionId: "",
    metrics: { duration_ms: Date.now() - startedAt },
  };
}

module.exports = {
  resolveAssistantEngine,
  runExternalAssistantEngine,
  parseEngineJson,
  splitCommand,
  buildExternalEngineArgs,
  isUnsupportedArgError,
  extractSessionId,
};
