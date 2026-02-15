const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { runToolCall } = require("./dispatch");
const { runNativeAgentTask } = require("./nativeRunner");
const {
  runDecomposedTask,
  createBusProgressReporter,
} = require("./taskDecomposer");
const {
  runUcodeTui,
  shouldUseUcodeTui,
  buildUcodeBannerLines,
  StreamBuffer,
  createEscapeTagStripper,
  stripLeakedEscapeTags,
} = require("./tui");
const { stripBlessedTags } = require("../chat/text");
const { loadConfig } = require("../config");
const {
  resolveSessionId,
  normalizeSessionId,
  saveSessionSnapshot,
  loadSessionSnapshot,
} = require("./sessionStore");

function printPrompt() {
  process.stdout.write("> ");
}

function printUcodeBanner(stdout = process.stdout, { model = "", workspaceRoot = process.cwd(), sessionId = "" } = {}) {
  stdout.write(`${buildUcodeBannerLines({
    model,
    engine: "ufoo-core",
    workspaceRoot,
    sessionId,
    width: (stdout && stdout.columns) || 0,
  }).join("\n")}\n`);
}

function normalizeLine(input = "") {
  return String(input || "").trim();
}

function parseJson(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

function readTextOrFile(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (fs.existsSync(raw)) return String(fs.readFileSync(raw, "utf8") || "");
  } catch {
    // ignore
  }
  return raw;
}

function extractAgentNickname(agentId = "") {
  // Extract nickname from agent ID like "ufoo-agent:abc123" -> "ufoo"
  const id = String(agentId || "").trim();
  if (!id) return "";

  // Remove the instance ID part (after colon)
  const base = id.split(":")[0];

  // Common agent nickname mappings
  if (base === "ufoo-agent") return "ufoo";
  if (base === "claude-code") return "claude";
  if (base === "ufoo-code") return "code";

  // Return base name as-is for others
  return base;
}

function resolveUcodeProviderModel({
  workspaceRoot = process.cwd(),
  provider = "",
  model = "",
} = {}) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const config = loadConfig(root);
  const fallbackProviderFromAgent = resolvePlannerProvider(String(config.agentProvider || "").trim());
  const explicitProvider = String(
    provider
      || process.env.UFOO_UCODE_PROVIDER
      || config.ucodeProvider
      || ""
  ).trim();
  const resolvedProvider = resolvePlannerProvider(explicitProvider || fallbackProviderFromAgent);
  const resolvedModel = String(
    model
      || process.env.UFOO_UCODE_MODEL
      || config.ucodeModel
      || config.agentModel
      || ""
  ).trim();
  return {
    provider: resolvedProvider,
    model: resolvedModel || "default",
  };
}

function clampContext(text = "", maxChars = 32000) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function resolvePlannerProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "claude" || text === "claude-cli" || text === "claude-code" || text === "anthropic") return "anthropic";
  if (text === "codex" || text === "codex-cli" || text === "codex-code" || text === "openai") return "openai";
  return text;
}

function extractJsonSummary(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const direct = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();
  if (direct && typeof direct === "object") {
    if (typeof direct.summary === "string" && direct.summary.trim()) return direct.summary.trim();
    if (typeof direct.reply === "string" && direct.reply.trim()) return direct.reply.trim();
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.summary === "string" && parsed.summary.trim()) return parsed.summary.trim();
        if (typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply.trim();
      }
    } catch {
      // keep scanning
    }
  }
  return raw;
}

function isCliTimeoutError(message = "") {
  const text = String(message || "").toLowerCase();
  return text.includes("cli timeout");
}

function isCliCancelledError(message = "") {
  const text = String(message || "").toLowerCase();
  return text.includes("cli cancelled") || text.includes("canceled");
}

function computeExtendedTimeout(baseTimeoutMs) {
  const base = Number.isFinite(baseTimeoutMs) ? Math.max(1000, Math.floor(baseTimeoutMs)) : 300000;
  return Math.min(1800000, Math.max(base * 2, base + 120000));
}

function enrichNativeError(errorMessage = "") {
  const text = String(errorMessage || "").trim();
  if (!text) return "nl task failed";

  const lower = text.toLowerCase();
  if (
    lower.includes("fetch failed")
    || lower.includes("enotfound")
    || lower.includes("econnrefused")
    || lower.includes("network error")
    || lower.includes("other side closed")
  ) {
    return `${text}. Network connection to provider failed. Check VPN/proxy/network and verify endpoint/key via /settings ucode show.`;
  }
  if (lower.includes("model is not configured")) {
    return `${text}. Configure ucode with /settings ucode set provider=<openai|anthropic> model=<id> key=<apiKey> [url=<baseUrl>]`;
  }
  if (lower.includes("baseurl is not configured")) {
    return `${text}. Configure endpoint with /settings ucode set url=<baseUrl> (and key/model if missing).`;
  }
  if (
    /provider request failed \((401|403)\)/i.test(text)
    || lower.includes("unauthorized")
    || lower.includes("invalid api key")
  ) {
    return `${text}. Check provider/url/key via /settings ucode show.`;
  }
  return text;
}

function normalizeToolLogEvent(event = {}) {
  if (!event || typeof event !== "object") return null;
  const tool = String(event.tool || event.name || "").trim().toLowerCase();
  if (!tool) return null;
  if (tool !== "read" && tool !== "write" && tool !== "edit" && tool !== "bash") return null;
  const phase = String(event.phase || "update").trim().toLowerCase();
  const normalizedPhase = phase === "error" ? "error" : (phase === "start" ? "start" : "");
  if (!normalizedPhase) return null;
  const rawArgs = event.args && typeof event.args === "object" ? event.args : {};
  const args = { ...rawArgs };
  const error = String(event.error || "").trim();
  return {
    type: "tool",
    tool,
    phase: normalizedPhase,
    args,
    error,
  };
}

