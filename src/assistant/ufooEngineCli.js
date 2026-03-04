const { runCliAgent } = require("../agent/cliRunner");
const { normalizeCliOutput } = require("../agent/normalizeOutput");
const { loadConfig } = require("../config");
const { DEFAULT_ASSISTANT_TIMEOUT_MS, normalizeAssistantTimeoutMs } = require("./constants");

function normalizeProvider(value, fallback = "codex-cli") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "codex" || raw === "codex-cli") return "codex-cli";
  if (raw === "claude" || raw === "claude-cli") return "claude-cli";
  return fallback;
}

function parseAssistantTaskArgs(argv = []) {
  const options = {
    assistantTask: false,
    json: false,
    cwd: "",
    model: "",
    sessionId: "",
    provider: "",
    kind: "mixed",
    context: "",
    expect: "",
    timeoutMs: DEFAULT_ASSISTANT_TIMEOUT_MS,
    task: "",
  };

  const args = Array.isArray(argv) ? argv.slice() : [];
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--assistant-task") {
      options.assistantTask = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = args[++i] || "";
      continue;
    }
    if (arg === "--model") {
      options.model = args[++i] || "";
      continue;
    }
    if (arg === "--session-id") {
      options.sessionId = args[++i] || "";
      continue;
    }
    if (arg === "--provider") {
      options.provider = args[++i] || "";
      continue;
    }
    if (arg === "--kind") {
      options.kind = args[++i] || "mixed";
      continue;
    }
    if (arg === "--context") {
      options.context = args[++i] || "";
      continue;
    }
    if (arg === "--expect") {
      options.expect = args[++i] || "";
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = normalizeAssistantTimeoutMs(args[++i], DEFAULT_ASSISTANT_TIMEOUT_MS);
      continue;
    }
    rest.push(arg);
  }
  options.task = rest.join(" ").trim();
  return options;
}

function buildPrompt({ kind = "mixed", context = "", task = "", expect = "" } = {}) {
  const lines = [];
  lines.push(`Task kind: ${kind || "mixed"}`);
  if (context) {
    lines.push("Context:");
    lines.push(context);
  }
  lines.push("Task:");
  lines.push(task || "");
  if (expect) {
    lines.push("Expected result:");
    lines.push(expect);
  }
  return lines.join("\n");
}

function buildSystemPrompt() {
  return [
    "You are ufoo-engine, a self-hosted assistant core.",
    "Return ONLY valid JSON.",
    "Schema:",
    "{",
    '  "ok": true|false,',
    '  "summary": "string",',
    '  "artifacts": ["string"],',
    '  "logs": ["string"],',
    '  "error": "string",',
    '  "metrics": {"key":"value"}',
    "}",
    "Rules:",
    "- summary should be concise and actionable.",
    "- error must be non-empty only when ok=false.",
    "- Do not output markdown wrappers.",
  ].join("\n");
}

