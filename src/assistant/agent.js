const fs = require("fs");
const path = require("path");
const { runCliAgent } = require("../agent/cliRunner");
const { normalizeCliOutput } = require("../agent/normalizeOutput");
const { resolveAssistantEngine, runExternalAssistantEngine } = require("./engine");
const { DEFAULT_ASSISTANT_TIMEOUT_MS, normalizeAssistantTimeoutMs } = require("./constants");
const { getUfooPaths } = require("../ufoo/paths");

const ASSISTANT_JSON_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
    artifacts: {
      type: "array",
      items: { type: "string" },
    },
    logs: {
      type: "array",
      items: { type: "string" },
    },
    error: { type: "string" },
    metrics: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["ok", "summary"],
};

function parseTaskPayload(payload = {}) {
  const projectRoot = typeof payload.project_root === "string" ? payload.project_root : process.cwd();
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const fallbackProvider = typeof payload.fallback_provider === "string" ? payload.fallback_provider : "";
  const model = typeof payload.model === "string" ? payload.model : "";
  const task = typeof payload.task === "string" ? payload.task.trim() : "";
  const kind = typeof payload.kind === "string" && payload.kind ? payload.kind : "mixed";
  const context = typeof payload.context === "string" ? payload.context : "";
  const expectText = typeof payload.expect === "string" ? payload.expect : "";
  const timeoutMs = normalizeAssistantTimeoutMs(payload.timeout_ms, DEFAULT_ASSISTANT_TIMEOUT_MS);

  return {
    projectRoot,
    provider,
    fallbackProvider,
    model,
    task,
    kind,
    context,
    expect: expectText,
    timeoutMs,
  };
}

function normalizeAssistantPayload(parsed, fallbackError = "") {
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
      error: fallbackError || "assistant returned invalid payload",
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

function buildAssistantSystemPrompt(taskInput) {
  return [
    "You are ufoo-assistant-agent, a private helper for ufoo-agent.",
    "You are NOT exposed on the event bus.",
    "Execute the requested task using local project context and shell/tool access as needed.",
    "Return ONLY JSON that matches schema: {ok, summary, artifacts, logs, error, metrics}.",
    "Rules:",
    "- summary: concise factual result for ufoo-agent to consume.",
    "- artifacts: key files/commands/findings (short strings).",
    "- logs: optional concise trace points.",
    "- error: non-empty only when ok=false.",
    "- Do not include markdown or prose outside JSON.",
    "",
    "Task input:",
    JSON.stringify(taskInput),
  ].join("\n");
}

function getAssistantStatePaths(projectRoot) {
  const dir = getUfooPaths(projectRoot).agentDir;
  return {
    sessionDir: path.join(dir, "sessions"),
  };
}

function getAssistantSessionStateFile(projectRoot, engine = "assistant") {
  const { sessionDir } = getAssistantStatePaths(projectRoot);
  return path.join(sessionDir, `ufoo-assistant-${engine}.json`);
}

function loadAssistantState(projectRoot, engine = "assistant") {
  const file = getAssistantSessionStateFile(projectRoot, engine);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveAssistantState(projectRoot, engine = "assistant", state = {}) {
  const { sessionDir } = getAssistantStatePaths(projectRoot);
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = getAssistantSessionStateFile(projectRoot, engine);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function isSessionError(errorText = "") {
  const text = String(errorText || "").toLowerCase();
  return text.includes("session id")
    || text.includes("session-id")
    || text.includes("already in use");
}

async function runAssistantAgentTask(payload = {}) {
  const taskInput = parseTaskPayload(payload);
  const startedAt = Date.now();

  if (!taskInput.task) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: "missing task",
      metrics: { duration_ms: Date.now() - startedAt },
    };
  }

  const systemPrompt = buildAssistantSystemPrompt(taskInput);
  const engine = resolveAssistantEngine({
    projectRoot: taskInput.projectRoot,
    requestedProvider: taskInput.provider,
    requestedModel: taskInput.model,
    fallbackProvider: taskInput.fallbackProvider,
  });
  const assistantState = loadAssistantState(taskInput.projectRoot, engine.engine);

  let cliRes = null;
  if (engine.kind === "external") {
    cliRes = await runExternalAssistantEngine({
      engine,
      timeoutMs: taskInput.timeoutMs,
      payload: {
        request_type: "assistant_task",
        schema_version: 1,
        engine: engine.engine,
        project_root: taskInput.projectRoot,
        task: taskInput.task,
        kind: taskInput.kind,
        context: taskInput.context,
        expect: taskInput.expect,
        model: engine.model || "",
        session_id: assistantState && typeof assistantState.sessionId === "string" ? assistantState.sessionId : "",
        timeout_ms: taskInput.timeoutMs,
      },
    });
  } else {
    const runCli = async (sessionId) => runCliAgent({
      provider: engine.provider,
      model: engine.model,
      prompt: taskInput.task,
      systemPrompt,
      jsonSchema: ASSISTANT_JSON_SCHEMA,
      disableSession: false,
      sessionId,
      cwd: taskInput.projectRoot,
      timeoutMs: taskInput.timeoutMs,
      sandbox: taskInput.kind === "explore" ? "read-only" : "workspace-write",
    });

    const preferredSession = assistantState && typeof assistantState.sessionId === "string"
      ? assistantState.sessionId
      : undefined;
    cliRes = await runCli(preferredSession);
    if (!cliRes.ok && preferredSession && isSessionError(cliRes.error)) {
      cliRes = await runCli(undefined);
    }
  }

  if (!cliRes || cliRes.ok === false) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: (cliRes && cliRes.error) || "assistant cli failed",
      metrics: { duration_ms: Date.now() - startedAt },
    };
  }

  let result;
  if (engine.kind === "external") {
    result = normalizeAssistantPayload(cliRes);
  } else {
    const normalized = normalizeCliOutput(cliRes.output);
    let parsed;
    try {
      parsed = JSON.parse(normalized);
    } catch {
      parsed = normalized;
    }
    result = normalizeAssistantPayload(parsed);
  }

  result.metrics = {
    ...result.metrics,
    duration_ms: Date.now() - startedAt,
  };
  if (!result.ok && !result.error) {
    result.error = "assistant task failed";
  }

  saveAssistantState(taskInput.projectRoot, engine.engine, {
    engine: engine.engine,
    provider: engine.provider || "",
    model: engine.model || "",
    sessionId: cliRes && typeof cliRes.sessionId === "string" ? cliRes.sessionId : "",
    updated_at: new Date().toISOString(),
  });

  return result;
}

module.exports = {
  runAssistantAgentTask,
  parseTaskPayload,
  normalizeAssistantPayload,
  buildAssistantSystemPrompt,
  getAssistantSessionStateFile,
  loadAssistantState,
  saveAssistantState,
  isSessionError,
  ASSISTANT_JSON_SCHEMA,
};