function createToolLogCollector(logs = [], onToolLog = null) {
  const list = Array.isArray(logs) ? logs : [];
  const callback = typeof onToolLog === "function" ? onToolLog : null;

  return (event = {}) => {
    const log = normalizeToolLogEvent(event);
    if (!log) return null;
    list.push(log);
    if (callback) {
      try {
        callback(log);
      } catch {
        // ignore callback failures
      }
    }
    return log;
  };
}

function isProjectAnalysisTask(task = "") {
  const text = String(task || "").trim().toLowerCase();
  if (!text) return false;
  return /(?:analy[sz]e|analysis|review|audit|status|architecture|codebase|repo|project|现状|架构|审查|分析|项目|代码库)/i.test(text);
}

function createProjectPreflightContext({
  workspaceRoot = process.cwd(),
  pushToolLog = () => null,
} = {}) {
  const root = String(workspaceRoot || process.cwd());
  const readCandidates = [
    "AGENTS.md",
    "README.md",
    "README.zh-CN.md",
    "package.json",
  ];
  const blocks = [];

  for (const relPath of readCandidates) {
    pushToolLog({
      tool: "read",
      phase: "start",
      args: { path: relPath },
      error: "",
    });
    const readRes = runToolCall(
      {
        tool: "read",
        args: { path: relPath, maxBytes: 12000 },
      },
      {
        workspaceRoot: root,
        cwd: root,
      }
    );
    pushToolLog({
      tool: "read",
      phase: readRes && readRes.ok === false ? "error" : "",
      args: { path: relPath },
      error: readRes && readRes.ok === false ? String(readRes.error || "") : "",
    });
    if (!readRes || readRes.ok === false) continue;
    const content = String(readRes.content || "").trim();
    if (!content) continue;
    const clipped = content.length > 2400
      ? `${content.slice(0, 2400)}\n...[truncated]`
      : content;
    blocks.push(`File: ${relPath}\n${clipped}`);
    if (blocks.length >= 2) break;
  }

  if (blocks.length === 0) {
    const command = "ls -la";
    pushToolLog({
      tool: "bash",
      phase: "start",
      args: { command },
      error: "",
    });
    const bashRes = runToolCall(
      {
        tool: "bash",
        args: { command, timeoutMs: 4000 },
      },
      {
        workspaceRoot: root,
        cwd: root,
      }
    );
    pushToolLog({
      tool: "bash",
      phase: bashRes && bashRes.ok === false ? "error" : "",
      args: { command },
      error: bashRes && bashRes.ok === false ? String(bashRes.error || "") : "",
    });
    if (bashRes && bashRes.ok !== false) {
      const stdout = String(bashRes.stdout || "").trim();
      const clipped = stdout.length > 1200
        ? `${stdout.slice(0, 1200)}\n...[truncated]`
        : stdout;
      if (clipped) {
        blocks.push(`Command: ${command}\n${clipped}`);
      }
    }
  }

  if (blocks.length === 0) return "";
  return [
    "Preflight snapshot (captured by ucode):",
    ...blocks.map((block) => `---\n${block}`),
  ].join("\n");
}

function buildNlFallbackSummary(logs = []) {
  const list = Array.isArray(logs) ? logs : [];
  const started = list.filter((entry) => entry && entry.phase === "start").length;
  const failed = list.filter((entry) => entry && entry.phase === "error").length;

  if (started > 0 || failed > 0) {
    const parts = [`${started} tool step${started === 1 ? "" : "s"} started`];
    if (failed > 0) parts.push(`${failed} failed`);
    return `Done (${parts.join(", ")}).`;
  }
  if (list.length > 0) {
    return `Done (${list.length} tool events).`;
  }
  return "Done (no model text response).";
}