function normalizeEngineResult(parsed, fallbackError = "") {
  if (!parsed || typeof parsed !== "object") {
    const text = String(parsed || "").trim();
    if (text) {
      return {
        ok: true,
        summary: text,
        artifacts: [],
        logs: [],
        error: "",
        metrics: {},
      };
    }
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: fallbackError || "ufoo-engine invalid response",
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

function isSessionError(errorText = "") {
  const text = String(errorText || "").toLowerCase();
  return text.includes("session id")
    || text.includes("session-id")
    || text.includes("already in use");
}

function parseStdinPayload(stdinText = "") {
  const line = String(stdinText || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function runEngineTask(taskInput, deps = {}) {
  const {
    runCliAgentImpl = runCliAgent,
    normalizeCliOutputImpl = normalizeCliOutput,
    loadConfigImpl = loadConfig,
    env = process.env,
    cwd = process.cwd(),
  } = deps;

  const projectRoot = taskInput.cwd || taskInput.projectRoot || cwd;
  const config = loadConfigImpl(projectRoot);
  const provider = normalizeProvider(
    taskInput.provider || env.UFOO_UFOO_ENGINE_PROVIDER || config.agentProvider,
    "codex-cli"
  );
  const model =
    String(taskInput.model || "").trim()
    || String(env.UFOO_UFOO_ENGINE_MODEL || "").trim()
    || String(config.agentModel || "").trim()
    || (provider === "claude-cli" ? "opus" : "");

  const systemPrompt = buildSystemPrompt();
  const prompt = buildPrompt({
    kind: taskInput.kind,
    context: taskInput.context,
    task: taskInput.task,
    expect: taskInput.expect,
  });
  const timeoutMs = normalizeAssistantTimeoutMs(taskInput.timeoutMs, DEFAULT_ASSISTANT_TIMEOUT_MS);

  const runOnce = async (sessionId) => runCliAgentImpl({
    provider,
    model,
    prompt,
    systemPrompt,
    sessionId: sessionId || undefined,
    disableSession: false,
    cwd: projectRoot,
    timeoutMs,
    sandbox: taskInput.kind === "explore" ? "read-only" : "workspace-write",
  });

  let cliRes = await runOnce(taskInput.sessionId || "");
  if (!cliRes.ok && taskInput.sessionId && isSessionError(cliRes.error)) {
    cliRes = await runOnce("");
  }

  if (!cliRes.ok) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: cliRes.error || "ufoo-engine cli failed",
      metrics: {},
      session_id: "",
    };
  }

  const normalized = normalizeCliOutputImpl(cliRes.output);
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    parsed = normalized;
  }
  const result = normalizeEngineResult(parsed);
  return {
    ...result,
    session_id: cliRes.sessionId || "",
  };
}

async function runUfooEngineCli({ argv = [], stdinText = "", deps = {} } = {}) {
  const options = parseAssistantTaskArgs(argv);

  let taskInput;
  if (options.assistantTask) {
    if (!options.task) {
      const error = {
        ok: false,
        summary: "",
        artifacts: [],
        logs: [],
        error: "missing task",
        metrics: {},
      };
      return { exitCode: 1, output: `${JSON.stringify(error)}\n` };
    }
    taskInput = {
      task: options.task,
      kind: options.kind,
      context: options.context,
      expect: options.expect,
      provider: options.provider,
      model: options.model,
      sessionId: options.sessionId,
      cwd: options.cwd,
      timeoutMs: normalizeAssistantTimeoutMs(options.timeoutMs, DEFAULT_ASSISTANT_TIMEOUT_MS),
    };
  } else {
    const payload = parseStdinPayload(stdinText);
    if (!payload || typeof payload !== "object") {
      const error = {
        ok: false,
        summary: "",
        artifacts: [],
        logs: [],
        error: "missing request payload",
        metrics: {},
      };
      return { exitCode: 1, output: `${JSON.stringify(error)}\n` };
    }
    taskInput = {
      task: typeof payload.task === "string" ? payload.task : "",
      kind: typeof payload.kind === "string" ? payload.kind : "mixed",
      context: typeof payload.context === "string" ? payload.context : "",
      expect: typeof payload.expect === "string" ? payload.expect : "",
      provider: typeof payload.provider === "string" ? payload.provider : "",
      model: typeof payload.model === "string" ? payload.model : "",
      sessionId: typeof payload.session_id === "string" ? payload.session_id : "",
      cwd: typeof payload.project_root === "string" ? payload.project_root : "",
      timeoutMs: normalizeAssistantTimeoutMs(payload.timeout_ms, DEFAULT_ASSISTANT_TIMEOUT_MS),
    };
  }

  const result = await runEngineTask(taskInput, deps);
  const output = `${JSON.stringify(result)}\n`;
  return {
    exitCode: result.ok === false ? 1 : 0,
    output,
  };
}

module.exports = {
  normalizeProvider,
  parseAssistantTaskArgs,
  buildPrompt,
  buildSystemPrompt,
  normalizeEngineResult,
  parseStdinPayload,
  runEngineTask,
  runUfooEngineCli,
  isSessionError,
};