async function runNaturalLanguageTask(task = "", state = {}, options = {}) {
  const taskText = String(task || "").trim();
  if (!taskText) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: "empty task",
      metrics: {},
      streamed: false,
      streamLastChar: "",
    };
  }

  const provider = resolvePlannerProvider(
    state.provider || process.env.UFOO_UCODE_PROVIDER || ""
  );
  const model = String(state.model || process.env.UFOO_UCODE_MODEL || "").trim();
  const timeoutMs = Number.isFinite(state.timeoutMs) ? state.timeoutMs : 300000;
  let streamed = false;
  let streamLastChar = "";
  const onDelta = typeof options.onDelta === "function"
    ? options.onDelta
    : null;
  const logs = [];
  const onToolLog = typeof options.onToolLog === "function"
    ? options.onToolLog
    : null;
  const pushToolLog = createToolLogCollector(logs, onToolLog);

  // Detect bug fix tasks and use decomposed runner
  const isBugFixTask = /fix|bug|issue|problem|error|broken|not work/i.test(taskText);
  const useDecomposition = isBugFixTask && !options.disableDecomposition;
  const analysisTask = isProjectAnalysisTask(taskText);
  const workspaceRoot = String(state.workspaceRoot || process.cwd());
  const preflightContext = analysisTask
    ? createProjectPreflightContext({
      workspaceRoot,
      pushToolLog,
    })
    : "";
  const taskPrompt = analysisTask
    ? `${taskText}\n\nAnalysis requirements:\n- Inspect repository evidence before concluding.\n- Cite concrete file observations.\n- Keep findings concise and actionable.`
    : taskText;
  const systemContext = [String(state.context || "").trim(), preflightContext]
    .filter(Boolean)
    .join("\n\n");

  const onStream = onDelta
    ? (delta) => {
      const text = String(delta || "");
      if (!text) return;
      streamed = true;
      streamLastChar = text.slice(-1);
      try {
        onDelta(text);
      } catch {
        // ignore stream callback failures
      }
    }
    : null;
  const runNativeAgentImpl = typeof options.runNativeAgentImpl === "function"
    ? options.runNativeAgentImpl
    : runNativeAgentTask;
  const invokeNative = (sessionIdValue = "", timeoutOverrideMs = timeoutMs) => runNativeAgentImpl({
    workspaceRoot,
    provider,
    model,
    prompt: taskPrompt,
    systemPrompt: systemContext,
    messages: Array.isArray(state.nlMessages) ? state.nlMessages : [],
    sessionId: String(sessionIdValue || ""),
    timeoutMs: timeoutOverrideMs,
    onStreamDelta: onStream,
    onToolEvent: (event) => {
      pushToolLog(event);
    },
    signal: options.signal,
  });

  try {
    let cliRes;

    // Use decomposed runner for bug fix tasks
    if (useDecomposition) {
      const decomposedResult = await runDecomposedTask({
        task: taskText,
        state,
        onProgress: options.onProgress,
        onToolEvent: pushToolLog,
        signal: options.signal,
        workspaceRoot,
        provider,
        model,
        systemPrompt: systemContext,
        messages: Array.isArray(state.nlMessages) ? state.nlMessages : [],
        sessionId: String(state.sessionId || ""),
      });

      if (decomposedResult.ok) {
        cliRes = {
          ok: true,
          output: decomposedResult.summary,
          sessionId: state.sessionId,
          messages: state.nlMessages,
        };
      } else {
        cliRes = {
          ok: false,
          error: decomposedResult.error,
        };
      }
    } else {
      // Original single-step execution
      cliRes = await invokeNative(String(state.sessionId || ""));

      if (!cliRes || cliRes.ok === false) {
        const errMsg = String((cliRes && cliRes.error) || "");
        if (isCliTimeoutError(errMsg)) {
          const extendedTimeoutMs = computeExtendedTimeout(timeoutMs);
          cliRes = await invokeNative(String(state.sessionId || ""), extendedTimeoutMs);
        }
      }
    }

    if (!cliRes || cliRes.ok === false) {
      const errMsg = String((cliRes && cliRes.error) || "");
      return {
        ok: false,
        summary: "",
        artifacts: [],
        logs: logs.slice(),
        error: enrichNativeError(errMsg),
        cancelled: isCliCancelledError(errMsg),
        metrics: {},
        streamed: Boolean(streamed || (cliRes && cliRes.streamed)),
        streamLastChar,
      };
    }
    if (cliRes && typeof cliRes.sessionId === "string" && cliRes.sessionId.trim()) {
      state.sessionId = cliRes.sessionId.trim();
    }
    if (cliRes && Array.isArray(cliRes.messages)) {
      state.nlMessages = cliRes.messages;
    }
    const normalized = String(cliRes.output || "").trim();
    const summary = extractJsonSummary(normalized);
    const resolvedSummary = String(summary || "").trim() || buildNlFallbackSummary(logs);
    return {
      ok: true,
      summary: resolvedSummary,
      artifacts: [],
      logs: logs.slice(),
      error: "",
      metrics: {},
      streamed: Boolean(streamed || cliRes.streamed),
      streamLastChar,
    };
  } catch (err) {
    return {
      ok: false,
      summary: "",
      artifacts: [],
      logs: logs.slice(),
      error: enrichNativeError(err && err.message ? err.message : "nl task failed"),
      cancelled: isCliCancelledError(err && err.message ? err.message : ""),
      metrics: {},
      streamed,
      streamLastChar,
    };
  }
}

function formatNlResult(result, asJson = false) {
  if (asJson) {
    return JSON.stringify(result && typeof result === "object" ? result : {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: "invalid nl result",
      metrics: {},
    });
  }
  if (result && result.cancelled) {
    return "Cancelled.";
  }
  if (!result || result.ok === false) {
    return `Error: ${(result && result.error) || "task failed"}`;
  }
  const summary = String(result.summary || "").trim();
  if (summary) return summary;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter(Boolean) : [];
  if (artifacts.length > 0) return artifacts.join("\n");
  return buildNlFallbackSummary(result && Array.isArray(result.logs) ? result.logs : []);
}

function buildNlContext({
  appendSystemPrompt = "",
  systemPrompt = "",
} = {}) {
  const inline = readTextOrFile(appendSystemPrompt) || readTextOrFile(systemPrompt);
  if (inline) return clampContext(inline);

  const envFallback = readTextOrFile(process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT)
    || readTextOrFile(process.env.UFOO_UCODE_BOOTSTRAP_FILE)
    || readTextOrFile(process.env.UFOO_UCODE_PROMPT_FILE);
  return clampContext(envFallback);
}

function buildSessionSnapshotFromState(state = {}) {
  const source = state && typeof state === "object" ? state : {};
  return {
    sessionId: resolveSessionId(source.sessionId),
    workspaceRoot: String(source.workspaceRoot || process.cwd()).trim() || process.cwd(),
    provider: String(source.provider || "").trim(),
    model: String(source.model || "").trim(),
    context: String(source.context || ""),
    nlMessages: Array.isArray(source.nlMessages) ? source.nlMessages : [],
    createdAt: String(source.sessionCreatedAt || "").trim(),
  };
}

function persistSessionState(state = {}) {
  const snapshot = buildSessionSnapshotFromState(state);
  const saved = saveSessionSnapshot(snapshot.workspaceRoot, snapshot);
  if (saved && saved.ok) {
    state.sessionId = saved.sessionId;
    const savedSnapshot = saved.snapshot && typeof saved.snapshot === "object"
      ? saved.snapshot
      : {};
    const createdAt = String(savedSnapshot.createdAt || "").trim();
    if (createdAt) {
      state.sessionCreatedAt = createdAt;
    }
  }
  return saved;
}

function resumeSessionState(state = {}, sessionId = "", workspaceRoot = process.cwd()) {
  const targetId = normalizeSessionId(sessionId);
  if (!targetId) {
    return {
      ok: false,
      error: "invalid session id",
      sessionId: "",
      restoredMessages: 0,
    };
  }

  const loaded = loadSessionSnapshot(workspaceRoot, targetId);
  if (!loaded || loaded.ok === false || !loaded.snapshot) {
    return {
      ok: false,
      error: String((loaded && loaded.error) || `session not found: ${targetId}`),
      sessionId: targetId,
      restoredMessages: 0,
    };
  }

  const snapshot = loaded.snapshot;
  state.sessionId = String(snapshot.sessionId || targetId);
  state.workspaceRoot = String(snapshot.workspaceRoot || workspaceRoot || process.cwd());
  state.provider = String(snapshot.provider || "");
  state.model = String(snapshot.model || "");
  state.context = String(snapshot.context || "");
  state.nlMessages = Array.isArray(snapshot.nlMessages) ? snapshot.nlMessages : [];
  state.sessionCreatedAt = String(snapshot.createdAt || "").trim();

  return {
    ok: true,
    error: "",
    sessionId: state.sessionId,
    restoredMessages: state.nlMessages.length,
  };
}

function shellQuote(value = "") {
  const text = String(value == null ? "" : value);
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function toText(value = "") {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value == null ? "" : value);
}

function stripAnsi(text = "") {
  const raw = String(text || "");
  if (!raw) return "";
  // CSI + OSC sequences (best-effort).
  return raw
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)/g, "");
}

function runShellCapture(command = "", workspaceRoot = process.cwd()) {
  try {
    const output = execSync(String(command || ""), {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      ok: true,
      output: toText(output),
      error: "",
    };
  } catch (err) {
    const stdout = toText(err && err.stdout);
    const stderr = toText(err && err.stderr);
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      ok: false,
      output: detail,
      error: detail || (err && err.message ? err.message : "shell command failed"),
    };
  }
}

function safeSubscriberName(subscriberId = "") {
  return String(subscriberId || "").replace(/:/g, "_");
}

function resolvePendingQueueFile(workspaceRoot = process.cwd(), subscriberId = "") {
  const root = String(workspaceRoot || process.cwd()).trim() || process.cwd();
  const sub = String(subscriberId || "").trim();
  if (!sub) return "";
  return path.join(root, ".ufoo", "bus", "queues", safeSubscriberName(sub), "pending.jsonl");
}

function resolveUfooProjectRoot(preferredRoot = "", env = process.env) {
  const candidates = [
    String(preferredRoot || "").trim(),
    String((env && env.UFOO_UCODE_PROJECT_ROOT) || "").trim(),
    String((env && env.UFOO_PROJECT_ROOT) || "").trim(),
    process.cwd(),
  ].filter(Boolean);

  for (const root of candidates) {
    try {
      const busDir = path.join(root, ".ufoo", "bus");
      if (fs.existsSync(busDir)) return root;
    } catch {
      // ignore
    }
  }

  return candidates[0] || process.cwd();
}

function countPendingQueueLines(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return 0;
  try {
    if (!fs.existsSync(target)) return 0;
    const content = String(fs.readFileSync(target, "utf8") || "");
    if (!content.trim()) return 0;
    return content.split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function isPidAlive(pid) {
  const p = parseInt(String(pid || "").trim(), 10);
  if (!Number.isFinite(p) || p <= 0) return false;
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}

function listProcessingFiles(pendingFilePath = "") {
  const pendingFile = String(pendingFilePath || "").trim();
  if (!pendingFile) return [];
  const dir = path.dirname(pendingFile);
  const base = path.basename(pendingFile);
  const prefix = `${base}.processing.`;
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name && name.startsWith(prefix))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function countRecoverableProcessingFiles(pendingFilePath = "", options = {}) {
  const pendingFile = String(pendingFilePath || "").trim();
  if (!pendingFile) return 0;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 60000;
  const now = Date.now();
  const files = listProcessingFiles(pendingFile);
  let count = 0;

  for (const file of files) {
    const name = path.basename(file);
    const m = name.match(/\.processing\.(\d+)\./);
    const pid = m ? parseInt(m[1], 10) : NaN;

    if (Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) {
      count += 1;
      continue;
    }

    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) continue;
    try {
      const stat = fs.statSync(file);
      if (stat && stat.isFile() && (now - stat.mtimeMs > maxAgeMs)) {
        count += 1;
      }
    } catch {
      // ignore
    }
  }

  return count;
}

function getPendingBusCount(workspaceRoot = process.cwd(), subscriberId = "") {
  const pendingFile = resolvePendingQueueFile(workspaceRoot, subscriberId);
  const pendingLines = countPendingQueueLines(pendingFile);
  if (!pendingFile) return pendingLines;
  // If a prior crash left `.processing.*` behind, count it so autoBus can self-heal.
  const recoverable = countRecoverableProcessingFiles(pendingFile, { maxAgeMs: 60000 });
  return pendingLines + recoverable;
}

function drainJsonlFile(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return { drained: [], rawLines: [], error: "" };
  if (!fs.existsSync(target)) return { drained: [], rawLines: [], error: "" };

  const processingFile = `${target}.processing.${process.pid}.${Date.now()}`;
  let content = "";
  let renamed = false;
  try {
    fs.renameSync(target, processingFile);
    renamed = true;
    content = String(fs.readFileSync(processingFile, "utf8") || "");
  } catch (err) {
    // Restore on failure.
    try {
      if (renamed && fs.existsSync(processingFile)) {
        fs.renameSync(processingFile, target);
      }
    } catch {
      // ignore
    }
    return { drained: [], rawLines: [], error: err && err.message ? err.message : "drain failed" };
  }

  const rawLines = content.split(/\r?\n/).filter((line) => line.trim());
  const drained = rawLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  // Keep processing file around for potential requeue decisions by caller.
  return { drained, rawLines, error: "", processingFile };
}

function requeueJsonlLines(filePath = "", lines = []) {
  const target = String(filePath || "").trim();
  const list = Array.isArray(lines) ? lines.filter((l) => String(l || "").trim()) : [];
  if (!target || list.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${list.join("\n")}\n`, "utf8");
  } catch {
    // ignore requeue errors
  }
}

function cleanupProcessingFile(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return;
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  } catch {
    // ignore
  }
}

function recoverStaleProcessingFiles(pendingFilePath = "", options = {}) {
  const pendingFile = String(pendingFilePath || "").trim();
  if (!pendingFile) return 0;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : 30000;
  const dir = path.dirname(pendingFile);
  const base = path.basename(pendingFile);
  const prefix = `${base}.processing.`;
  const now = Date.now();
  let recovered = 0;

  try {
    if (!fs.existsSync(dir)) return 0;
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (!name || !name.startsWith(prefix)) continue;
      const fullPath = path.join(dir, name);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (!stat || !stat.isFile()) continue;
      const pidMatch = name.match(/\.processing\.(\d+)\./);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : NaN;
      const pidDead = Number.isFinite(pid) && pid > 0 && !isPidAlive(pid);
      const tooOld = Number.isFinite(maxAgeMs) && maxAgeMs > 0 && (now - stat.mtimeMs >= maxAgeMs);
      if (!pidDead && !tooOld) continue;

      let content = "";
      try {
        content = String(fs.readFileSync(fullPath, "utf8") || "");
      } catch {
        content = "";
      }

      const lines = content.split(/\r?\n/).filter((line) => String(line || "").trim());
      if (lines.length > 0) {
        requeueJsonlLines(pendingFile, lines);
      }
      cleanupProcessingFile(fullPath);
      recovered += 1;
    }
  } catch {
    return recovered;
  }

  return recovered;
}

function extractTaskFromBusEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  if (String(evt.event || "").trim().toLowerCase() !== "message") return null;
  let publisher = "";
  if (typeof evt.publisher === "string") {
    publisher = String(evt.publisher || "").trim();
  } else if (evt.publisher && typeof evt.publisher === "object") {
    publisher = String(evt.publisher.subscriber || evt.publisher.nickname || "").trim();
  } else {
    publisher = String(evt.publisher || "").trim();
  }
  if (publisher === "[object Object]") publisher = "";
  if (!publisher) return null;
  const data = evt.data && typeof evt.data === "object" ? evt.data : {};
  const message = typeof data.message === "string"
    ? data.message
    : (typeof data.text === "string" ? data.text : "");
  const task = String(message || "").trim();
  if (!task) return null;
  return { publisher, task };
}

function shouldAutoConsumeBus(subscriberId = "") {
  const id = String(subscriberId || "").trim().toLowerCase();
  if (!id) return false;
  return id.startsWith("ufoo-code:")
    || id.startsWith("ucode:")
    || id.startsWith("ufoo:");
}

function extractBusMessageTask(contentRaw = "") {
  const raw = String(contentRaw || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
      if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
      if (typeof parsed.prompt === "string" && parsed.prompt.trim()) return parsed.prompt.trim();
    }
  } catch {
    // treat as plain text below
  }
  return raw;
}

function busCheckOutputIndicatesPending(raw = "") {
  const text = stripAnsi(String(raw || ""));
  if (!text.trim()) return false;
  if (/no pending messages/i.test(text)) return false;
  if (/you have\s+\d+\s+pending/i.test(text)) return true;
  if (/after handling,\s*run:\s*ufoo bus ack/i.test(text)) return true;
  if (/pending event/i.test(text)) return true;
  return false;
}

function parseBusCheckOutput(raw = "") {
  const text = stripAnsi(String(raw || ""));
  if (!text.trim()) return [];
  if (/no pending messages/i.test(text)) return [];

  const lines = text.split(/\r?\n/);
  const rows = [];
  let current = null;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    const header = trimmed.match(/^@.+\s+from\s+([^\s]+)\s*$/i);
    if (header) {
      if (current && current.publisher) rows.push(current);
      current = {
        publisher: String(header[1] || "").trim(),
        content: "",
      };
      continue;
    }

    if (!current) continue;

    const contentMatch = trimmed.match(/^content:\s*(.*)$/i);
    if (contentMatch) {
      current.content = String(contentMatch[1] || "").trim();
      continue;
    }

    if (
      current.content
      && !/^(type|event|seq|target|timestamp):\s*/i.test(trimmed)
      && !trimmed.startsWith("@")
    ) {
      current.content = `${current.content}\n${trimmed}`;
    }
  }

  if (current && current.publisher) rows.push(current);

  return rows
    .map((entry) => {
      const publisher = String(entry.publisher || "").trim();
      const content = String(entry.content || "").trim();
      const task = extractBusMessageTask(content);
      if (!publisher || !task) return null;
      return {
        publisher,
        content,
        task,
      };
    })
    .filter(Boolean);
}

async function runUbusCommand(state = {}, options = {}) {
  const runtimeWorkspace = resolveUfooProjectRoot(String(
    options.workspaceRoot
      || (state && state.workspaceRoot)
      || ""
  ));
  const shell = typeof options.execShell === "function"
    ? options.execShell
    : (command) => runShellCapture(command, runtimeWorkspace);
  const runNl = typeof options.runNaturalLanguageTaskImpl === "function"
    ? options.runNaturalLanguageTaskImpl
    : runNaturalLanguageTask;
  const formatNl = typeof options.formatNlResultImpl === "function"
    ? options.formatNlResultImpl
    : formatNlResult;
  const onMessageReceived = typeof options.onMessageReceived === "function"
    ? options.onMessageReceived
    : null;

  const explicitSubscriber = String(options.subscriberId || "").trim();
  const envSubscriber = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
  let subscriberId = explicitSubscriber || envSubscriber;
  if (!subscriberId) {
    const whoami = shell("ufoo bus whoami 2>/dev/null || true");
    subscriberId = String((whoami && whoami.output) || "").trim();
  }
  if (!subscriberId) {
    const joined = shell("ufoo bus join | tail -1");
    subscriberId = String((joined && joined.output) || "").trim();
  }
  if (!subscriberId) {
    return {
      ok: false,
      summary: "",
      error: "failed to resolve bus subscriber id",
      handled: 0,
      subscriberId: "",
    };
  }

  // Prefer consuming pending.jsonl directly (stable, ANSI/wrapping-proof).
  const pendingFile = resolvePendingQueueFile(runtimeWorkspace, subscriberId);
  // Recover any stale processing files from prior crashes so they don't "black hole" messages.
  recoverStaleProcessingFiles(pendingFile, { maxAgeMs: 30000 });
  const hasPendingFile = Boolean(pendingFile && fs.existsSync(pendingFile));
  const drainedRes = hasPendingFile ? drainJsonlFile(pendingFile) : { drained: [], rawLines: [], error: "", processingFile: "" };
  if (drainedRes && drainedRes.error) {
    return {
      ok: false,
      summary: "",
      error: drainedRes.error,
      handled: 0,
      subscriberId,
    };
  }
  const rawLines = Array.isArray(drainedRes.rawLines) ? drainedRes.rawLines : [];
  const messages = rawLines
    .map((rawLine) => {
      try {
        const evt = JSON.parse(rawLine);
        const msg = extractTaskFromBusEvent(evt);
        if (!msg) return null;
        return { ...msg, rawLine };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let handled = 0;
  const sendErrors = [];
  const failedRawLines = [];
  const messageExchanges = [];

  try {
    for (const message of messages) {
      let nlResult;

      // Notify that we received the message (for immediate display)
      if (onMessageReceived) {
        onMessageReceived({
          from: message.publisher,
          task: message.task,
        });
      }

      // Create progress reporter for this message
      const progressReporter = createBusProgressReporter(shell, message.publisher);

      try {
        // Send initial acknowledgment
        shell(`ufoo bus send ${shellQuote(message.publisher)} ${shellQuote("🚀 Starting task...")}`);

        // eslint-disable-next-line no-await-in-loop
        nlResult = await runNl(message.task, state, {
          onProgress: progressReporter,
        });
      } catch (err) {
        sendErrors.push(`task from ${message.publisher} failed: ${err && err.message ? err.message : "task failed"}`);
        failedRawLines.push(message.rawLine);
        // Send error notification
        shell(`ufoo bus send ${shellQuote(message.publisher)} ${shellQuote(`❌ Error: ${err.message}`)}`);
        continue;
      }
      const reply = String(formatNl(nlResult, false) || "").replace(/\s+/g, " ").trim() || "Done.";
      const sendRes = shell(`ufoo bus send ${shellQuote(message.publisher)} ${shellQuote(reply.slice(0, 2000))}`);
      if (!sendRes.ok) {
        sendErrors.push(`reply to ${message.publisher} failed: ${sendRes.error || "send failed"}`);
        failedRawLines.push(message.rawLine);
        continue;
      }
      handled += 1;
      messageExchanges.push({
        from: message.publisher,
        task: message.task,
        reply,
      });
    }
  } finally {
    // If we drained the pending file but had failures, requeue only failed lines.
    if (failedRawLines.length > 0) {
      requeueJsonlLines(pendingFile, failedRawLines);
    }
    cleanupProcessingFile(drainedRes.processingFile);
  }

  // Fallback: if there is no pending file, fall back to CLI `bus check` parsing.
  if (!hasPendingFile) {
    const checked = shell(`ufoo bus check ${shellQuote(subscriberId)}`);
    if (!checked.ok) {
      return {
        ok: false,
        summary: "",
        error: checked.error || "ufoo bus check failed",
        handled: 0,
        subscriberId,
      };
    }
    const parsed = parseBusCheckOutput(checked.output);
    if (parsed.length === 0 && busCheckOutputIndicatesPending(checked.output)) {
      return {
        ok: false,
        summary: "",
        error: "failed to parse ufoo bus check output (pending events detected).",
        handled: 0,
        subscriberId,
      };
    }
    for (const item of parsed) {
      // Notify that we received the message (for immediate display)
      if (onMessageReceived) {
        onMessageReceived({
          from: item.publisher,
          task: item.task,
        });
      }

      const nlResult = await runNl(item.task, state);
      const reply = String(formatNl(nlResult, false) || "").replace(/\s+/g, " ").trim() || "Done.";
      const sendRes = shell(`ufoo bus send ${shellQuote(item.publisher)} ${shellQuote(reply.slice(0, 2000))}`);
      if (!sendRes.ok) {
        sendErrors.push(`reply to ${item.publisher} failed: ${sendRes.error || "send failed"}`);
        continue;
      }
      handled += 1;
      messageExchanges.push({
        from: item.publisher,
        task: item.task,
        reply,
      });
    }
  }

  if (sendErrors.length > 0) {
    return {
      ok: false,
      summary: "",
      error: sendErrors.join("; "),
      handled,
      subscriberId,
      messageExchanges,
    };
  }

  const summary = handled > 0
    ? `ubus: handled ${handled} message${handled === 1 ? "" : "s"} for ${subscriberId}.`
    : `ubus: no pending messages for ${subscriberId}.`;
  return {
    ok: true,
    summary,
    error: "",
    handled,
    subscriberId,
    messageExchanges,
  };
}

function runSingleCommand(line = "", workspaceRoot = process.cwd()) {
  const text = normalizeLine(line);
  if (!text) return { kind: "empty" };
  if (text === "exit" || text === "quit") return { kind: "exit" };
  if (text === "help") {
    return {
      kind: "help",
      output: [
        "Commands:",
        "  help",
        "  exit|quit",
        "  ubus|/ubus",
        "  resume <session-id>",
        "  tool <read|write|edit|bash> <args-json>",
        "  run <read|write|edit|bash> <args-json>",
      ].join("\n"),
    };
  }
  if (text.startsWith("$ufoo ") || text.startsWith("/ufoo ") || text.startsWith("ufoo ")) {
    return {
      kind: "probe",
      output: text.split(/\s+/).slice(1).join(" ").trim(),
    };
  }
  if (text === "ubus" || text === "/ubus") {
    return {
      kind: "ubus",
    };
  }
  const resumeMatch = text.match(/^resume(?:\s+(.+))?$/i);
  if (resumeMatch) {
    const session = String(resumeMatch[1] || "").trim();
    if (!session) {
      return {
        kind: "error",
        output: "usage: resume <session-id>",
      };
    }
    return {
      kind: "resume",
      sessionId: session,
    };
  }

  const match = text.match(/^(tool|run)\s+([a-zA-Z_-]+)\s*(.*)$/);
  if (!match) {
    return {
      kind: "nl",
      task: text,
    };
  }
  const tool = String(match[2] || "").trim().toLowerCase();
  const payload = String(match[3] || "").trim();
  let args = {};
  try {
    args = parseJson(payload);
  } catch (err) {
    return {
      kind: "error",
      output: JSON.stringify({ ok: false, error: err && err.message ? err.message : "invalid json" }),
    };
  }
  const result = runToolCall(
    { tool, args },
    { workspaceRoot, cwd: workspaceRoot }
  );
  return {
    kind: "tool",
    tool,
    args,
    result,
    output: JSON.stringify(result),
  };
}

async function runUcodeCoreAgent({
  stdin = process.stdin,
  stdout = process.stdout,
  workspaceRoot = process.cwd(),
  provider = "",
  model = "",
  appendSystemPrompt = "",
  systemPrompt = "",
  sessionId = "",
  timeoutMs = 300000,
  jsonOutput = false,
  forceTui = false,
  disableTui = false,
} = {}) {
  const resolvedWorkspaceRoot = resolveUfooProjectRoot(workspaceRoot);
  const resolvedUcode = resolveUcodeProviderModel({
    workspaceRoot: resolvedWorkspaceRoot,
    provider,
    model,
  });
  const state = {
    workspaceRoot: resolvedWorkspaceRoot,
    provider: resolvedUcode.provider,
    model: resolvedUcode.model,
    engine: "ufoo-core",
    context: buildNlContext({ appendSystemPrompt, systemPrompt }),
    nlMessages: [],
    sessionId: resolveSessionId(String(sessionId || "").trim()),
    timeoutMs,
    jsonOutput,
  };
  persistSessionState(state);

  if (shouldUseUcodeTui({
    stdin,
    stdout,
    jsonOutput,
    forceTui,
    disableTui: disableTui || process.env.UFOO_UCODE_NO_TUI === "1",
  })) {
    return runUcodeTui({
      stdin,
      stdout,
      runSingleCommand,
      runNaturalLanguageTask,
      runUbusCommand,
      formatNlResult,
      workspaceRoot,
  state,
  resumeSessionState,
  persistSessionState,
      autoBus: {
        enabled: shouldAutoConsumeBus(process.env.UFOO_SUBSCRIBER_ID || ""),
        getPendingCount: () => getPendingBusCount(state.workspaceRoot || workspaceRoot, process.env.UFOO_SUBSCRIBER_ID || ""),
        subscriberId: String(process.env.UFOO_SUBSCRIBER_ID || "").trim(),
      },
    });
  }

  printUcodeBanner(stdout, {
    model: state.model || "default",
    workspaceRoot: workspaceRoot,
    sessionId: state.sessionId,
  });
  printPrompt();
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    historySize: 200,
  });
  return new Promise((resolve) => {
    let chain = Promise.resolve();
    const subscriberId = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
    const autoBusEnabled = shouldAutoConsumeBus(subscriberId);
    let autoBusTimer = null;
    let autoBusQueued = false;
    let autoBusError = "";
    let closing = false;

    const runAutoBusOnce = async () => {
      if (!autoBusEnabled || closing) return;
      if (getPendingBusCount(state.workspaceRoot || workspaceRoot, subscriberId) <= 0) {
        autoBusError = "";
        return;
      }
      const ubusResult = await runUbusCommand(state, {
        workspaceRoot: state.workspaceRoot || workspaceRoot,
        subscriberId,
      });
      if (!ubusResult.ok) {
        const nextError = String(ubusResult.error || "ubus failed");
        if (nextError !== autoBusError) {
          autoBusError = nextError;
          stdout.write(`Error: ${nextError}\n`);
          printPrompt();
        }
        return;
      }
      autoBusError = "";
      if (ubusResult.handled > 0) {
        const persisted = persistSessionState(state);
        if (!persisted || persisted.ok === false) {
          stdout.write(`Warning: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}\n`);
          printPrompt();
        }
      }
    };

    const scheduleAutoBus = () => {
      if (!autoBusEnabled || closing || autoBusQueued) return;
      if (getPendingBusCount(state.workspaceRoot || workspaceRoot, subscriberId) <= 0) return;
      autoBusQueued = true;
      chain = chain
        .then(() => runAutoBusOnce())
        .catch(() => {})
        .finally(() => {
          autoBusQueued = false;
        });
    };

    if (autoBusEnabled) {
      autoBusTimer = setInterval(() => {
        scheduleAutoBus();
      }, 800);
      scheduleAutoBus();
    }

    const handleLine = async (line) => {
      const runtimeWorkspace = String(state.workspaceRoot || workspaceRoot || process.cwd());
      const result = runSingleCommand(line, runtimeWorkspace);
      if (result.kind === "exit") {
        rl.close();
        return;
      }
      if (result.kind === "help" || result.kind === "probe" || result.kind === "tool" || result.kind === "error") {
        stdout.write(`${result.output}\n`);
      }
      if (result.kind === "ubus") {
        const ubusResult = await runUbusCommand(state, {
          workspaceRoot: runtimeWorkspace,
          onMessageReceived: (msg) => {
            // Display the incoming message immediately
            const nickname = extractAgentNickname(msg.from) || msg.from;
            stdout.write(`${nickname}: ${msg.task}\n`);
          },
        });
        if (!ubusResult.ok) {
          stdout.write(`Error: ${ubusResult.error}\n`);
        } else {
          // Display replies for each message
          if (ubusResult.messageExchanges && ubusResult.messageExchanges.length > 0) {
            for (const exchange of ubusResult.messageExchanges) {
              const nickname = extractAgentNickname(exchange.from) || exchange.from;
              stdout.write(`@${nickname} ${exchange.reply}\n`);
            }
          } else {
            stdout.write(`${ubusResult.summary}\n`);
          }
          persistSessionState(state);
        }
      }
      if (result.kind === "resume") {
        const resumed = resumeSessionState(state, result.sessionId, workspaceRoot);
        if (!resumed.ok) {
          stdout.write(`Error: ${resumed.error}\n`);
        } else {
          stdout.write(`Resumed session ${resumed.sessionId} (${resumed.restoredMessages} messages).\n`);
        }
      }
      if (result.kind === "nl") {
        let streamBuffer = null;
        let streamedVisible = false;
        const escapeStripper = createEscapeTagStripper();
        if (!state.jsonOutput) {
          streamBuffer = new StreamBuffer(stdout.write.bind(stdout), {
            delay: 10,
            chunkSize: 4,
          });
        }

        const nlResult = await runNaturalLanguageTask(result.task, state, {
          onDelta: state.jsonOutput
            ? null
            : async (delta) => {
              const text = escapeStripper.write(String(delta || ""));
              const safeText = stripBlessedTags(stripLeakedEscapeTags(text));
              if (!safeText) return;
              if (/[^\s]/.test(safeText)) {
                streamedVisible = true;
              }
              if (streamBuffer) {
                await streamBuffer.write(safeText);
              } else {
                stdout.write(safeText);
              }
            },
        });

        if (!state.jsonOutput) {
          const tail = escapeStripper.flush();
          const safeTail = stripBlessedTags(stripLeakedEscapeTags(tail));
          if (safeTail) {
            if (/[^\s]/.test(safeTail)) {
              streamedVisible = true;
            }
            if (streamBuffer) {
              await streamBuffer.write(safeTail);
            } else {
              stdout.write(safeTail);
            }
          }
        }

        // Ensure buffer is flushed
        if (streamBuffer) {
          await streamBuffer.finish();
        }

        const streamed = !state.jsonOutput && Boolean(nlResult && nlResult.streamed);
        if (streamed && streamedVisible && nlResult && nlResult.streamLastChar !== "\n") {
          stdout.write("\n");
        }
        const shouldSkipSummary = Boolean(streamed && nlResult && nlResult.ok && streamedVisible);
        if (!shouldSkipSummary) {
          const formatted = formatNlResult(nlResult, state.jsonOutput);
          const safeOutput = state.jsonOutput
            ? formatted
            : stripBlessedTags(stripLeakedEscapeTags(formatted));
          stdout.write(`${safeOutput}\n`);
        }
        const persisted = persistSessionState(state);
        if (!state.jsonOutput && (!persisted || persisted.ok === false)) {
          stdout.write(`Warning: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}\n`);
        }
      }
      printPrompt();
    };

    rl.on("line", (line) => {
      chain = chain.then(() => handleLine(line)).catch((err) => {
        stdout.write(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : "agent loop failed" })}\n`);
        printPrompt();
      });
    });

    rl.on("close", () => {
      closing = true;
      if (autoBusTimer) {
        clearInterval(autoBusTimer);
        autoBusTimer = null;
      }
      chain.finally(() => resolve({ code: 0 }));
    });
  });
}

function parseAgentArgs(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const out = {
    workspaceRoot: "",
    provider: "",
    model: "",
    appendSystemPrompt: "",
    systemPrompt: "",
    sessionId: "",
    timeoutMs: 300000,
    jsonOutput: false,
    forceTui: false,
    disableTui: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || "").trim();
    if (!item) continue;
    if (item === "--workspace" || item === "--cwd") {
      out.workspaceRoot = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--provider") {
      out.provider = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--model") {
      out.model = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--append-system-prompt") {
      out.appendSystemPrompt = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--system-prompt") {
      out.systemPrompt = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--session-id") {
      out.sessionId = String(args[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (item === "--timeout-ms") {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed)) out.timeoutMs = Math.max(1000, Math.floor(parsed));
      i += 1;
      continue;
    }
    if (item === "--json") {
      out.jsonOutput = true;
      continue;
    }
    if (item === "--tui") {
      out.forceTui = true;
      continue;
    }
    if (item === "--no-tui") {
      out.disableTui = true;
      continue;
    }
  }
  return out;
}

module.exports = {
  runUcodeCoreAgent,
  runSingleCommand,
  runNaturalLanguageTask,
  formatNlResult,
  normalizeToolLogEvent,
  isProjectAnalysisTask,
  buildNlFallbackSummary,
  resolvePlannerProvider,
  extractJsonSummary,
  enrichNativeError,
  resolveUcodeProviderModel,
  buildSessionSnapshotFromState,
  persistSessionState,
  resumeSessionState,
  parseBusCheckOutput,
  extractBusMessageTask,
  runUbusCommand,
  stripAnsi,
  busCheckOutputIndicatesPending,
  resolvePendingQueueFile,
  extractAgentNickname,
  resolveUfooProjectRoot,
  countPendingQueueLines,
  getPendingBusCount,
  drainJsonlFile,
  extractTaskFromBusEvent,
  shouldAutoConsumeBus,
  parseAgentArgs,
};

if (require.main === module) {
  const parsed = parseAgentArgs(process.argv.slice(2));
  runUcodeCoreAgent({
    workspaceRoot: parsed.workspaceRoot || process.cwd(),
    provider: parsed.provider,
    model: parsed.model,
    appendSystemPrompt: parsed.appendSystemPrompt,
    systemPrompt: parsed.systemPrompt,
    sessionId: parsed.sessionId,
    timeoutMs: parsed.timeoutMs,
    jsonOutput: parsed.jsonOutput,
    forceTui: parsed.forceTui,
    disableTui: parsed.disableTui,
  }).then((res) => {
    process.exit(typeof res.code === "number" ? res.code : 0);
  }).catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : "ucode agent failed"}\n`);
    process.exit(1);
  });
}
