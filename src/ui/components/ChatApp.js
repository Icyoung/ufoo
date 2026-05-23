"use strict";

/**
 * Ink-based chat TUI. Behaviourally equivalent to runChatBlessed in
 * src/chat/index.js but rendered via React + ink.
 *
 * Activation: Ink is the default chat TUI. Set UFOO_TUI=blessed to use the
 * legacy blessed renderer while it remains available as a fallback.
 *
 * Coverage today: layout shell + dashboard bar (5 modes: projects, agents,
 * mode, provider, cron) + multiline editor + status line +
 * Tab/Esc focus + agent selection + Up/Down history, daemon routing,
 * command execution, completion and internal-agent views.
 *
 * Chat state is kept in chatReducer.js so the entire transition table can
 * be exercised by jest without mounting ink.
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { runInk } = require("../runInk");
const fmt = require("../format");
const { createMultilineInput } = require("./MultilineInput");
const { createDashboardBar } = require("./DashboardBar");
const { reducer, createInitialState } = require("./chatReducer");

function bootstrapEnvironment(projectRoot, options = {}) {
  // Mirror of the early section of runChatBlessed: ensure ufoo dirs exist
  // and that we have a stable subscriber ID. We deliberately keep the
  // non-UI side-effects in their own helper so unit tests can assert on
  // them without importing ink.
  const { canonicalProjectRoot } = require("../../projects");
  const { getUfooPaths } = require("../../ufoo/paths");
  const UfooInit = require("../../init");
  const { isRunning } = require("../../daemon");
  const { startDaemon } = require("../../chat/transport");

  const globalMode = options && options.globalMode === true;
  let activeProjectRoot = projectRoot;
  try {
    activeProjectRoot = canonicalProjectRoot(projectRoot);
  } catch {
    activeProjectRoot = path.resolve(projectRoot || process.cwd());
  }

  const runtimePaths = getUfooPaths(projectRoot);
  const contextIndexFile = path.join(runtimePaths.ufooDir, "context", "decisions.jsonl");
  const needsBootstrap = globalMode && (
    !fs.existsSync(runtimePaths.ufooDir)
    || !fs.existsSync(runtimePaths.busDir)
    || !fs.existsSync(runtimePaths.agentDir)
    || !fs.existsSync(contextIndexFile)
  );

  return {
    activeProjectRoot,
    globalMode,
    runtimePaths,
    needsBootstrap,
    UfooInit,
    isRunning,
    startDaemon,
  };
}

async function ensureSubscriberId(projectRoot) {
  if (process.env.UFOO_SUBSCRIBER_ID) return;
  const { getUfooPaths } = require("../../ufoo/paths");
  const sessionFile = path.join(getUfooPaths(projectRoot).ufooDir, "chat", "session-id.txt");
  const sessionDir = path.dirname(sessionFile);
  fs.mkdirSync(sessionDir, { recursive: true });
  let sessionId;
  if (fs.existsSync(sessionFile)) {
    sessionId = fs.readFileSync(sessionFile, "utf8").trim();
  } else {
    sessionId = crypto.randomBytes(4).toString("hex");
    fs.writeFileSync(sessionFile, sessionId, "utf8");
  }
  process.env.UFOO_SUBSCRIBER_ID = `claude-code:${sessionId}`;
}

function inputHistoryFilePath(projectRoot, options = {}) {
  const { getUfooPaths } = require("../../ufoo/paths");
  const { globalMode } = options || {};
  if (globalMode) {
    const os = require("os");
    const globalChatRoot = path.join(os.homedir(), ".ufoo", "chat");
    const globalDir = path.join(globalChatRoot, "global-input-history");
    const projectId = projectRootToId(projectRoot);
    return path.join(globalDir, `${projectId}.jsonl`);
  }
  return path.join(getUfooPaths(projectRoot || process.cwd()).ufooDir, "chat", "input-history.jsonl");
}

function chatHistoryFilePath(projectRoot, options = {}) {
  const { getUfooPaths } = require("../../ufoo/paths");
  const { globalMode } = options || {};
  if (globalMode) {
    const os = require("os");
    const globalChatRoot = path.join(os.homedir(), ".ufoo", "chat");
    const globalDir = path.join(globalChatRoot, "global-history");
    const projectId = projectRootToId(projectRoot);
    return path.join(globalDir, `${projectId}.jsonl`);
  }
  return path.join(getUfooPaths(projectRoot || process.cwd()).ufooDir, "chat", "history.jsonl");
}

function projectRootToId(projectRoot) {
  try {
    const { buildProjectId } = require("../../projects");
    return buildProjectId(projectRoot || process.cwd());
  } catch {
    return crypto.createHash("sha256").update(String(projectRoot || "")).digest("hex").slice(0, 16);
  }
}

function resolveInjectSockPathForAgent(projectRoot, agentId) {
  const { getUfooPaths } = require("../../ufoo/paths");
  const { subscriberToSafeName } = require("../../bus/utils");
  const safeName = subscriberToSafeName(agentId);
  return path.join(getUfooPaths(projectRoot || process.cwd()).busQueuesDir, safeName, "inject.sock");
}

function createInkMultiWindowToggle({
  getController = () => null,
  setActive = () => {},
  logMessage = () => {},
} = {}) {
  return () => {
    const controller = typeof getController === "function" ? getController() : null;
    if (!controller || typeof controller.enter !== "function" || typeof controller.exit !== "function") {
      logMessage("error", "✗ Multi-window mode is not available");
      return false;
    }

    if (typeof controller.isActive === "function" && controller.isActive()) {
      controller.exit();
      setActive(false);
      return true;
    }

    setActive(true);
    if (!controller.enter()) {
      setActive(false);
      logMessage("info", "No active agents for multi-window mode");
      return false;
    }
    return true;
  };
}

function loadChatHistory(projectRoot, cap = 200, options = {}) {
  const file = chatHistoryFilePath(projectRoot, options);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry) continue;
        if (entry.type === "spacer") {
          out.push("");
          continue;
        }
        const text = String(entry.text || "");
        if (!text) continue;
        // Strip blessed-tag markup that the legacy log writer used; ink
        // can't render those tags and we don't want them shown literally.
        const stripped = text.replace(/\{[^{}]+\}/g, "");
        out.push(stripped);
      } catch {
        // ignore malformed lines
      }
    }
    return out.slice(-cap);
  } catch {
    return [];
  }
}

function loadInputHistory(projectRoot, cap = 200, options = {}) {
  const file = inputHistoryFilePath(projectRoot, options);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const value = String((obj && obj.value) || "").trim();
        if (value) out.push(value);
      } catch {
        // ignore malformed entries
      }
    }
    return out.slice(-cap);
  } catch {
    return [];
  }
}

function appendInputHistory(projectRoot, value, options = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return;
  const file = inputHistoryFilePath(projectRoot, options);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ value: trimmed, ts: Date.now() })}\n`);
  } catch {
    // best-effort persistence; failure is not user-visible
  }
}

function appendChatHistory(projectRoot, type, text, meta = {}, options = {}) {
  const value = String(text || "");
  if (!value && type !== "spacer") return;
  const file = chatHistoryFilePath(projectRoot, options);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({
      ts: new Date().toISOString(),
      type,
      text: value,
      meta: meta && typeof meta === "object" ? meta : {},
    })}\n`);
  } catch {
    // best-effort persistence; failure is not user-visible
  }
}

function chatHistoryOptionsForScope({ globalMode = false, globalScope = "controller" } = {}) {
  return {
    globalMode: Boolean(globalMode && globalScope !== "project"),
  };
}

function getAgentLabelFor(meta, agentId) {
  // Prefer the project-stripped display nickname so the dashboard never shows
  // the scoped form ("neptune-builder"); fall back to the raw nickname (which
  // may itself be unscoped depending on write path) and finally to a short
  // form of the subscriber id.
  if (meta && meta.display_nickname) return meta.display_nickname;
  if (meta && meta.nickname) return meta.nickname;
  if (!agentId) return "";
  const colon = agentId.indexOf(":");
  if (colon < 0) return agentId;
  const head = agentId.slice(0, colon);
  const tail = agentId.slice(colon + 1).slice(0, 6);
  return tail ? `${head}:${tail}` : head;
}

function buildActiveAgentLabelMap(activeAgents = [], activeAgentMeta = new Map()) {
  const out = new Map();
  const metaMap = activeAgentMeta instanceof Map ? activeAgentMeta : new Map();
  for (const id of Array.isArray(activeAgents) ? activeAgents : []) {
    out.set(id, getAgentLabelFor(metaMap.get(id), id));
  }
  return out;
}

function resolveActiveAgentId(label, activeAgents = [], activeAgentMeta = new Map()) {
  const { resolveAgentId } = require("../../chat/agentDirectory");
  const metaMap = activeAgentMeta instanceof Map ? activeAgentMeta : new Map();
  return resolveAgentId({
    label,
    activeAgents: Array.isArray(activeAgents) ? activeAgents : [],
    labelMap: buildActiveAgentLabelMap(activeAgents, metaMap),
    lookupNickname: (nickname) => {
      for (const [id, meta] of metaMap.entries()) {
        if (!meta) continue;
        if (meta.nickname === nickname || meta.scoped_nickname === nickname || meta.display_nickname === nickname) {
          return id;
        }
      }
      return null;
    },
  });
}

function buildDirectBusSendRequest({
  text,
  targetAgentId = null,
  activeAgents = [],
  activeAgentMeta = new Map(),
} = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (targetAgentId) {
    return {
      target: targetAgentId,
      message: trimmed,
      source: "chat-direct",
    };
  }

  const { parseAtTarget } = require("../../chat/commands");
  const atTarget = parseAtTarget(trimmed);
  if (!atTarget || !atTarget.message) return null;
  const target = resolveActiveAgentId(atTarget.target, activeAgents, activeAgentMeta) || atTarget.target;
  return {
    target,
    message: atTarget.message.trim(),
    source: "chat-direct",
  };
}

function resolveAgentEnterRequest({
  agentId,
  projectRoot = "",
  activeAgentMeta = new Map(),
  settings = {},
} = {}) {
  const id = String(agentId || "").trim();
  if (!id) return null;

  const metaMap = activeAgentMeta instanceof Map ? activeAgentMeta : new Map();
  const meta = metaMap.get(id) || {};
  const configuredLaunchMode = settings && settings.launchMode && settings.launchMode !== "auto"
    ? settings.launchMode
    : "";
  const launchMode = String(meta.launch_mode || meta.launchMode || configuredLaunchMode || "").trim();
  const { createTerminalAdapterRouter } = require("../../terminal/adapterRouter");
  const adapter = createTerminalAdapterRouter().getAdapter({ launchMode, agentId: id, meta });
  const caps = adapter && adapter.capabilities ? adapter.capabilities : {};

  return {
    agentId: id,
    projectRoot: String(projectRoot || ""),
    launchMode,
    useBus: Boolean(caps.supportsInternalQueueLoop && !caps.supportsSocketProtocol),
    supportsSocket: Boolean(caps.supportsSocketProtocol),
    supportsInternalQueue: Boolean(caps.supportsInternalQueueLoop),
    supportsActivate: Boolean(caps.supportsActivate),
  };
}

function resolveDashboardAgentEnterAction(enterRequest = {}) {
  if (!enterRequest || typeof enterRequest !== "object") return "none";
  if (enterRequest.useBus) return "internal";
  if (enterRequest.supportsActivate) return "activate";
  return "agent-view";
}

function buildEmptyProjectsDownActions(state = {}, displayAgents = []) {
  if (!state.emptyProjectsDownArmed) {
    return [{ type: "projects/armEmptyDown" }];
  }
  const actions = [{ type: "view/set", view: "agents" }];
  if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
    actions.push({ type: "agents/select", index: 0 });
  }
  return actions;
}

function buildPromptIpcRequest(text) {
  const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
  return {
    type: IPC_REQUEST_TYPES.PROMPT,
    text,
    request_meta: {
      source: "chat-dialog",
      dispatch_default_injection_mode: "immediate",
      allow_relevance_queue: true,
    },
  };
}

function stripBlessedTags(text = "") {
  return String(text || "")
    .replace(/\{\/?[^{}\n]+\}/g, "")
    .replace(/\r/g, "");
}

function normalizeInkLogLines(text = "") {
  const clean = stripBlessedTags(text);
  return clean.split(/\r?\n/);
}

function stripMarkdownDecorators(text = "") {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function classifyChatLogLine(text = "") {
  const raw = stripBlessedTags(text).replace(/\r/g, "");
  const clean = stripMarkdownDecorators(raw);
  const trimmed = clean.trim();
  if (!trimmed) return { kind: "spacer", marker: " ", speaker: "", body: " " };
  if (/^[█▀▄ ]+$/.test(trimmed) || /^ufoo chat/i.test(trimmed)) {
    return { kind: "banner", marker: " ", speaker: "", body: clean };
  }
  if (/^───.*───$/.test(trimmed)) {
    return { kind: "divider", marker: "─", speaker: "", body: clean };
  }
  if (/^(error:|✗|failed\b)/i.test(trimmed)) {
    return { kind: "error", marker: "!", speaker: "error", body: clean.replace(/^(error:\s*)/i, "") };
  }
  if (/^(✓|✔|done\b|closed\b)/i.test(trimmed)) {
    return { kind: "success", marker: "✓", speaker: "", body: clean.replace(/^[✓✔]\s*/, "") };
  }
  const dotMatch = clean.match(/^([^·:\n]{1,42})\s+·\s+(.*)$/);
  if (dotMatch) {
    const speaker = dotMatch[1].trim();
    const lower = speaker.toLowerCase();
    const kind = lower === "ufoo" ? "assistant" : "agent";
    return { kind, marker: kind === "assistant" ? "◆" : "●", speaker, body: dotMatch[2] || " " };
  }
  const colonMatch = clean.match(/^([A-Za-z0-9_.:@/-]{1,42}):\s+(.*)$/);
  if (colonMatch) {
    return { kind: "agent", marker: "●", speaker: colonMatch[1], body: colonMatch[2] || " " };
  }
  if (/^(CHAT|UCODE)\s+·/i.test(trimmed)) {
    return { kind: "meta", marker: "·", speaker: "", body: clean };
  }
  return { kind: "plain", marker: "│", speaker: "", body: clean };
}

function createInkStreamState({
  dispatch,
  appendHistory,
  displayNameForPublisher = (value) => value,
} = {}) {
  const streams = new Map();
  const pendingDeliveries = new Map();

  function deliveryKey(agentId, agentLabel) {
    return String(agentId || agentLabel || "").trim();
  }

  function markPendingDelivery(agentId, agentLabel) {
    const key = deliveryKey(agentId, agentLabel);
    if (!key) return;
    const existing = pendingDeliveries.get(key) || { count: 0, keys: new Set() };
    existing.count += 1;
    for (const candidate of [agentId, agentLabel]) {
      const value = String(candidate || "").trim();
      if (value) {
        pendingDeliveries.set(value, existing);
        existing.keys.add(value);
      }
    }
  }

  function getPendingState(publisher, displayName) {
    for (const candidate of [publisher, displayName]) {
      const key = String(candidate || "").trim();
      if (key && pendingDeliveries.has(key)) {
        return { key, state: pendingDeliveries.get(key) };
      }
    }
    return null;
  }

  function consumePendingDelivery(publisher, displayName) {
    const hit = getPendingState(publisher, displayName);
    if (!hit) return false;
    hit.state.count -= 1;
    if (hit.state.count <= 0) {
      for (const key of hit.state.keys || []) pendingDeliveries.delete(key);
    }
    return true;
  }

  function beginStream(publisher, prefix, continuationPrefix, meta) {
    const key = String(publisher || "bus");
    let state = streams.get(key);
    if (state) return state;
    const displayName = stripBlessedTags(prefix || displayNameForPublisher(key) || key)
      .replace(/\s*·\s*$/, "")
      .trim() || displayNameForPublisher(key) || key;
    state = {
      publisher: key,
      displayName,
      prefix,
      continuationPrefix,
      full: "",
      meta: meta || {},
    };
    streams.set(key, state);
    dispatch({ type: "stream/begin", publisher: displayName });
    return state;
  }

  function appendStreamDelta(state, delta) {
    if (!state || !delta) return;
    state.full += String(delta || "");
    dispatch({ type: "stream/delta", publisher: state.displayName || state.publisher, delta: String(delta || "") });
  }

  function finalizeStream(publisher, meta, reason = "") {
    const key = String(publisher || "bus");
    const state = streams.get(key);
    if (!state) return;
    dispatch({ type: "stream/end" });
    if (typeof appendHistory === "function") {
      const text = state.displayName
        ? `${state.displayName}: ${state.full}`
        : state.full;
      appendHistory("bus", text, { ...(meta || state.meta || {}), stream_done: true, stream_reason: reason });
    }
    streams.delete(key);
  }

  function hasStream(publisher) {
    return streams.has(String(publisher || "bus"));
  }

  return {
    markPendingDelivery,
    getPendingState,
    consumePendingDelivery,
    beginStream,
    appendStreamDelta,
    finalizeStream,
    hasStream,
  };
}

function formatShellCommandResultLines(result = {}) {
  const lines = [];
  const stdout = String(result.stdout || "").trimEnd();
  const stderr = String(result.stderr || "").trimEnd();
  if (stdout) lines.push(...stdout.split(/\r?\n/).map((line) => ({ type: "system", text: line })));
  if (stderr) lines.push(...stderr.split(/\r?\n/).map((line) => ({ type: result.ok ? "system" : "error", text: line })));
  if (!stdout && !stderr) lines.push({ type: "system", text: "(no output)" });
  if (!result.ok) {
    const suffix = result.signal ? ` signal ${result.signal}` : ` exit ${result.code != null ? result.code : 1}`;
    lines.push({ type: "error", text: `Command failed:${suffix}` });
  }
  return lines;
}

function fitPlainLine(text = "", width = 80) {
  const limit = Math.max(1, Math.floor(Number(width) || 80));
  const raw = String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  let out = "";
  let cells = 0;
  for (const char of Array.from(raw)) {
    const charWidth = fmt.charDisplayWidth(char);
    if (cells + charWidth > limit) break;
    out += char;
    cells += charWidth;
  }
  if (out.length < raw.length && limit > 1) {
    while (fmt.displayCellWidth(out) > limit - 1) {
      out = Array.from(out).slice(0, -1).join("");
    }
    out = `${out}…`;
  }
  return out || " ";
}

function stripInternalLogMarkup(text = "") {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\{\/?[^{}\n]+\}/g, "");
}

function wrapInternalPlainLine(text = "", width = 80) {
  const limit = Math.max(1, Math.floor(Number(width) || 80));
  const clean = stripInternalLogMarkup(text).replace(/\r/g, "");
  if (!clean) return [""];
  const rows = [];
  let row = "";
  let cells = 0;
  for (const char of Array.from(clean)) {
    const charWidth = fmt.charDisplayWidth(char);
    if (cells > 0 && cells + charWidth > limit) {
      rows.push(row);
      row = "";
      cells = 0;
    }
    row += char;
    cells += charWidth;
  }
  rows.push(row);
  return rows;
}

function classifyInternalLogLine(line = "") {
  const raw = stripInternalLogMarkup(line).replace(/\r/g, "");
  if (!raw) return { kind: "spacer", text: "", markdown: false, bold: false };
  if (raw.startsWith("> ")) return { kind: "user", text: raw.slice(2), markdown: false, bold: false };
  if (raw.startsWith("* ")) return { kind: "agent", text: raw.slice(2), markdown: true, bold: false };
  if (/^error:/i.test(raw) || /^\[error\]/i.test(raw)) {
    return { kind: "error", text: raw, markdown: true, bold: false };
  }
  if (/^ufoo internal agent\b/i.test(raw)) {
    return { kind: "system", text: raw, markdown: false, bold: true };
  }
  if (/^(agent|directory):/i.test(raw)) {
    return { kind: "meta", text: raw, markdown: false, bold: false };
  }
  return { kind: "agent", text: raw, markdown: true, bold: false };
}

function internalLogPrefixes(kind) {
  if (kind === "user") return { first: "› ", rest: "  " };
  if (kind === "system") return { first: "· ", rest: "  " };
  if (kind === "meta") return { first: "  ", rest: "  " };
  return { first: "", rest: "" };
}

function buildInternalLogRows(lines = [], width = 80, maxRows = 20) {
  const limit = Math.max(1, Math.floor(Number(width) || 80));
  const rows = [];
  const markdownState = {};
  const source = Array.isArray(lines) ? lines : [];
  for (const line of source) {
    const classified = classifyInternalLogLine(line);
    if (classified.kind === "spacer") {
      rows.push({ kind: "spacer", text: " ", bold: false });
      continue;
    }

    let rendered = [classified.text];
    if (classified.markdown) {
      try {
        rendered = fmt.renderLogLinesWithMarkdown(classified.text, markdownState, (value) => String(value || ""))
          .map(stripInternalLogMarkup);
      } catch {
        rendered = [classified.text];
      }
    }

    const prefixes = internalLogPrefixes(classified.kind);
    for (const renderedLine of rendered) {
      const chunks = wrapInternalPlainLine(
        renderedLine,
        Math.max(1, limit - fmt.displayCellWidth(prefixes.first)),
      );
      chunks.forEach((chunk, idx) => {
        const prefix = idx === 0 ? prefixes.first : prefixes.rest;
        rows.push({
          kind: classified.kind,
          text: fitPlainLine(`${prefix}${chunk}`, limit),
          bold: classified.bold,
        });
      });
    }
  }
  return rows.slice(-Math.max(1, Math.floor(Number(maxRows) || 20)));
}

function internalInputBoundaries(text = "") {
  const source = String(text || "");
  if (!source) return [0];
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const boundaries = [0];
      for (const part of segmenter.segment(source)) {
        boundaries.push(part.index + part.segment.length);
      }
      return Array.from(new Set(boundaries)).sort((a, b) => a - b);
    }
  } catch {
    // Fall through.
  }
  const boundaries = [0];
  let offset = 0;
  for (const char of Array.from(source)) {
    offset += char.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function previousInternalBoundary(text = "", cursor = 0) {
  const target = Math.max(0, Math.min(String(text || "").length, cursor));
  let previous = 0;
  for (const boundary of internalInputBoundaries(text)) {
    if (boundary < target) previous = boundary;
    else break;
  }
  return previous;
}

function nextInternalBoundary(text = "", cursor = 0) {
  const source = String(text || "");
  const target = Math.max(0, Math.min(source.length, cursor));
  for (const boundary of internalInputBoundaries(source)) {
    if (boundary > target) return boundary;
  }
  return source.length;
}

function resolveInternalKeyName(input = "", key = {}) {
  const raw = String(input || "");
  if (raw === "\x7f" || raw === "\b" || raw === "\x08") return "backspace";
  if (raw === "\x1b[3~" || raw === "\u001b[3~") return "delete";
  if (key && key.backspace) return "backspace";
  if (key && key.delete) return "backspace";
  if (key && key.name === "backspace") return "backspace";
  if (key && key.name === "delete") return "backspace";
  if (key && key.name) return String(key.name);
  if (key && key.escape) return "escape";
  if (key && key.return) return "return";
  if (key && key.leftArrow) return "left";
  if (key && key.rightArrow) return "right";
  if (key && key.upArrow) return "up";
  if (key && key.downArrow) return "down";
  if (key && key.ctrl && raw.length === 1) return raw.toLowerCase();
  return "";
}

function isInternalViewingAgent(agentId, meta, view = {}, viewingAgentId = "") {
  const id = String(agentId || "").trim();
  if (!id) return false;
  const candidates = new Set([
    viewingAgentId,
    view && view.agentId,
    view && view.label,
    ...((view && Array.isArray(view.aliases)) ? view.aliases : []),
  ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean));
  if (candidates.has(id)) return true;
  const metaIds = [
    meta && meta.fullId,
    meta && meta.agent_id,
    meta && meta.subscriber_id,
    meta && meta.nickname,
    meta && meta.scoped_nickname,
    meta && meta.display_nickname,
    meta && meta.type && meta.id ? `${meta.type}:${meta.id}` : "",
    getAgentLabelFor(meta, id),
  ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
  return metaIds.some((value) => candidates.has(value));
}

function compactDisplayProjectRoot(projectRoot = "") {
  const os = require("os");
  const raw = String(projectRoot || process.cwd() || "").trim();
  const home = os.homedir();
  if (home && (raw === home || raw.startsWith(`${home}/`))) return `~${raw.slice(home.length)}`;
  return raw || ".";
}

function buildInternalAgentStartupLines({ agentId = "", label = "", projectRoot = "", width = 80 } = {}) {
  return [
    fitPlainLine(`ufoo internal agent · ${label || agentId}`, width),
    fitPlainLine(`agent: ${agentId}`, width),
    fitPlainLine(`directory: ${compactDisplayProjectRoot(projectRoot)}`, width),
    "",
  ];
}

function createInternalAgentViewState({
  agentId,
  label,
  aliases = [],
  projectRoot,
  width = 80,
} = {}) {
  let history = [];
  try {
    const { loadInternalAgentLogHistory } = require("../../chat/internalAgentLogHistory");
    history = loadInternalAgentLogHistory(projectRoot || process.cwd(), agentId, {
      maxEvents: 400,
      maxLines: 1000,
    });
  } catch {
    history = [];
  }
  const safeAliases = [agentId, label].concat(aliases || []).filter(Boolean).map(String);
  return {
    agentId: String(agentId || ""),
    label: String(label || agentId || ""),
    aliases: Array.from(new Set(safeAliases)),
    projectRoot: String(projectRoot || ""),
    lines: buildInternalAgentStartupLines({ agentId, label, projectRoot, width })
      .concat(history.length > 0 ? history : [""]),
    input: "",
    cursor: 0,
    status: "ready",
    detail: "",
    statusStartedAt: 0,
    barIndex: 0,
  };
}

function appendInternalAgentText(view, text = "", options = {}) {
  const current = view && typeof view === "object" ? view : {};
  const lines = Array.isArray(current.lines) ? current.lines.slice() : [];
  if (lines.length === 0) lines.push("");
  const prefix = options.prefix || "";
  const clean = String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (prefix && lines[lines.length - 1] !== "") lines.push("");
  if (prefix && lines[lines.length - 1] === "") lines[lines.length - 1] = prefix;
  for (const char of clean) {
    if (char === "\n") {
      lines.push("");
    } else {
      lines[lines.length - 1] += char;
    }
  }
  return {
    ...current,
    lines: lines.slice(-1000),
  };
}

function parseInternalBusPayload(raw = "") {
  let displayMessage = String(raw || "");
  let streamPayload = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.reply) {
      displayMessage = parsed.reply;
    } else if (parsed && typeof parsed === "object" && parsed.stream) {
      streamPayload = parsed;
    }
  } catch {
    // Plain text.
  }
  return {
    displayMessage: String(displayMessage || "").replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n"),
    streamPayload,
  };
}

function internalStatusLabel(value = "") {
  const state = String(value || "").trim().toLowerCase();
  if (state === "waiting" || state === "waiting_input") return "waiting";
  if (state === "blocked" || state === "error") return "blocked";
  if (state === "busy" || state === "processing" || state === "working") return "working";
  if (state === "idle" || state === "ready") return "ready";
  return state || "ready";
}

function updateInternalViewStatus(view = {}, status = "", detail = "", now = Date.now()) {
  const current = view && typeof view === "object" ? view : {};
  const nextStatus = internalStatusLabel(status || current.status || "");
  const nextDetail = String(detail || "").trim();
  const timed = nextStatus === "working" || nextStatus === "waiting" || nextStatus === "blocked";
  const previousStartedAt = Number.isFinite(current.statusStartedAt) ? current.statusStartedAt : 0;
  const statusStartedAt = timed
    ? (current.status === nextStatus && previousStartedAt ? previousStartedAt : now)
    : 0;
  return {
    ...current,
    status: nextStatus,
    detail: nextDetail,
    statusStartedAt,
  };
}

function applyInternalAgentTermWrite(view = {}, activeAgentId = "", text = "", meta = {}) {
  const current = view && typeof view === "object" ? view : {};
  if (!current.agentId || current.agentId !== activeAgentId) return current;
  const streamPayload = meta && meta.streamPayload && typeof meta.streamPayload === "object"
    ? meta.streamPayload
    : {};
  const done = Boolean((meta && meta.done) || streamPayload.done);
  const rawText = String(text || "");
  const next = rawText
    ? appendInternalAgentText(current, rawText, { prefix: "* " })
    : current;
  if (done) return updateInternalViewStatus(next, "ready", "");
  return updateInternalViewStatus(next, "working", "");
}

function appendInternalErrorToView(view = {}, activeAgentId = "", message = "") {
  const current = view && typeof view === "object" ? view : {};
  if (!current.agentId || current.agentId !== activeAgentId) return current;
  const detail = String(message || "unknown error");
  const lines = Array.isArray(current.lines) ? current.lines : [];
  const separator = lines.length > 0 && lines[lines.length - 1] ? "\n" : "";
  return appendInternalAgentText(
    updateInternalViewStatus(current, "blocked", detail),
    `${separator}Error: ${detail}\n`,
  );
}

function computeInternalStatusText(view = {}, spinnerTick = 0, now = Date.now()) {
  const current = view && typeof view === "object" ? view : {};
  const status = internalStatusLabel(current.status || "");
  const label = String(current.label || current.agentId || "agent").trim();
  const detail = String(current.detail || "").trim();
  if (status === "ready") {
    return `ufoo · ${label} · Ready · Enter send · Esc back`;
  }
  const type = status === "waiting" ? "waiting" : "thinking";
  const indicators = fmt.STATUS_INDICATORS[type] || fmt.STATUS_INDICATORS.thinking;
  const indicator = status === "blocked"
    ? "!"
    : indicators[Math.max(0, Math.floor(Number(spinnerTick) || 0)) % indicators.length];
  const message = status === "waiting"
    ? "Waiting for input"
    : (status === "blocked" ? "Blocked" : "Working");
  const startedAt = Number.isFinite(current.statusStartedAt) ? current.statusStartedAt : 0;
  const timer = startedAt ? ` (${fmt.formatPendingElapsed(now - startedAt)})` : "";
  return `${indicator} ${label} · ${message}${detail ? ` · ${detail}` : ""}${timer} · Esc back`;
}

const CHAT_BANNER_LINES = [
  "█ █ █▀▀ █▀█ █▀▄   █▀▀ █ █ ▄▀█ ▀█▀",
  "█ █ █   █ █ █ █   █   █▀█ █▀█  █ ",
  "▀▀▀ ▀▀▀ ▀▀▀ ▀▀    ▀▀▀ ▀ ▀ ▀ ▀  ▀ ",
];

function buildChatBannerLines(props, version) {
  const os = require("os");
  const home = os.homedir();
  const root = props.activeProjectRoot || process.cwd();
  const shortRoot = root.startsWith(home) ? root.replace(home, "~") : root;
  const modeLabel = props.globalMode
    ? `global (${props.globalScope || "controller"})`
    : "project";
  const padding = " ".repeat(
    CHAT_BANNER_LINES.reduce((max, line) => Math.max(max, line.length), 0)
  );
  const info = [
    `Version: ${version}`,
    `Mode: ${modeLabel}`,
    `Dictionary: ${shortRoot}`,
  ];
  const rows = Math.max(CHAT_BANNER_LINES.length, info.length);
  const out = [];
  for (let i = 0; i < rows; i += 1) {
    const left = CHAT_BANNER_LINES[i] || padding;
    const right = info[i] || "";
    out.push(`  ${left}  ${right}`);
  }
  return out;
}

function resolveProjectRowRoot(row = {}) {
  const raw = String((row && (row.root || row.project_root)) || "").trim();
  if (!raw) return "";
  try {
    const { canonicalProjectRoot } = require("../../projects");
    return canonicalProjectRoot(raw);
  } catch {
    return path.resolve(raw);
  }
}

function loadGlobalProjectRows(activeProjectRoot = "") {
  const {
    listProjectRuntimes,
    filterVisibleProjectRuntimes,
    isGlobalControllerProjectRoot,
    markProjectStopped,
  } = require("../../projects");
  let rows = listProjectRuntimes({ validate: true, cleanupTmp: true }) || [];
  for (const row of rows) {
    const status = String((row && row.status) || "").trim().toLowerCase();
    const root = resolveProjectRowRoot(row);
    if (status === "stale" && root && !isGlobalControllerProjectRoot(root)) {
      try { markProjectStopped(root); } catch { /* ignore stale cleanup failures */ }
    }
  }
  rows = filterVisibleProjectRuntimes(rows);
  rows = rows.filter((row) => !isGlobalControllerProjectRoot(resolveProjectRowRoot(row)));
  return rows.map((row) => ({
    id: row.project_id || row.project_root || "",
    label: row.project_name || (row.project_root ? path.basename(row.project_root) : ""),
    root: row.project_root || "",
    status: row.status || "",
    active: resolveProjectRowRoot(row) === String(activeProjectRoot || ""),
  }));
}

function readProjectAgentSnapshot(projectRoot = "") {
  if (!projectRoot) return { agents: [], metaMap: new Map() };
  try {
    const { buildStatus } = require("../../daemon/status");
    const { buildAgentMaps } = require("../../chat/agentDirectory");
    const status = buildStatus(projectRoot);
    const activeIds = Array.isArray(status.active) ? status.active : [];
    const metaList = Array.isArray(status.active_meta) ? status.active_meta : [];
    const { labelMap, metaMap } = buildAgentMaps(activeIds, metaList);
    const merged = new Map();
    for (const id of activeIds) {
      const meta = metaMap.get(id) || {};
      const colon = id.indexOf(":");
      const fallbackType = colon > 0 ? id.slice(0, colon) : id;
      const fallbackId = colon > 0 ? id.slice(colon + 1) : "";
      merged.set(id, {
        ...meta,
        fullId: id,
        type: meta.type || fallbackType,
        id: meta.id || fallbackId,
        nickname: labelMap.get(id) || id,
      });
    }
    return { agents: activeIds, metaMap: merged };
  } catch {
    return { agents: [], metaMap: new Map() };
  }
}

function isCJK(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0x20000 && code <= 0x2fa1f);
}

function inferStatusType(text = "", requestedType = "") {
  const type = String(requestedType || "").trim().toLowerCase();
  if (type === "done" || type === "success" || type === "error" || type === "idle") return type;
  const clean = stripBlessedTags(String(text || "")).trim();
  if (/^[✓✔]/.test(clean) || /\bdone\b/i.test(clean) || /\bprocessed\b/i.test(clean)) return "done";
  if (/^[✗!]/.test(clean) || /\berror\b/i.test(clean) || /\bfailed\b/i.test(clean)) return "error";
  return type || "typing";
}

function isAnimatedStatusType(type = "") {
  const value = String(type || "").trim().toLowerCase();
  return value !== "done" && value !== "success" && value !== "error" && value !== "idle" && value !== "none";
}

function inkKeyToRaw(input, key) {
  if (key.ctrl && input) {
    const code = input.charCodeAt(0) - 96;
    if (code >= 1 && code <= 26) return String.fromCharCode(code);
    return "";
  }
  if (key.return) return "\r";
  if (key.escape) return "\x1b";
  if (key.backspace || key.delete) return "\x7f";
  if (key.tab) return "\t";
  if (key.upArrow) return "\x1b[A";
  if (key.downArrow) return "\x1b[B";
  if (key.rightArrow) return "\x1b[C";
  if (key.leftArrow) return "\x1b[D";
  if (input && !key.meta) return input;
  if (key.meta && input) return `\x1b${input}`;
  return "";
}

function createChatApp({ React, ink, props, interactive = true }) {
  const { useReducer, useEffect, useState, useCallback, useRef } = React;
  const { Box, Text, Static, useInput, useApp, useStdout } = ink;
  const h = React.createElement;
  const MultilineInput = createMultilineInput({ React, ink });
  const DashboardBar = createDashboardBar({ React, ink });

  // Build the initial log: chat history if there is any, otherwise an
  // ASCII banner with project / mode / version info. We resolve history
  // synchronously here so the very first paint already shows it instead
  // of rendering an empty banner and then flashing in the lines.
  const versionLabel = String(fmt.UCODE_VERSION || "");
  const banner = buildChatBannerLines(props, versionLabel);
  const persistedHistory = loadChatHistory(props.projectRoot, 200, { globalMode: props.globalMode });
  const initialLogText = persistedHistory.length > 0
    ? banner.concat(["", "─── history ───"]).concat(persistedHistory).concat([""])
    : banner.concat([""]);

  return function ChatApp() {
    const [state, dispatch] = useReducer(
      reducer,
      undefined,
      () => createInitialState({
        banner: initialLogText,
        globalMode: props.globalMode,
        globalScope: props.globalScope || "controller",
        settings: props.initialSettings || {},
      })
    );
    const [size, setSize] = useState({ cols: 0, rows: 0 });
    const [spinnerTick, setSpinnerTick] = useState(0);
    const [currentProjectRoot, setCurrentProjectRoot] = useState(props.activeProjectRoot || props.projectRoot || "");
    const [internalAgentView, setInternalAgentView] = useState(() => createInternalAgentViewState());
    const [multiWindowActive, setMultiWindowActive] = useState(false);
    const [mwCursor, setMwCursor] = useState(0);
    const [mwTerminalFocused, setMwTerminalFocused] = useState(false);
    const mwTerminalFocusedRef = useRef(false);
    const mwLastInputRef = useRef({ char: "", time: 0 });
    const stateRef = useRef(state);
    const sizeRef = useRef(size);
    const currentProjectRootRef = useRef(currentProjectRoot);
    const internalAgentViewRef = useRef(internalAgentView);
    const multiWindowControllerRef = useRef(null);
    const multiWindowChromeRef = useRef({ statusText: "", promptPrefix: "› ", draft: "", dashboardLines: [] });
    const multiWindowWatchedInternalAgentsRef = useRef(new Set());
    const pendingRef = useRef(null);
    const streamStateRef = useRef(null);
    const historyScopeRef = useRef(null);
    const switchToProjectRootRef = useRef(null);
    const activeChatHistoryRoot = currentProjectRoot || props.projectRoot;
    const activeChatHistoryOptions = chatHistoryOptionsForScope({
      globalMode: props.globalMode,
      globalScope: state.globalScope,
    });
    const { exit } = useApp();
    const { stdout } = useStdout();

    useEffect(() => {
      stateRef.current = state;
    }, [state]);

    useEffect(() => {
      sizeRef.current = size;
    }, [size]);

    useEffect(() => {
      currentProjectRootRef.current = currentProjectRoot;
    }, [currentProjectRoot]);

    historyScopeRef.current = {
      root: activeChatHistoryRoot,
      options: activeChatHistoryOptions,
    };

    const appendScopedHistory = useCallback((kind, text, meta = {}) => {
      appendChatHistory(activeChatHistoryRoot, kind, text, meta, activeChatHistoryOptions);
    }, [activeChatHistoryRoot, activeChatHistoryOptions.globalMode]);

    const setStatusText = useCallback((text, options = {}) => {
      const clean = stripBlessedTags(text).trim();
      if (!clean) {
        dispatch({ type: "status/idle" });
        return;
      }
      dispatch({
        type: "status/set",
        payload: {
          message: clean,
          type: inferStatusType(clean, options.type || "typing"),
          showTimer: options.showTimer === true,
          startedAt: options.startedAt || Date.now(),
        },
      });
    }, []);

    const logInkMessage = useCallback((kind, text, meta = {}) => {
      const type = String(kind || "system");
      if (type === "status") {
        setStatusText(text);
        return;
      }
      const lines = normalizeInkLogLines(text);
      if (lines.length === 0) return;
      dispatch({ type: "log/appendMany", lines });
      appendScopedHistory(type, stripBlessedTags(text), meta);
    }, [appendScopedHistory, setStatusText]);

    if (!streamStateRef.current) {
      streamStateRef.current = createInkStreamState({
        dispatch,
        appendHistory: (kind, text, meta = {}) => {
          const scope = historyScopeRef.current || {};
          appendChatHistory(scope.root || props.projectRoot, kind, text, meta, scope.options || {});
        },
        displayNameForPublisher: (publisher) => {
          const current = stateRef.current || {};
          const meta = current.activeAgentMeta instanceof Map ? current.activeAgentMeta.get(publisher) : null;
          return getAgentLabelFor(meta, publisher);
        },
      });
    }

    const getMultiWindowController = useCallback(() => {
      if (multiWindowControllerRef.current) return multiWindowControllerRef.current;
      const processStdout = stdout || (typeof process !== "undefined" ? process.stdout : null);
      if (!processStdout || typeof processStdout.write !== "function") return null;

      const originalWrite = processStdout.write.bind(processStdout);
      const { createMultiWindowController } = require("../../chat/multiWindow");
      multiWindowControllerRef.current = createMultiWindowController({
        processStdout: { write: originalWrite, rows: processStdout.rows, columns: processStdout.columns },
        getRows: () => {
          const currentSize = sizeRef.current || {};
          return currentSize.rows || processStdout.rows || 24;
        },
        getCols: () => {
          const currentSize = sizeRef.current || {};
          return currentSize.cols || processStdout.columns || 80;
        },
        getInjectSockPath: (agentId) =>
          resolveInjectSockPathForAgent(currentProjectRootRef.current || props.projectRoot, agentId),
        getActiveAgents: () => {
          const current = stateRef.current || {};
          return Array.isArray(current.agents) ? current.agents : [];
        },
        getAgentPaneOptions: (agentId) => {
          const current = stateRef.current || {};
          const enterRequest = resolveAgentEnterRequest({
            agentId,
            projectRoot: currentProjectRootRef.current || props.projectRoot,
            activeAgentMeta: current.activeAgentMeta,
            settings: current.settings,
          });
          if (!enterRequest || !enterRequest.useBus) return { mode: "socket" };
          const metaMap = current.activeAgentMeta instanceof Map ? current.activeAgentMeta : new Map();
          const agentMeta = metaMap.get(agentId) || {};
          let initialLines = [];
          try {
            const { loadInternalAgentLogHistory } = require("../../chat/internalAgentLogHistory");
            initialLines = loadInternalAgentLogHistory(currentProjectRootRef.current || props.projectRoot, agentId, {
              maxEvents: 200,
              maxLines: 200,
            });
          } catch { initialLines = []; }
          return {
            mode: "internal",
            initialLines: [
              `ufoo internal agent · ${getAgentLabelFor(agentMeta, agentId)}`,
              `agent: ${agentId}`,
              "",
              ...initialLines,
            ],
          };
        },
        getChatLogLines: () => {
          const current = stateRef.current || {};
          return Array.isArray(current.logLines)
            ? current.logLines.map((item) => String((item && item.text) || ""))
            : [];
        },
        getStatusText: () => {
          const chrome = multiWindowChromeRef.current;
          return chrome ? chrome.statusText : "";
        },
        getPromptPrefix: () => {
          const chrome = multiWindowChromeRef.current;
          return chrome ? chrome.promptPrefix : "› ";
        },
        getCurrentDraft: () => {
          const chrome = multiWindowChromeRef.current;
          return chrome ? chrome.draft : "";
        },
        getCursorPos: () => {
          const chrome = multiWindowChromeRef.current;
          return chrome ? chrome.cursor : 0;
        },
        getCompletions: () => {
          const chrome = multiWindowChromeRef.current;
          if (!chrome || !chrome.completions || chrome.completions.length === 0) {
            return { items: [], index: -1, windowStart: 0, pageSize: 8 };
          }
          return {
            items: chrome.completions,
            index: chrome.completionIndex,
            windowStart: chrome.completionWindowStart,
            pageSize: chrome.completionPageSize || 8,
          };
        },
        getAgentLabel: (id) => {
          const current = stateRef.current || {};
          const metaMap = current.activeAgentMeta || new Map();
          return getAgentLabelFor(metaMap.get(id), id);
        },
        getInternalPaneInfo: (id) => {
          const current = stateRef.current || {};
          const metaMap = current.activeAgentMeta instanceof Map ? current.activeAgentMeta : new Map();
          const meta = metaMap.get(id) || {};
          const status = internalStatusLabel(meta.activity_state || meta.state || "");
          const detail = String(meta.activity_detail || meta.detail || meta.status_text || "").trim();
          return {
            status,
            detail,
            input: "",
            cursor: 0,
          };
        },
        getDashboardLines: () => {
          const chrome = multiWindowChromeRef.current;
          return chrome ? chrome.dashboardLines : [];
        },
        getTerminalFocused: () => mwTerminalFocusedRef.current,
        freezeScreen: (frozen) => {
          if (frozen) {
            processStdout.write = () => true;
          } else {
            processStdout.write = originalWrite;
          }
        },
        restoreTerminal: () => {
          const rows = processStdout.rows || 24;
          originalWrite(`\x1b[1;${rows}r`);
          originalWrite("\x1b[2J\x1b[H");
        },
        onInternalSubmit: (agentId, message) => {
          sendInternalAgentMessage(agentId, message);
        },
        onExit: () => {
          setMultiWindowActive(false);
        },
      });
      return multiWindowControllerRef.current;
    }, [props.projectRoot, stdout]);

    const toggleMultiWindow = useCallback(() => createInkMultiWindowToggle({
      getController: getMultiWindowController,
      setActive: setMultiWindowActive,
      logMessage: logInkMessage,
    })(), [getMultiWindowController, logInkMessage]);

    useEffect(() => () => {
      const controller = multiWindowControllerRef.current;
      if (controller && typeof controller.exit === "function") {
        try { controller.exit(); } catch { /* ignore */ }
      }
      multiWindowControllerRef.current = null;
    }, []);

    useEffect(() => {
      internalAgentViewRef.current = internalAgentView;
    }, [internalAgentView]);

    useEffect(() => {
      if (!stdout) return undefined;
      const update = () =>
        setSize({ cols: stdout.columns || 0, rows: stdout.rows || 0 });
      update();
      stdout.on("resize", update);
      return () => stdout.off("resize", update);
    }, [stdout]);

    // Load persisted input history once on mount.
    useEffect(() => {
      try {
        const history = loadInputHistory(props.projectRoot, 200, { globalMode: props.globalMode });
        if (history.length > 0) dispatch({ type: "history/load", list: history });
      } catch { /* ignore */ }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const sendInternalAgentWatch = (agentId, enabled) => {
      if (!agentId || !props.daemonConnection || typeof props.daemonConnection.send !== "function") return;
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        props.daemonConnection.send({
          type: IPC_REQUEST_TYPES.BUS_WATCH,
          agent_id: agentId,
          enabled: enabled !== false,
        });
      } catch { /* ignore */ }
    };

    const reconcileMultiWindowInternalWatches = useCallback(() => {
      const current = stateRef.current || {};
      const agents = Array.isArray(current.agents) ? current.agents : [];
      const next = new Set();
      if (multiWindowActive) {
        for (const agentId of agents) {
          const enterRequest = resolveAgentEnterRequest({
            agentId,
            projectRoot: currentProjectRootRef.current || props.projectRoot,
            activeAgentMeta: current.activeAgentMeta,
            settings: current.settings,
          });
          if (enterRequest && enterRequest.useBus) next.add(agentId);
        }
      }
      const previous = multiWindowWatchedInternalAgentsRef.current;
      for (const agentId of next) {
        if (!previous.has(agentId)) sendInternalAgentWatch(agentId, true);
      }
      for (const agentId of previous) {
        if (!next.has(agentId)) sendInternalAgentWatch(agentId, false);
      }
      multiWindowWatchedInternalAgentsRef.current = next;
    }, [multiWindowActive, props.projectRoot, props.daemonConnection]);

    useEffect(() => {
      if (!multiWindowActive) return;
      const controller = multiWindowControllerRef.current;
      if (!controller) return;
      reconcileMultiWindowInternalWatches();
      if (typeof controller.syncAgents === "function") controller.syncAgents();
      if (typeof controller.renderAll === "function") controller.renderAll();
    }, [multiWindowActive, state.agents, state.logLines, state.draft, state.status, size.cols, size.rows, mwCursor, state.focusMode, state.dashboardView, state.selectedAgentIndex, state.selectedProjectIndex, state.selectedModeIndex, state.selectedProviderIndex, state.selectedCronIndex, mwTerminalFocused, reconcileMultiWindowInternalWatches]);

    useEffect(() => {
      if (multiWindowActive) return;
      reconcileMultiWindowInternalWatches();
    }, [multiWindowActive, reconcileMultiWindowInternalWatches]);

    const sendInternalAgentMessage = (agentId, message) => {
      if (!agentId || !message || !props.daemonConnection || typeof props.daemonConnection.send !== "function") return;
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        props.daemonConnection.send({
          type: IPC_REQUEST_TYPES.BUS_SEND,
          target: agentId,
          message,
          injection_mode: "immediate",
          source: "chat-internal-agent-view",
        });
      } catch (err) {
        setInternalAgentView((prev) => appendInternalAgentText(
          updateInternalViewStatus(prev, "blocked", err && err.message ? err.message : String(err || "")),
          `Error: ${err && err.message ? err.message : err}\n`,
        ));
      }
    };

    const isInternalAlias = (view, value) => {
      if (!view || !view.agentId) return false;
      const text = String(value || "");
      if (!text) return false;
      const aliases = new Set((view.aliases || []).concat([view.agentId, view.label]).filter(Boolean).map(String));
      return aliases.has(text);
    };

    const buildInternalAgentAliases = (agentId) => {
      const current = stateRef.current || {};
      const metaMap = current.activeAgentMeta instanceof Map ? current.activeAgentMeta : new Map();
      const meta = metaMap.get(agentId) || {};
      return new Set([
        agentId,
        meta.nickname,
        meta.scoped_nickname,
        meta.display_nickname,
        meta.fullId,
      ].filter(Boolean).map(String));
    };

    const writeMultiWindowInternalEvent = useCallback((data = {}) => {
      const controller = multiWindowControllerRef.current;
      if (!multiWindowActive || !controller || typeof controller.writeToPane !== "function") return false;
      const watched = multiWindowWatchedInternalAgentsRef.current;
      if (!watched || watched.size === 0) return false;

      let handled = false;
      for (const agentId of watched) {
        const aliases = buildInternalAgentAliases(agentId);
        const publisher = String(data.publisher || (data.event === "broadcast" ? "broadcast" : "bus"));
        const target = String(data.target || data.subscriber || "");
        const fromAgent = aliases.has(publisher);
        const toAgent = aliases.has(target) || aliases.has(String(data.subscriber || ""));
        if (!fromAgent && !toAgent) continue;
        if (data.silent) {
          handled = true;
          continue;
        }
        if (data.source === "chat-internal-agent-view" && toAgent && !fromAgent) {
          handled = true;
          continue;
        }
        if (data.event === "activity_state_changed") {
          const state = internalStatusLabel(data.state || data.activity_state || "");
          const detail = String(data.detail || (data.data && data.data.detail) || data.message || "").trim();
          controller.writeToPane(agentId, `\r\n[${state}${detail ? ` · ${detail}` : ""}]\r\n`);
          handled = true;
          continue;
        }

        const { displayMessage, streamPayload } = parseInternalBusPayload(data.message || "");
        if (streamPayload) {
          if (!fromAgent) {
            handled = true;
            continue;
          }
          const delta = typeof streamPayload.delta === "string"
            ? streamPayload.delta.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n")
            : "";
          if (delta) controller.writeToPane(agentId, delta);
          if (streamPayload.done) controller.writeToPane(agentId, "\r\n");
          handled = true;
          continue;
        }
        if (!displayMessage) {
          handled = true;
          continue;
        }
        const prefix = fromAgent ? "* " : "> ";
        controller.writeToPane(agentId, `${prefix}${displayMessage.replace(/\n/g, `\r\n  `)}\r\n`);
        handled = true;
      }
      return handled;
    }, [multiWindowActive]);

    const handleInternalStatus = (data = {}) => {
      const view = internalAgentViewRef.current;
      if (!view || !view.agentId) return;
      const metaList = Array.isArray(data.active_meta) ? data.active_meta : [];
      for (const meta of metaList) {
        const metaId = meta && (meta.fullId || meta.subscriber_id || meta.id) ? String(meta.fullId || meta.subscriber_id || meta.id) : "";
        const typedId = meta && meta.type && meta.id ? `${meta.type}:${meta.id}` : "";
        if (!isInternalAlias(view, metaId) && !isInternalAlias(view, typedId)) continue;
        const status = internalStatusLabel(meta.activity_state || meta.state || "");
        const detail = String(meta.activity_detail || meta.detail || meta.status_text || "").trim();
        setInternalAgentView((prev) => (
          prev.agentId === view.agentId ? updateInternalViewStatus(prev, status, detail) : prev
        ));
        return;
      }
    };

    const handleInternalBusMessage = (data = {}) => {
      const view = internalAgentViewRef.current;
      if (!view || !view.agentId) return false;
      if (data.event === "activity_state_changed") {
        const actor = String(data.subscriber || data.publisher || "").trim();
        if (!isInternalAlias(view, actor)) return false;
        setInternalAgentView((prev) => (
          prev.agentId === view.agentId
            ? {
              ...updateInternalViewStatus(
                prev,
                data.state || data.activity_state || "",
                data.detail || (data.data && data.data.detail) || data.message || "",
              ),
            }
            : prev
        ));
        return true;
      }
      const publisher = String(data.publisher || (data.event === "broadcast" ? "broadcast" : "bus"));
      const target = String(data.target || data.subscriber || "");
      const fromAgent = isInternalAlias(view, publisher);
      const toAgent = isInternalAlias(view, target);
      if (!fromAgent && !toAgent) return false;
      if (data.silent) return true;
      if (data.source === "chat-internal-agent-view" && toAgent && !fromAgent) return true;

      const { displayMessage, streamPayload } = parseInternalBusPayload(data.message || "");
      if (streamPayload) {
        if (!fromAgent) return true;
        const delta = typeof streamPayload.delta === "string"
          ? streamPayload.delta.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n")
          : "";
        if (delta) {
          setInternalAgentView((prev) => (
            prev.agentId === view.agentId
              ? updateInternalViewStatus(
                appendInternalAgentText(prev, delta, { prefix: "* " }),
                streamPayload.done ? "ready" : "working",
                streamPayload.reason || prev.detail || "",
              )
              : prev
          ));
        } else if (streamPayload.done) {
          setInternalAgentView((prev) => (
            prev.agentId === view.agentId ? updateInternalViewStatus(prev, "ready", "") : prev
          ));
        }
        return true;
      }
      if (!displayMessage) return true;
      setInternalAgentView((prev) => {
        if (prev.agentId !== view.agentId) return prev;
        const next = fromAgent
          ? appendInternalAgentText(prev, `${displayMessage}\n`, { prefix: "* " })
          : appendInternalAgentText(prev, `${displayMessage}\n`, { prefix: "> " });
        return fromAgent ? updateInternalViewStatus(next, "ready", "") : next;
      });
      return true;
    };

    const handleInternalErrorMessage = (message = "") => {
      const view = internalAgentViewRef.current;
      if (!view || !view.agentId) return false;
      setInternalAgentView((prev) => (
        appendInternalErrorToView(prev, view.agentId, message)
      ));
      return true;
    };

    const handleInternalSendOk = () => {
      const view = internalAgentViewRef.current;
      if (!view || !view.agentId) return false;
      setInternalAgentView((prev) => (
        prev.agentId === view.agentId ? updateInternalViewStatus(prev, "ready", "") : prev
      ));
      return true;
    };

    const requestDaemonStatus = useCallback(() => {
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        const conn = props.daemonConnection;
        if (conn && typeof conn.send === "function") conn.send({ type: IPC_REQUEST_TYPES.STATUS });
      } catch { /* ignore */ }
    }, [props.daemonConnection]);

    const updateDashboardFromStatus = useCallback((data = {}) => {
      const activeIds = Array.isArray(data.active) ? data.active : [];
      const metaList = Array.isArray(data.active_meta) ? data.active_meta : [];
      const { buildAgentMaps } = require("../../chat/agentDirectory");
      const { labelMap, metaMap } = buildAgentMaps(activeIds, metaList);
      const agentsForDispatch = activeIds.map((id) => {
        const meta = metaMap.get(id) || {};
        const colon = id.indexOf(":");
        const fallbackType = colon > 0 ? id.slice(0, colon) : id;
        const fallbackId = colon > 0 ? id.slice(colon + 1) : "";
        return {
          ...meta,
          fullId: id,
          type: meta.type || fallbackType,
          id: meta.id || fallbackId,
          nickname: labelMap.get(id) || id,
        };
      });
      dispatch({ type: "agents/set", list: agentsForDispatch });
      if (data.cron && Array.isArray(data.cron.tasks)) {
        dispatch({ type: "cron/set", list: data.cron.tasks });
      }
      dispatch({ type: "loop/set", summary: data.loop || null });
      handleInternalStatus(data);
    }, []);

    // Wire daemon: register a message handler that turns IPC responses
    // through the same daemonMessageRouter blessed uses, then adapts the
    // blessed callbacks to Ink state updates.
    useEffect(() => {
      if (!interactive) return undefined;
      const conn = props.daemonConnection;
      const setHandler = props.setDaemonMessageHandler;
      if (!conn || typeof conn.connect !== "function" || typeof setHandler !== "function") {
        return undefined;
      }
      const { IPC_RESPONSE_TYPES } = require("../../shared/eventContract");
      const { createDaemonMessageRouter } = require("../../chat/daemonMessageRouter");
      const streamState = streamStateRef.current;
      const router = createDaemonMessageRouter({
        escapeBlessed: (value) => String(value == null ? "" : value),
        stripBlessedTags,
        logMessage: logInkMessage,
        renderScreen: () => {},
        updateDashboard: updateDashboardFromStatus,
        requestStatus: requestDaemonStatus,
        resolveStatusLine: (text, data = {}) => {
          setStatusText(text, {
            type: data && data.phase === "error" ? "error" : "typing",
            showTimer: false,
          });
        },
        enqueueBusStatus: (item = {}) => setStatusText(item.text || "Processing bus message", { type: "typing" }),
        resolveBusStatus: (item = {}) => setStatusText(item.text || "Bus message processed", { type: "done" }),
        getPending: () => pendingRef.current,
        setPending: (value) => { pendingRef.current = value || null; },
        resolveAgentDisplayName: (value) => {
          const current = stateRef.current || {};
          const meta = current.activeAgentMeta instanceof Map ? current.activeAgentMeta.get(value) : null;
          return getAgentLabelFor(meta, value);
        },
        getCurrentView: () => {
          const current = stateRef.current || {};
          return current.viewingAgentId ? "agent" : "main";
        },
        isAgentViewUsesBus: () => Boolean(internalAgentViewRef.current && internalAgentViewRef.current.agentId),
        getViewingAgent: () => {
          const current = stateRef.current || {};
          return current.viewingAgentId || (internalAgentViewRef.current && internalAgentViewRef.current.agentId) || "";
        },
        isAgentEventForViewingAgent: (data, viewingAgent, publisher) => {
          const view = internalAgentViewRef.current || {};
          if (!view.agentId && !viewingAgent) return false;
          const candidates = [
            viewingAgent,
            publisher,
            data && data.publisher,
            data && data.target,
            data && data.subscriber,
          ];
          return candidates.some((candidate) => isInternalAlias(view, candidate));
        },
        writeToAgentTerm: (text, meta = {}) => {
          const view = internalAgentViewRef.current;
          if (!view || !view.agentId) return;
          setInternalAgentView((prev) => (
            applyInternalAgentTermWrite(prev, view.agentId, text, meta)
          ));
        },
        consumePendingDelivery: (...args) => streamState.consumePendingDelivery(...args),
        getPendingState: (...args) => streamState.getPendingState(...args),
        beginStream: (...args) => streamState.beginStream(...args),
        appendStreamDelta: (...args) => streamState.appendStreamDelta(...args),
        finalizeStream: (...args) => streamState.finalizeStream(...args),
        hasStream: (...args) => streamState.hasStream(...args),
        setTransientAgentState: (agentId, value, options = {}) => {
          if (!agentId || !value) return;
          dispatch({
            type: "agents/patchMeta",
            agentId,
            patch: {
              activity_state: value,
              activity_detail: options.detail || "",
            },
          });
        },
        clearTransientAgentState: (agentId) => {
          if (!agentId) return;
          dispatch({
            type: "agents/patchMeta",
            agentId,
            patch: {
              activity_state: "",
              activity_detail: "",
            },
          });
        },
        refreshDashboard: () => {},
      });
      setHandler((msg) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === IPC_RESPONSE_TYPES.ERROR && handleInternalErrorMessage(msg.error || "unknown error")) {
          return;
        }
        if (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK) {
          if (handleInternalSendOk()) return;
          const text = `✓ Message delivered`;
          logInkMessage("system", text);
          dispatch({ type: "status/idle" });
          requestDaemonStatus();
          return;
        }
        if (msg.type === IPC_RESPONSE_TYPES.BUS) {
          writeMultiWindowInternalEvent(msg.data || {});
        }
        router.handleMessage(msg);
      });
      conn.connect();
      return () => {
        try { if (typeof conn.close === "function") conn.close(); } catch { /* ignore */ }
      };
    }, [interactive, logInkMessage, requestDaemonStatus, setStatusText, updateDashboardFromStatus, writeMultiWindowInternalEvent]);

    // commandExecutor wiring. The blessed implementation reuses this
    // module to dispatch every slash command (~30 callbacks). We adapt
    // the callback surface to ink: log/status/render writes go through
    // dispatch, daemon ops go through props.daemonConnection, and
    // blessed-tag markup the executor sprinkles into log lines is
    // stripped before rendering.
    const commandExecutorRef = useRef(null);
    useEffect(() => {
      if (!interactive) return undefined;
      const { createCommandExecutor } = require("../../chat/commandExecutor");
      const { parseCommand: parseCmd } = require("../../chat/commands");
      const { startDaemon: transportStartDaemon, stopDaemon: transportStopDaemon } = require("../../chat/transport");
      const AgentActivator = require("../../bus/activate");
      const conn = props.daemonConnection;

      try {
        commandExecutorRef.current = createCommandExecutor({
          projectRoot: props.projectRoot,
          getActiveProjectRoot: () => currentProjectRootRef.current || props.projectRoot,
          parseCommand: parseCmd,
          escapeBlessed: (v) => String(v == null ? "" : v),
          logMessage: logInkMessage,
          resolveStatusLine: (text) => setStatusText(text),
          renderScreen: () => {},
          clearLog: () => {
            // Clear the persisted chat history file so reopening the chat
            // doesn't reload old messages.
            try {
              const root = currentProjectRootRef.current || props.projectRoot;
              const historyOptions = chatHistoryOptionsForScope({
                globalMode: props.globalMode,
                globalScope: (stateRef.current && stateRef.current.globalScope) || "controller",
              });
              const file = chatHistoryFilePath(root, historyOptions);
              if (file && fs.existsSync(file)) fs.writeFileSync(file, "");
            } catch { /* ignore */ }
            // ink redraws by erasing only as many lines as the last frame
            // emitted. After log/clear the next frame is shorter, so the
            // older log lines remain in the terminal scrollback. Wipe the
            // visible screen + scrollback first, then dispatch — ink will
            // repaint the (now small) frame onto a clean buffer.
            try {
              const out = (typeof process !== "undefined" && process.stdout) || null;
              if (out && out.isTTY && typeof out.write === "function") {
                out.write("\x1b[2J\x1b[3J\x1b[H");
              }
            } catch { /* ignore */ }
            dispatch({ type: "log/clear" });
          },
          getActiveAgents: () => (stateRef.current && stateRef.current.agents) || [],
          getActiveAgentMetaMap: () => (stateRef.current && stateRef.current.activeAgentMeta) || new Map(),
          getAgentLabel: (id) => {
            const metaMap = (stateRef.current && stateRef.current.activeAgentMeta) || new Map();
            return getAgentLabelFor(metaMap.get(id), id);
          },
          isDaemonRunning: (root) => props.env && props.env.isRunning ? props.env.isRunning(root || props.projectRoot) : true,
          startDaemon: (root, options = {}) => {
            const targetRoot = root || props.projectRoot;
            if (props.env && typeof props.env.startDaemon === "function") return props.env.startDaemon(targetRoot, options);
            return transportStartDaemon(targetRoot, options);
          },
          stopDaemon: (root, options = {}) => transportStopDaemon(root || props.projectRoot, options),
          restartDaemon: async (root) => {
            const targetRoot = root || currentProjectRootRef.current || props.projectRoot;
            if (
              targetRoot === (currentProjectRootRef.current || props.projectRoot) &&
              props.daemonCoordinator &&
              typeof props.daemonCoordinator.restart === "function"
            ) {
              await props.daemonCoordinator.restart();
              return;
            }
            try { if (conn && typeof conn.close === "function") conn.close(); } catch { /* ignore */ }
            transportStopDaemon(targetRoot, { source: "ink-command:/daemon restart" });
            transportStartDaemon(targetRoot);
            if (targetRoot === (currentProjectRootRef.current || props.projectRoot) && conn && typeof conn.connect === "function") {
              await conn.connect();
            }
          },
          send: (req) => { try { if (conn && typeof conn.send === "function") conn.send(req); } catch { /* ignore */ } },
          requestStatus: requestDaemonStatus,
          requestCron: (payload = {}) => {
            try {
              const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
              if (conn && typeof conn.send === "function") {
                conn.send({ type: IPC_REQUEST_TYPES.CRON, ...payload });
              }
            } catch { /* ignore */ }
          },
          activateAgent: async (target) => {
            const activator = new AgentActivator(currentProjectRootRef.current || props.projectRoot);
            await activator.activate(target);
          },
          globalMode: Boolean(props.globalMode),
          listProjects: () => (stateRef.current && stateRef.current.projects) || [],
          getCurrentProject: () => ({ project_root: currentProjectRootRef.current || props.projectRoot }),
          switchProject: async (target) => {
            const rawTarget = String((target && (target.projectRoot || target.project_root || target.target)) || target || "").trim();
            let targetRoot = rawTarget;
            if (/^\d+$/.test(rawTarget)) {
              const idx = Number.parseInt(rawTarget, 10) - 1;
              const projects = (stateRef.current && stateRef.current.projects) || [];
              targetRoot = resolveProjectRowRoot(projects[idx]);
            }
            const switchProject = switchToProjectRootRef.current;
            if (typeof switchProject !== "function") {
              return { ok: false, error: "project switching unavailable" };
            }
            return switchProject(targetRoot, { focusInput: true });
          },
          toggleMultiWindow,
        });
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: command executor unavailable (${err && err.message ? err.message : err})` });
      }
      return undefined;
    }, [interactive, logInkMessage, requestDaemonStatus, setStatusText, toggleMultiWindow]);

    // Periodic STATUS poll to keep the agents footer fresh, mirroring
    // blessed's requestStatus on a timer.
    useEffect(() => {
      if (!interactive) return undefined;
      const conn = props.daemonConnection;
      if (!conn || typeof conn.send !== "function") return undefined;
      const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
      const tick = () => {
        try { conn.send({ type: IPC_REQUEST_TYPES.STATUS }); } catch { /* ignore */ }
      };
      tick();
      const timer = setInterval(tick, 3000);
      return () => clearInterval(timer);
    }, [interactive]);

    // Refresh the project rail in global mode. blessed pulls this off the
    // local registry; we do the same so the dashboard's first row tracks
    // every running project without needing a daemon round-trip.
    const refreshGlobalProjects = useCallback((activeRoot = currentProjectRoot) => {
      if (!props.globalMode) return [];
      const list = loadGlobalProjectRows(activeRoot);
      dispatch({
        type: "projects/set",
        list,
        activeProjectRoot: activeRoot,
      });
      return list;
    }, [props.globalMode, currentProjectRoot]);

    useEffect(() => {
      if (!interactive || !props.globalMode) return undefined;
      const refresh = () => {
        try { refreshGlobalProjects(currentProjectRoot); } catch { /* ignore */ }
      };
      refresh();
      const timer = setInterval(refresh, 4000);
      return () => clearInterval(timer);
    }, [interactive, props.globalMode, currentProjectRoot, refreshGlobalProjects]);

    useEffect(() => {
      const internalStatus = state.viewingAgentId ? internalStatusLabel(internalAgentView.status) : "ready";
      const internalActive = internalStatus !== "ready";
      const statusAnimated = state.status.message && isAnimatedStatusType(state.status.type);
      if ((!statusAnimated) && !internalActive) return undefined;
      const timer = setInterval(() => setSpinnerTick((t) => t + 1), 100);
      return () => clearInterval(timer);
    }, [state.status.message, state.status.type, state.viewingAgentId, internalAgentView.status]);

    const selectedProject = state.selectedProjectIndex >= 0 ? state.projects[state.selectedProjectIndex] : null;
    const selectedProjectRoot = state.selectedProjectRoot || resolveProjectRowRoot(selectedProject);
    const currentProject = state.projects.find((row) => resolveProjectRowRoot(row) === currentProjectRoot) || null;
    const currentProjectLabel = currentProject
      ? String(currentProject.label || currentProject.project_name || path.basename(currentProjectRoot) || currentProjectRoot)
      : "";
    const inCommittedProjectScope = Boolean(props.globalMode && state.globalScope === "project" && currentProjectRoot);
    const displayAgents = state.agents;
    const displayAgentMeta = state.activeAgentMeta;
    const targetAgentId = state.agentSelectionMode && state.selectedAgentIndex >= 0
      ? displayAgents[state.selectedAgentIndex]
      : null;
    const targetAgentMeta = targetAgentId ? displayAgentMeta.get(targetAgentId) : null;
    const targetAgentLabel = targetAgentId ? getAgentLabelFor(targetAgentMeta, targetAgentId) : "";
    const restartDaemonBestEffort = useCallback(() => {
      const coordinator = props.daemonCoordinator;
      if (coordinator && typeof coordinator.restart === "function") {
        Promise.resolve(coordinator.restart()).catch((err) => {
          dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
        });
        return;
      }
      const conn = props.daemonConnection;
      try { if (conn && typeof conn.close === "function") conn.close(); } catch { /* ignore */ }
      try { if (conn && typeof conn.connect === "function") conn.connect(); } catch { /* ignore */ }
    }, []);

    const persistSetting = useCallback((patch, statusText, restart = false) => {
      try {
        const { saveConfig } = require("../../config");
        saveConfig(props.projectRoot, patch);
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
      }
      if (statusText) {
        dispatch({
          type: "status/set",
          payload: { message: statusText, type: "typing", showTimer: false, startedAt: Date.now() },
        });
      }
      if (restart) restartDaemonBestEffort();
    }, [restartDaemonBestEffort]);

    const clearUfooAgentIdentity = useCallback(() => {
      try {
        const { getUfooPaths } = require("../../ufoo/paths");
        const agentDir = getUfooPaths(props.projectRoot).agentDir;
        fs.rmSync(path.join(agentDir, "ufoo-agent.json"), { force: true });
        fs.rmSync(path.join(agentDir, "ufoo-agent.history.jsonl"), { force: true });
      } catch { /* ignore */ }
    }, []);

    const applySelectedMode = useCallback(() => {
      const { normalizeLaunchMode } = require("../../config");
      const mode = normalizeLaunchMode(state.modeOptions[state.selectedModeIndex]);
      dispatch({ type: "settings/applyMode" });
      persistSetting({ launchMode: mode }, `Launch mode: ${mode}`, true);
      dispatch({ type: "focus/set", mode: "input" });
    }, [state.modeOptions, state.selectedModeIndex, persistSetting]);

    const applySelectedProvider = useCallback(() => {
      const { normalizeAgentProvider } = require("../../config");
      const selected = state.providerOptions[state.selectedProviderIndex];
      const provider = normalizeAgentProvider(selected && selected.value);
      dispatch({ type: "settings/applyProvider" });
      clearUfooAgentIdentity();
      persistSetting({ agentProvider: provider }, `ufoo-agent: ${provider === "claude-cli" ? "claude" : "codex"}`, true);
      dispatch({ type: "focus/set", mode: "input" });
    }, [state.providerOptions, state.selectedProviderIndex, clearUfooAgentIdentity, persistSetting]);

    const sendCronStop = useCallback((taskId) => {
      if (!taskId || !props.daemonConnection || typeof props.daemonConnection.send !== "function") return;
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        props.daemonConnection.send({ type: IPC_REQUEST_TYPES.CRON, operation: "stop", id: taskId });
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
      }
    }, []);

    const switchToProjectRoot = useCallback(async (targetRoot, options = {}) => {
      const root = String(targetRoot || "").trim();
      if (!root) return { ok: false, error: "project root unavailable" };
      if (props.globalMode && props.env && typeof props.env.isRunning === "function" && !props.env.isRunning(root)) {
        try {
          const { markProjectStopped } = require("../../projects");
          markProjectStopped(root);
        } catch { /* ignore */ }
        refreshGlobalProjects(currentProjectRoot);
        dispatch({ type: "projects/clearSelection" });
        dispatch({ type: "focus/set", mode: "input" });
        const label = path.basename(root) || root;
        const result = { ok: false, error: `project is not running: ${label}`, stopped: true };
        dispatch({ type: "log/append", text: `Project ${label} is not running; removed stale dashboard entry` });
        return result;
      }
      const focusInput = options.focusInput === true;
      const selected = state.projects.find((row) => resolveProjectRowRoot(row) === root) || {};
      dispatch({ type: "log/clear" });
      const banner = buildChatBannerLines({
        ...props,
        activeProjectRoot: root,
        globalScope: "project",
      }, fmt.UCODE_VERSION || "");
      dispatch({ type: "log/appendMany", lines: banner });
      const persisted = loadChatHistory(root, 200, { globalMode: false });
      if (persisted.length > 0) {
        dispatch({ type: "log/append", text: "" });
        dispatch({ type: "log/append", text: "─── history ───" });
        dispatch({ type: "log/appendMany", lines: persisted });
      }
      if (props.daemonCoordinator && typeof props.daemonCoordinator.switchProject === "function") {
        const { socketPath } = require("../../daemon");
        const res = await Promise.resolve(props.daemonCoordinator.switchProject({
          projectRoot: root,
          sockPath: socketPath(root),
          autoStart: false,
        }));
        if (!res || res.ok !== true) {
          dispatch({ type: "log/append", text: `Error: ${(res && res.error) || "switch failed"}` });
          return res || { ok: false, error: "switch failed" };
        }
      }
      setCurrentProjectRoot(root);
      dispatch({ type: "scope/set", scope: "project" });
      dispatch({
        type: "projects/select",
        index: state.projects.indexOf(selected),
        projectRoot: root,
      });
      refreshGlobalProjects(root);
      if (focusInput) dispatch({ type: "focus/set", mode: "input" });
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        if (props.daemonConnection && typeof props.daemonConnection.send === "function") {
          props.daemonConnection.send({ type: IPC_REQUEST_TYPES.STATUS });
        }
      } catch { /* ignore */ }
      return { ok: true, project_root: root };
    }, [
      props,
      props.daemonCoordinator,
      props.daemonConnection,
      props.env,
      state.projects,
      refreshGlobalProjects,
      currentProjectRoot,
    ]);

    useEffect(() => {
      switchToProjectRootRef.current = switchToProjectRoot;
    }, [switchToProjectRoot]);

    const switchToControllerRoot = useCallback(async () => {
      const root = props.activeProjectRoot || props.projectRoot || "";
      if (!root) return { ok: false, error: "controller root unavailable" };
      if (props.daemonCoordinator && typeof props.daemonCoordinator.switchProject === "function") {
        const { socketPath } = require("../../daemon");
        const res = await Promise.resolve(props.daemonCoordinator.switchProject({
          projectRoot: root,
          sockPath: socketPath(root),
        }));
        if (!res || res.ok !== true) {
          dispatch({ type: "log/append", text: `Error: ${(res && res.error) || "switch to global failed"}` });
          return res || { ok: false, error: "switch to global failed" };
        }
      }

      dispatch({ type: "projects/clearSelection" });
      dispatch({ type: "scope/set", scope: "controller" });
      setCurrentProjectRoot(root);
      refreshGlobalProjects(root);

      dispatch({ type: "log/clear" });
      const banner = buildChatBannerLines({
        ...props,
        activeProjectRoot: root,
        globalScope: "controller",
      }, fmt.UCODE_VERSION || "");
      dispatch({ type: "log/appendMany", lines: banner });
      const persisted = loadChatHistory(root, 200, { globalMode: true });
      if (persisted.length > 0) {
        dispatch({ type: "log/append", text: "" });
        dispatch({ type: "log/append", text: "─── history ───" });
        dispatch({ type: "log/appendMany", lines: persisted });
      }

      const snapshot = readProjectAgentSnapshot(root);
      dispatch({ type: "agents/set", list: snapshot.agents.map((id) => snapshot.metaMap.get(id) || { fullId: id }) });
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        if (props.daemonConnection && typeof props.daemonConnection.send === "function") {
          props.daemonConnection.send({ type: IPC_REQUEST_TYPES.STATUS });
        }
      } catch { /* ignore */ }
      return { ok: true, project_root: root };
    }, [
      props,
      props.daemonCoordinator,
      props.daemonConnection,
      refreshGlobalProjects,
    ]);

    const closeSelectedProject = useCallback(async () => {
      if (!props.globalMode || !Array.isArray(state.projects) || state.projects.length === 0) return;
      const selectedIndex = state.selectedProjectIndex >= 0 ? state.selectedProjectIndex : 0;
      const proj = state.projects[selectedIndex];
      const targetRoot = resolveProjectRowRoot(proj);
      const label = (proj && (proj.label || proj.project_name)) || targetRoot;
      if (!targetRoot) {
        dispatch({ type: "log/append", text: "Error: project root unavailable" });
        return;
      }

      dispatch({ type: "log/append", text: `Closing project ${label} daemon and agents...` });
      let activeRoot = currentProjectRoot;
      try {
        if (targetRoot === currentProjectRoot) {
          const fallback = state.projects
            .map(resolveProjectRowRoot)
            .find((root) => root && root !== targetRoot);
          if (!fallback) {
            dispatch({ type: "log/append", text: "Error: Cannot close current project; switch to another project first" });
            return;
          }
          if (!props.daemonCoordinator || typeof props.daemonCoordinator.switchProject !== "function") {
            dispatch({ type: "log/append", text: "Error: project switching unavailable" });
            return;
          }
          const { socketPath } = require("../../daemon");
          const switched = await Promise.resolve(props.daemonCoordinator.switchProject({
            projectRoot: fallback,
            sockPath: socketPath(fallback),
            autoStart: false,
          }));
          if (!switched || switched.ok !== true) {
            dispatch({ type: "log/append", text: `Error: Failed to switch project before close: ${(switched && switched.error) || "switch failed"}` });
            return;
          }
          activeRoot = fallback;
          setCurrentProjectRoot(fallback);
          dispatch({ type: "scope/set", scope: "project" });
        }

        const { stopDaemon } = require("../../chat/transport");
        const { isRunning } = require("../../daemon");
        stopDaemon(targetRoot, { source: `ink-project-close:${targetRoot}` });
        refreshGlobalProjects(activeRoot);
        if (isRunning(targetRoot)) {
          dispatch({ type: "log/append", text: `Error: Project ${label} daemon is still running after stop` });
          return;
        }
        dispatch({ type: "log/append", text: `Closed project ${label} daemon and agents` });
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
      }
    }, [
      props.globalMode,
      props.daemonCoordinator,
      state.projects,
      state.selectedProjectIndex,
      currentProjectRoot,
      refreshGlobalProjects,
    ]);

    const submit = useCallback(async (submitted) => {
      const value = String(submitted == null ? state.draft : submitted);
      const trimmed = value.trim();
      if (props.globalMode && state.globalScope === "project" && selectedProjectRoot && selectedProjectRoot !== currentProjectRoot) {
        const switched = await switchToProjectRoot(selectedProjectRoot, { focusInput: true });
        if (!switched || switched.ok !== true) return;
      }
      dispatch({ type: "draft/clear" });
      const { createInputSubmitHandler } = require("../../chat/inputSubmitHandler");
      const { parseAtTarget } = require("../../chat/commands");
      const { resolveAgentId } = require("../../chat/agentDirectory");
      const { subscriberToSafeName } = require("../../bus/utils");
      const { getUfooPaths } = require("../../ufoo/paths");
      const { createTerminalAdapterRouter } = require("../../terminal/adapterRouter");
      const submitState = {};
      Object.defineProperties(submitState, {
        targetAgent: {
          get: () => targetAgentId || null,
          set: (next) => {
            const id = String(next || "");
            if (!id) {
              dispatch({ type: "agents/clearTarget" });
              return;
            }
            const idx = displayAgents.indexOf(id);
            if (idx >= 0) dispatch({ type: "agents/select", index: idx });
          },
        },
        pending: {
          get: () => pendingRef.current,
          set: (next) => { pendingRef.current = next || null; },
        },
        activeAgentMetaMap: {
          get: () => displayAgentMeta,
        },
      });
      const send = (req) => {
        if (!props.daemonConnection || typeof props.daemonConnection.send !== "function") {
          throw new Error("daemon connection unavailable");
        }
        props.daemonConnection.send(req);
      };
      const handler = createInputSubmitHandler({
        state: submitState,
        parseAtTarget,
        resolveAgentId: (label) => resolveAgentId({
          label,
          activeAgents: displayAgents,
          labelMap: buildActiveAgentLabelMap(displayAgents, displayAgentMeta),
          lookupNickname: (nickname) => {
            for (const [id, meta] of displayAgentMeta.entries()) {
              if (!meta) continue;
              if (meta.nickname === nickname || meta.scoped_nickname === nickname || meta.display_nickname === nickname) return id;
            }
            return null;
          },
        }),
        executeCommand: async (text) => {
          const exec = commandExecutorRef.current;
          if (!exec || typeof exec.executeCommand !== "function") {
            throw new Error("command executor not ready yet");
          }
          return exec.executeCommand(text);
        },
        queueStatusLine: (text) => setStatusText(text, { type: "typing", showTimer: true }),
        send,
        logMessage: logInkMessage,
        getAgentLabel: (id) => getAgentLabelFor(displayAgentMeta.get(id), id),
        escapeBlessed: (next) => String(next == null ? "" : next),
        markPendingDelivery: (agentId) => {
          const meta = displayAgentMeta.get(agentId);
          streamStateRef.current.markPendingDelivery(agentId, getAgentLabelFor(meta, agentId));
        },
        clearTargetAgent: () => dispatch({ type: "agents/clearTarget" }),
        setTargetAgent: (agentId) => {
          const idx = displayAgents.indexOf(agentId);
          if (idx >= 0) dispatch({ type: "agents/select", index: idx });
        },
        enterAgentView: (agentId, options = {}) => {
          const payload = buildAgentEnterPayload(agentId);
          if (payload && options.useBus) payload.useBus = true;
          if (payload && payload.useBus) {
            enterInternalAgentView(payload);
            return;
          }
          if (payload && typeof props.requestEnterAgentView === "function") {
            props.requestEnterAgentView(agentId, payload);
            exit();
          }
        },
        getAgentAdapter: (agentId) => {
          const meta = displayAgentMeta.get(agentId) || {};
          const launchMode = String(meta.launch_mode || meta.launchMode || state.settings.launchMode || "").trim();
          return createTerminalAdapterRouter().getAdapter({ launchMode, agentId, meta });
        },
        activateAgent: async (agentId) => {
          const AgentActivator = require("../../bus/activate");
          const activator = new AgentActivator(currentProjectRoot || props.projectRoot);
          await activator.activate(agentId);
        },
        getInjectSockPath: (agentId) => {
          const safeName = subscriberToSafeName(agentId);
          return path.join(getUfooPaths(currentProjectRoot || props.projectRoot).busQueuesDir, safeName, "inject.sock");
        },
        existsSync: fs.existsSync,
        commitInputHistory: (text) => {
          dispatch({ type: "history/push", value: text });
          try { appendInputHistory(props.projectRoot, text, { globalMode: props.globalMode }); } catch { /* ignore */ }
        },
        focusInput: () => dispatch({ type: "focus/set", mode: "input" }),
        renderScreen: () => {},
        getShellCwd: () => activeChatHistoryRoot,
        runShellCommand: async (shellCommand, options = {}) => {
          const { runShellCommand } = require("../../chat/shellCommand");
          return runShellCommand(shellCommand, options);
        },
      });
      try {
        await handler.handleSubmit(value);
      } catch (err) {
        dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : "send failed"}` });
        dispatch({ type: "status/idle" });
      }
    }, [
      state.draft,
      targetAgentId,
      props.globalMode,
      props.projectRoot,
      props.daemonConnection,
      props.requestEnterAgentView,
      selectedProjectRoot,
      currentProjectRoot,
      state.globalScope,
      state.settings.launchMode,
      switchToProjectRoot,
      displayAgents,
      displayAgentMeta,
      activeChatHistoryRoot,
      logInkMessage,
      setStatusText,
      exit,
    ]);

    const onArrowUpAtTop = useCallback(() => {
      if (state.inputHistory.length > 0) {
        const next = Math.max(0, state.historyIndex - 1);
        if (next !== state.historyIndex || state.draft !== state.inputHistory[next]) {
          dispatch({ type: "history/setIndex", index: next });
          dispatch({ type: "draft/set", value: state.inputHistory[next] || "" });
          setCompletionSuppressedDraft(state.inputHistory[next] || "");
          setDraftVersion((v) => v + 1);
          return;
        }
      }
      if (state.agentSelectionMode) dispatch({ type: "agents/clearTarget" });
    }, [state.inputHistory, state.historyIndex, state.draft, state.agentSelectionMode]);

    const onArrowDownAtBottom = useCallback((currentValue) => {
      if (state.inputHistory.length > 0) {
        const transition = fmt.resolveHistoryDownTransition({
          inputHistory: state.inputHistory,
          historyIndex: state.historyIndex,
          currentValue,
        });
        if (transition.moved) {
          dispatch({ type: "history/setIndex", index: transition.nextHistoryIndex });
          dispatch({ type: "draft/set", value: transition.nextValue });
          setCompletionSuppressedDraft(transition.nextValue);
          setDraftVersion((v) => v + 1);
          return;
        }
      }
      // Hand focus to the dashboard. Three-tier flow:
      //   global mode  → projects → agents → mode/provider/cron
      //   project mode → agents → mode/provider/cron
      if (props.globalMode) {
        dispatch({ type: "focus/set", mode: "dashboard" });
        if (state.projects.length > 0 && state.selectedProjectIndex < 0) {
          dispatch({ type: "view/set", view: "projects" });
          dispatch({ type: "projects/select", index: 0, projectRoot: resolveProjectRowRoot(state.projects[0]) });
          dispatch({ type: "projects/window", windowStart: 0 });
        } else {
          dispatch({ type: "view/set", view: "agents" });
          if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
            dispatch({ type: "agents/select", index: 0 });
          }
        }
        return;
      }
      dispatch({ type: "focus/set", mode: "dashboard" });
      dispatch({ type: "view/set", view: "agents" });
      if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
        dispatch({ type: "agents/select", index: 0 });
      }
    }, [state.inputHistory, state.historyIndex, state.projects.length, state.selectedProjectIndex, displayAgents.length, state.selectedAgentIndex, props.globalMode]);

    const onArrowSideAtEmpty = useCallback((direction) => {
      if (!state.agentSelectionMode || displayAgents.length === 0) return;
      const cur = state.selectedAgentIndex < 0 ? 0 : state.selectedAgentIndex;
      const next = direction === "left"
        ? Math.max(0, cur - 1)
        : Math.min(displayAgents.length - 1, cur + 1);
      dispatch({ type: "agents/select", index: next });
    }, [state.agentSelectionMode, state.selectedAgentIndex, displayAgents.length]);

    // Inline completions: shown above the input whenever the draft starts
    // with "/" or "@". Tab/Enter accept the highlighted entry, ↑↓ move the
    // selection. The list reuses the pure buildCompletions helper from
    // src/ui/format so jest can pin the source list without rendering ink.
    const { COMMAND_REGISTRY, COMMAND_TREE } = require("../../chat/commands");
    const agentLabels = displayAgents.map((id) =>
      getAgentLabelFor(displayAgentMeta.get(id), id)
    );

    // Lazy-load the dynamic completion sources once so /group run and
    // /solo run get the same alias/profile suggestions blessed shows.
    const dynamicSourcesRef = useRef(null);
    if (!dynamicSourcesRef.current) {
      const sources = { groupTemplates: [], soloProfiles: [] };
      try {
        const { loadTemplateRegistry } = require("../../group/templates");
        const reg = typeof loadTemplateRegistry === "function" ? loadTemplateRegistry(props.projectRoot) : null;
        if (reg && Array.isArray(reg.templates)) {
          sources.groupTemplates = reg.templates.map((item) => ({
            alias: item.alias,
            cmd: item.alias,
            desc: item.templateDescription || "",
            source: item.source || "",
          }));
        }
      } catch { /* ignore */ }
      try {
        const { loadPromptProfileRegistry } = require("../../group/promptProfiles");
        const { buildPromptProfileCandidates } = require("../../solo/commands");
        const reg = typeof loadPromptProfileRegistry === "function" ? loadPromptProfileRegistry(props.projectRoot) : null;
        if (reg && typeof buildPromptProfileCandidates === "function") {
          sources.soloProfiles = buildPromptProfileCandidates(reg) || [];
        }
      } catch { /* ignore */ }
      dynamicSourcesRef.current = sources;
    }

    const completions = fmt.buildCompletions({
      text: state.draft,
      agents: displayAgents,
      agentLabels,
      commands: COMMAND_REGISTRY,
      commandTree: COMMAND_TREE,
      groupTemplates: dynamicSourcesRef.current.groupTemplates,
      soloProfiles: dynamicSourcesRef.current.soloProfiles,
      limit: 20,
    });
    const [completionIndex, setCompletionIndex] = useState(0);
    // First visible row inside the popup. We show 8 rows at a time
    // (POPUP_PAGE_SIZE) and slide the window when the cursor crosses
    // the bottom or top, mimicking how a terminal list typically scrolls.
    const POPUP_PAGE_SIZE = 8;
    const [completionWindowStart, setCompletionWindowStart] = useState(0);
    // Bumped whenever the completion popup writes a new value into the
    // draft — MultilineInput watches this counter so it can park its
    // cursor at the end of the freshly accepted suggestion instead of
    // staying wherever the user last typed.
    const [draftVersion, setDraftVersion] = useState(0);
    // History recall should not immediately turn a recalled command such as
    // "/history" into an active completion popup; otherwise ↑/↓ get captured
    // by completion navigation and the user cannot keep walking history.
    const [completionSuppressedDraft, setCompletionSuppressedDraft] = useState(null);
    // Reset the selection cursor whenever the suggestion list shape changes.
    useEffect(() => {
      if (completions.length === 0) {
        if (completionIndex !== 0) setCompletionIndex(0);
        if (completionWindowStart !== 0) setCompletionWindowStart(0);
      } else if (completionIndex >= completions.length) {
        setCompletionIndex(completions.length - 1);
        setCompletionWindowStart(Math.max(0, completions.length - POPUP_PAGE_SIZE));
      }
    }, [completions.length, completionIndex, completionWindowStart]);
    useEffect(() => {
      if (multiWindowActive) setMwCursor(String(state.draft || "").length);
    }, [draftVersion]);
    const completionsOpen = completions.length > 0 && state.draft !== completionSuppressedDraft;
    const acceptCompletion = useCallback(() => {
      if (!completionsOpen) return false;
      const item = completions[Math.max(0, Math.min(completions.length - 1, completionIndex))];
      if (item) {
        dispatch({ type: "draft/set", value: item.replace });
        setCompletionSuppressedDraft(item.hasChildren ? null : item.replace);
        setDraftVersion((v) => v + 1);
      }
      setCompletionIndex(0);
      return true;
    }, [completionsOpen, completions, completionIndex]);

    const buildAgentEnterPayload = (agentId) => {
      const agentMeta = displayAgentMeta.get(agentId);
      const enterRequest = resolveAgentEnterRequest({
        agentId,
        projectRoot: currentProjectRoot || props.projectRoot,
        activeAgentMeta: displayAgentMeta,
        settings: state.settings,
      });
      return {
        ...enterRequest,
        agentLabel: getAgentLabelFor(agentMeta, agentId),
        agentAliases: [
          agentId,
          agentMeta && agentMeta.nickname,
          agentMeta && agentMeta.scoped_nickname,
          agentMeta && agentMeta.display_nickname,
        ].filter(Boolean).map(String),
      };
    };

    const activateExternalAgent = (agentId) => {
      const id = String(agentId || "").trim();
      if (!id) return;
      try {
        const AgentActivator = require("../../bus/activate");
        const activator = new AgentActivator(currentProjectRoot || props.projectRoot);
        void activator.activate(id);
      } catch (err) {
        logInkMessage("error", `✗ Failed to activate ${id}: ${err && err.message ? err.message : "unknown error"}`);
      }
    };

    const enterInternalAgentView = (enterRequest = {}) => {
      const agentId = String(enterRequest.agentId || "").trim();
      if (!agentId) return;
      const previous = internalAgentViewRef.current;
      if (previous && previous.agentId && previous.agentId !== agentId) {
        sendInternalAgentWatch(previous.agentId, false);
      }
      const next = createInternalAgentViewState({
        agentId,
        label: enterRequest.agentLabel || agentId,
        aliases: enterRequest.agentAliases || [],
        projectRoot: enterRequest.projectRoot || currentProjectRoot || props.projectRoot,
        width: size.cols || 80,
      });
      setInternalAgentView(next);
      internalAgentViewRef.current = next;
      dispatch({ type: "agentView/enter", agentId });
      dispatch({ type: "focus/set", mode: "input" });
      dispatch({ type: "agents/clearTarget" });
      sendInternalAgentWatch(agentId, true);
      try {
        const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
        if (props.daemonConnection && typeof props.daemonConnection.send === "function") {
          props.daemonConnection.send({ type: IPC_REQUEST_TYPES.STATUS });
        }
      } catch { /* ignore */ }
    };

    const exitInternalAgentView = () => {
      const view = internalAgentViewRef.current;
      if (view && view.agentId) sendInternalAgentWatch(view.agentId, false);
      const empty = createInternalAgentViewState();
      setInternalAgentView(empty);
      internalAgentViewRef.current = empty;
      dispatch({ type: "agentView/exit" });
      dispatch({ type: "view/set", view: "agents" });
      dispatch({ type: "focus/set", mode: "input" });
    };

    const submitInternalAgentInput = () => {
      const view = internalAgentViewRef.current;
      const text = String((view && view.input) || "").trim();
      if (!view || !view.agentId || !text) return;
      setInternalAgentView((prev) => ({
        ...updateInternalViewStatus(
          appendInternalAgentText(prev, `${text}\n`, { prefix: "> " }),
          "working",
          "",
        ),
        input: "",
        cursor: 0,
      }));
      sendInternalAgentMessage(view.agentId, text);
    };

    const handleInternalAgentDashboardKey = (input, key = {}) => {
      const keyName = resolveInternalKeyName(input, key);
      const totalItems = 1 + displayAgents.length;
      const currentIndex = Math.max(
        0,
        Math.min(totalItems - 1, Number(internalAgentViewRef.current.barIndex) || 0),
      );
      if (keyName === "left") {
        setInternalAgentView((prev) => ({
          ...prev,
          barIndex: Math.max(0, (Number(prev.barIndex) || 0) - 1),
        }));
        return true;
      }
      if (keyName === "right") {
        setInternalAgentView((prev) => ({
          ...prev,
          barIndex: Math.min(totalItems - 1, (Number(prev.barIndex) || 0) + 1),
        }));
        return true;
      }
      if (keyName === "up") {
        dispatch({ type: "focus/set", mode: "input" });
        return true;
      }
      if (keyName === "return" || keyName === "enter") {
        if (currentIndex === 0) {
          exitInternalAgentView();
          return true;
        }
        const agentId = displayAgents[currentIndex - 1];
        if (!agentId) return true;
        if (agentId === state.viewingAgentId) {
          dispatch({ type: "focus/set", mode: "input" });
          return true;
        }
        const payload = buildAgentEnterPayload(agentId);
        const action = resolveDashboardAgentEnterAction(payload);
        if (action === "internal") {
          enterInternalAgentView(payload);
          return true;
        }
        if (action === "activate") {
          if (state.viewingAgentId) sendInternalAgentWatch(state.viewingAgentId, false);
          dispatch({ type: "agentView/exit" });
          dispatch({ type: "view/set", view: "agents" });
          dispatch({ type: "focus/set", mode: "input" });
          activateExternalAgent(agentId);
          return true;
        }
        if (payload && typeof props.requestEnterAgentView === "function") {
          if (state.viewingAgentId) sendInternalAgentWatch(state.viewingAgentId, false);
          props.requestEnterAgentView(agentId, payload);
          exit();
        }
        return true;
      }
      if (key && key.ctrl && input === "x") {
        if (currentIndex <= 0) return true;
        const agentId = displayAgents[currentIndex - 1];
        if (!agentId) return true;
        try {
          const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
          if (props.daemonConnection && typeof props.daemonConnection.send === "function") {
            props.daemonConnection.send({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: agentId });
          }
        } catch { /* ignore */ }
        if (agentId === state.viewingAgentId) {
          exitInternalAgentView();
        } else {
          setInternalAgentView((prev) => ({
            ...prev,
            barIndex: Math.min(Number(prev.barIndex) || 0, Math.max(0, displayAgents.length - 1)),
          }));
        }
        return true;
      }
      return true;
    };

    const handleInternalAgentViewKey = (input, key = {}) => {
      if (!state.viewingAgentId) return false;
      const keyName = resolveInternalKeyName(input, key);

      if (state.focusMode === "dashboard") {
        return handleInternalAgentDashboardKey(input, key);
      }

      if (keyName === "escape") {
        exitInternalAgentView();
        return true;
      }
      if (keyName === "down") {
        setInternalAgentView((prev) => ({ ...prev, barIndex: 0 }));
        dispatch({ type: "focus/set", mode: "dashboard" });
        return true;
      }
      if (keyName === "return" || keyName === "enter") {
        submitInternalAgentInput();
        return true;
      }
      if (key && key.ctrl && keyName === "u") {
        setInternalAgentView((prev) => ({ ...prev, input: "", cursor: 0 }));
        return true;
      }
      if (key && key.ctrl && keyName === "a") {
        setInternalAgentView((prev) => ({ ...prev, cursor: 0 }));
        return true;
      }
      if (key && key.ctrl && keyName === "e") {
        setInternalAgentView((prev) => ({ ...prev, cursor: String(prev.input || "").length }));
        return true;
      }
      if (keyName === "left") {
        setInternalAgentView((prev) => ({
          ...prev,
          cursor: previousInternalBoundary(prev.input, prev.cursor),
        }));
        return true;
      }
      if (keyName === "right") {
        setInternalAgentView((prev) => ({
          ...prev,
          cursor: nextInternalBoundary(prev.input, prev.cursor),
        }));
        return true;
      }
      if (keyName === "backspace") {
        setInternalAgentView((prev) => {
          const cursor = Number.isFinite(prev.cursor) ? prev.cursor : String(prev.input || "").length;
          if (cursor <= 0) return prev;
          const previous = previousInternalBoundary(prev.input, cursor);
          return {
            ...prev,
            input: String(prev.input || "").slice(0, previous) + String(prev.input || "").slice(cursor),
            cursor: previous,
          };
        });
        return true;
      }
      if (keyName === "delete") {
        setInternalAgentView((prev) => {
          const text = String(prev.input || "");
          const cursor = Number.isFinite(prev.cursor) ? prev.cursor : text.length;
          if (cursor >= text.length) return prev;
          const next = nextInternalBoundary(text, cursor);
          return {
            ...prev,
            input: text.slice(0, cursor) + text.slice(next),
            cursor,
          };
        });
        return true;
      }
      if (input
          && !(key && key.ctrl)
          && !(key && key.meta)
          && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]+$/.test(input)) {
        const clean = String(input).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        setInternalAgentView((prev) => {
          const text = String(prev.input || "");
          const cursor = Number.isFinite(prev.cursor) ? prev.cursor : text.length;
          return {
            ...prev,
            input: text.slice(0, cursor) + clean + text.slice(cursor),
            cursor: cursor + clean.length,
          };
        });
        return true;
      }
      return true;
    };

    useInput((input, key) => {
      if (multiWindowActive) {
        const controller = multiWindowControllerRef.current;
        const termFocused = mwTerminalFocusedRef.current;
        if (key.ctrl && input === "q") {
          if (controller && typeof controller.handleKey === "function") {
            controller.handleKey({ name: "q", ctrl: true, sequence: "" });
          }
          mwTerminalFocusedRef.current = false;
          setMwTerminalFocused(false);
          return;
        }
        if (key.ctrl && input === "w") {
          const agents = controller ? controller.getAgentIds() : [];
          if (agents.length === 0) return;
          if (!termFocused) {
            if (controller) controller.focusAgent(agents[0]);
            mwTerminalFocusedRef.current = true;
            setMwTerminalFocused(true);
          } else {
            const current = controller ? controller.getFocused() : null;
            const idx = current ? agents.indexOf(current) : -1;
            if (idx >= 0 && idx < agents.length - 1) {
              controller.focusAgent(agents[idx + 1]);
            } else {
              mwTerminalFocusedRef.current = false;
              setMwTerminalFocused(false);
              if (controller) controller.focusAgent(agents[0]);
            }
          }
          if (controller) controller.renderAll();
          return;
        }
        if (termFocused && controller && typeof controller.sendInput === "function") {
          const now = Date.now();
          const last = mwLastInputRef.current;
          if (input === " " && !key.ctrl && !key.meta && isCJK(last.char) && now - last.time < 150) {
            return;
          }
          const raw = inkKeyToRaw(input, key);
          if (raw) {
            const cleaned = raw.length > 1 && /[⺀-鿿가-힯豈-﫿︰-﹏]/.test(raw)
              ? raw.replace(/ +$/, "")
              : raw;
            if (cleaned) {
              controller.sendInput(cleaned);
              const lastChar = cleaned[cleaned.length - 1];
              mwLastInputRef.current = { char: lastChar, time: now };
            }
          }
          return;
        }
      }
      if (key.ctrl && input === "c") { exit(); return; }
      if (key.ctrl && input === "o") { dispatch({ type: "merge/expand" }); return; }
      if (state.viewingAgentId) {
        handleInternalAgentViewKey(input, key);
        return;
      }

      // Completion popup steals arrow/Enter/Esc/Tab while it's open. The
      // user types to filter, picks with the cursor and accepts with Tab
      // or Enter; Esc dismisses by clearing the trigger character.
      if (completionsOpen) {
        if (key.upArrow) {
          setCompletionIndex((i) => {
            const next = (i - 1 + completions.length) % completions.length;
            setCompletionWindowStart((ws) => {
              if (next < ws) return next;
              if (next === completions.length - 1) {
                // wrapped to the bottom — snap window to the tail.
                return Math.max(0, completions.length - POPUP_PAGE_SIZE);
              }
              return ws;
            });
            return next;
          });
          return;
        }
        if (key.downArrow) {
          setCompletionIndex((i) => {
            const next = (i + 1) % completions.length;
            setCompletionWindowStart((ws) => {
              if (next === 0) return 0; // wrapped to the head
              if (next >= ws + POPUP_PAGE_SIZE) return next - POPUP_PAGE_SIZE + 1;
              return ws;
            });
            return next;
          });
          return;
        }
        if (key.return || key.tab) { acceptCompletion(); return; }
        if (key.escape) {
          setCompletionSuppressedDraft(null);
          dispatch({ type: "draft/clear" });
          return;
        }
      }

      if (key.tab) {
        if (state.focusMode === "dashboard") {
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        dispatch({ type: "focus/set", mode: "dashboard" });
        dispatch({ type: "view/set", view: props.globalMode ? "projects" : "agents" });
        if (props.globalMode && state.projects.length > 0 && state.selectedProjectIndex < 0) {
          dispatch({ type: "view/set", view: "projects" });
          dispatch({ type: "projects/select", index: 0, projectRoot: resolveProjectRowRoot(state.projects[0]) });
        } else if (!props.globalMode && state.agents.length > 0 && state.selectedAgentIndex < 0) {
          dispatch({ type: "agents/select", index: 0 });
        } else if (props.globalMode && state.projects.length === 0) {
          dispatch({ type: "view/set", view: "agents" });
          if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
            dispatch({ type: "agents/select", index: 0 });
          }
        }
        return;
      }
      // Dashboard focus + agents view + agent selected + Enter: hand off
      // to the agent view. Queue-only internal agents stay inside Ink,
      // matching blessed's useBus view; PTY/socket agents still hand off
      // to the raw mirror via the runChatInk loop.
      if (key.return && state.focusMode === "dashboard"
          && state.dashboardView === "agents"
          && state.agentSelectionMode
          && state.selectedAgentIndex >= 0) {
        const agentId = displayAgents[state.selectedAgentIndex];
        if (agentId && multiWindowActive) {
          const controller = multiWindowControllerRef.current;
          if (controller && typeof controller.focusAgent === "function") {
            controller.focusAgent(agentId);
          }
          setMwTerminalFocused(true);
          mwTerminalFocusedRef.current = true;
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (agentId) {
          const enterPayload = buildAgentEnterPayload(agentId);
          const action = resolveDashboardAgentEnterAction(enterPayload);
          if (action === "internal") {
            enterInternalAgentView(enterPayload);
            return;
          }
          if (action === "activate") {
            dispatch({ type: "agents/clearTarget" });
            dispatch({ type: "focus/set", mode: "input" });
            activateExternalAgent(agentId);
            return;
          }
          if (typeof props.requestEnterAgentView === "function") {
            props.requestEnterAgentView(agentId, enterPayload);
            exit();
          }
        }
        return;
      }
      // Dashboard focus + projects view: ←/→ moves the highlighted
      // project, Enter switches the daemon connection to that project,
      // Ctrl+X stops it.
      if (state.focusMode === "dashboard" && state.dashboardView === "projects" && state.projects.length === 0) {
        if (key.downArrow) {
          for (const action of buildEmptyProjectsDownActions(state, displayAgents)) dispatch(action);
          return;
        }
        if (key.upArrow || key.return || key.escape) {
          dispatch({ type: "focus/set", mode: "input" });
        }
        return;
      }
      if (state.focusMode === "dashboard" && state.dashboardView === "projects" && state.projects.length > 0) {
        if (key.leftArrow || key.rightArrow) {
          const cur = Number.isFinite(state.selectedProjectIndex) && state.selectedProjectIndex >= 0
            ? state.selectedProjectIndex : 0;
          const next = key.leftArrow
            ? Math.max(0, cur - 1)
            : Math.min(state.projects.length - 1, cur + 1);
          if (next === cur) return;
          dispatch({ type: "projects/select", index: next, projectRoot: resolveProjectRowRoot(state.projects[next]) });
          // Slide the visible window to keep the cursor on screen. We mirror
          // clampAgentWindowWithSelection's logic with maxProjectWindow=5.
          const max = Math.max(1, Math.min(5, state.projects.length));
          let nextStart = state.projectListWindowStart || 0;
          if (next < nextStart) nextStart = next;
          else if (next >= nextStart + max) nextStart = next - max + 1;
          if (nextStart !== state.projectListWindowStart) {
            dispatch({ type: "projects/window", windowStart: nextStart });
          }

          const proj = state.projects[next];
          const target = resolveProjectRowRoot(proj);
          if (target && state.globalScope === "project") {
            void switchToProjectRoot(target);
          }
          return;
        }
        if (key.return) {
          const cur = state.selectedProjectIndex >= 0 ? state.selectedProjectIndex : 0;
          const proj = state.projects[cur];
          const target = resolveProjectRowRoot(proj);
          void switchToProjectRoot(target, { focusInput: true });
          return;
        }
        if (input
            && !(key && key.ctrl)
            && !(key && key.meta)
            && !/^[\x00-\x1f\x7f]+$/.test(input)
            && !input.includes("\n")
            && !input.includes("\r")) {
          const cur = state.selectedProjectIndex >= 0 ? state.selectedProjectIndex : 0;
          const target = resolveProjectRowRoot(state.projects[cur]);
          void switchToProjectRoot(target, { focusInput: true });
          dispatch({ type: "draft/set", value: `${state.draft || ""}${input}` });
          setDraftVersion((v) => v + 1);
          return;
        }
        if (key.ctrl && input === "x") {
          void closeSelectedProject();
          return;
        }
        if (key.upArrow) {
          // Up out of projects → toggle back to input.
          dispatch({ type: "projects/clearSelection" });
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (key.escape) {
          dispatch({ type: "projects/clearSelection" });
          if (state.globalScope === "project") {
            void switchToControllerRoot();
            return;
          }
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (key.downArrow) {
          // Down from projects → agents row stays in dashboard focus.
          dispatch({ type: "view/set", view: "agents" });
          if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
            dispatch({ type: "agents/select", index: 0 });
          }
          return;
        }
      }

      if (state.focusMode === "dashboard"
          && state.dashboardView === "agents"
          && input
          && !(key && key.ctrl)
          && !(key && key.meta)
          && !/^[\x00-\x1f\x7f]+$/.test(input)
          && !input.includes("\n")
          && !input.includes("\r")) {
        if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
          dispatch({ type: "agents/select", index: 0 });
        }
        dispatch({ type: "focus/set", mode: "input" });
        dispatch({ type: "draft/set", value: `${state.draft || ""}${input}` });
        setDraftVersion((v) => v + 1);
        return;
      }

      // Dashboard focus on agents/mode/provider/cron — ↑↓ flip between
      // sibling views, ←/→ pick within the active view, Esc returns to
      // the input. Mirrors the blessed handlers in dashboardKeyController.
      if (state.focusMode === "dashboard"
          && (state.dashboardView === "agents"
              || state.dashboardView === "mode"
              || state.dashboardView === "provider"
              || state.dashboardView === "cron")) {
        if (key.escape) {
          if (state.dashboardView === "agents") dispatch({ type: "agents/clearTarget" });
          dispatch({ type: "focus/set", mode: "input" });
          return;
        }
        if (state.dashboardView === "agents") {
          if (key.leftArrow || key.rightArrow) {
            if (displayAgents.length > 0) {
              const cur = state.selectedAgentIndex < 0 ? 0 : state.selectedAgentIndex;
              const next = key.leftArrow
                ? Math.max(0, cur - 1)
                : Math.min(displayAgents.length - 1, cur + 1);
              dispatch({ type: "agents/select", index: next });
            }
            return;
          }
          if (key.ctrl && input === "x") {
            if (state.selectedAgentIndex >= 0 && state.selectedAgentIndex < displayAgents.length) {
              const agentId = displayAgents[state.selectedAgentIndex];
              try {
                const { IPC_REQUEST_TYPES } = require("../../shared/eventContract");
                if (props.daemonConnection && typeof props.daemonConnection.send === "function") {
                  props.daemonConnection.send({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: agentId });
                }
              } catch (err) {
                dispatch({ type: "log/append", text: `Error: ${err && err.message ? err.message : err}` });
              }
              dispatch({ type: "agents/clearTarget" });
              dispatch({ type: "focus/set", mode: "input" });
            }
            return;
          }
          if (key.return) {
            dispatch({ type: "focus/set", mode: "input" });
            return;
          }
          if (key.downArrow) {
            dispatch({ type: "view/set", view: "mode" });
            const launchModeIndex = state.modeOptions.indexOf(state.settings.launchMode);
            dispatch({ type: "modeIndex/set", index: launchModeIndex >= 0 ? launchModeIndex : 0 });
            return;
          }
          if (key.upArrow) {
            // Top of the agents tier: in global mode go back to projects,
            // otherwise leave dashboard focus altogether.
            dispatch({ type: "agents/clearTarget" });
            if (props.globalMode) dispatch({ type: "view/set", view: "projects" });
            else dispatch({ type: "focus/set", mode: "input" });
            return;
          }
        }
        if (state.dashboardView === "mode") {
          if (key.leftArrow || key.rightArrow) {
            const len = state.modeOptions.length;
            if (len > 0) {
              const cur = state.selectedModeIndex;
              const next = key.leftArrow
                ? Math.max(0, cur - 1)
                : Math.min(len - 1, cur + 1);
              if (next !== cur) dispatch({ type: "modeIndex/set", index: next });
            }
            return;
          }
          if (key.downArrow) {
            dispatch({ type: "view/set", view: "provider" });
            const providerIndex = state.providerOptions.findIndex((opt) => opt.value === state.settings.agentProvider);
            dispatch({ type: "providerIndex/set", index: providerIndex >= 0 ? providerIndex : 0 });
            return;
          }
          if (key.upArrow) { dispatch({ type: "view/set", view: "agents" }); return; }
          if (key.return) { applySelectedMode(); return; }
        }
        if (state.dashboardView === "provider") {
          if (key.leftArrow || key.rightArrow) {
            const len = state.providerOptions.length;
            if (len > 0) {
              const cur = state.selectedProviderIndex;
              const next = key.leftArrow
                ? Math.max(0, cur - 1)
                : Math.min(len - 1, cur + 1);
              if (next !== cur) dispatch({ type: "providerIndex/set", index: next });
            }
            return;
          }
          if (key.downArrow) {
            dispatch({ type: "view/set", view: "cron" });
            dispatch({ type: "cronIndex/set", index: state.cronTasks.length > 0 ? 0 : -1 });
            return;
          }
          if (key.upArrow) { dispatch({ type: "view/set", view: "mode" }); return; }
          if (key.return) { applySelectedProvider(); return; }
        }
        if (state.dashboardView === "cron") {
          if (key.leftArrow || key.rightArrow) {
            const len = state.cronTasks.length;
            if (len > 0) {
              const cur = state.selectedCronIndex < 0 ? 0 : state.selectedCronIndex;
              const next = key.leftArrow ? Math.max(0, cur - 1) : Math.min(len - 1, cur + 1);
              if (next !== cur) dispatch({ type: "cronIndex/set", index: next });
            }
            return;
          }
          if (key.downArrow) {
            // Cron is the last tier — don't wrap back to agents.
            return;
          }
          if (key.upArrow) { dispatch({ type: "view/set", view: "provider" }); return; }
          if (key.ctrl && input === "x") {
            const maxIndex = state.cronTasks.length - 1;
            if (maxIndex >= 0 && state.selectedCronIndex >= 0 && state.selectedCronIndex <= maxIndex) {
              const task = state.cronTasks[state.selectedCronIndex];
              const id = task && task.id ? String(task.id).trim() : "";
              if (id) {
                sendCronStop(id);
                return;
              }
            }
            dispatch({ type: "focus/set", mode: "input" });
            return;
          }
          if (key.return) { dispatch({ type: "focus/set", mode: "input" }); return; }
        }
      }

      // Multi-window typing handler: replicates MultilineInput's key handling
      // so both modes share the same input behavior.
      if (multiWindowActive && state.focusMode !== "dashboard") {
        const intercepted = completionsOpen && (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.return);
        if (intercepted) return;
        if (key.return) {
          if (key.meta) {
            const before = (state.draft || "").slice(0, mwCursor);
            const after = (state.draft || "").slice(mwCursor);
            dispatch({ type: "draft/set", value: `${before}\n${after}` });
            setMwCursor(mwCursor + 1);
            return;
          }
          const value = String(state.draft || "").trim();
          if (value) { submit(value); setMwCursor(0); }
          return;
        }
        if (key.escape) {
          if (state.agentSelectionMode) { dispatch({ type: "agents/clearTarget" }); return; }
          if (state.draft) { dispatch({ type: "draft/clear" }); setMwCursor(0); }
          else if (state.status && state.status.message) { dispatch({ type: "status/idle" }); }
          return;
        }
        if (key.ctrl) {
          if (input === "a") { setMwCursor(fmt.moveCursorToVisualLineBoundary({ cursorPos: mwCursor, inputValue: state.draft || "", width: inputWidth, boundary: "start" })); return; }
          if (input === "e") { setMwCursor(fmt.moveCursorToVisualLineBoundary({ cursorPos: mwCursor, inputValue: state.draft || "", width: inputWidth, boundary: "end" })); return; }
          if (input === "b") { setMwCursor(fmt.moveCursorHorizontally(mwCursor, state.draft || "", "left")); return; }
          if (input === "f") { setMwCursor(fmt.moveCursorHorizontally(mwCursor, state.draft || "", "right")); return; }
          if (input === "d") { const d = state.draft || ""; if (mwCursor < d.length) { dispatch({ type: "draft/set", value: d.slice(0, mwCursor) + d.slice(mwCursor + 1) }); } return; }
          if (input === "h") { const d = state.draft || ""; if (mwCursor > 0) { dispatch({ type: "draft/set", value: d.slice(0, mwCursor - 1) + d.slice(mwCursor) }); setMwCursor(mwCursor - 1); } return; }
          if (input === "k") { dispatch({ type: "draft/set", value: (state.draft || "").slice(0, mwCursor) }); return; }
          if (input === "u") { dispatch({ type: "draft/set", value: (state.draft || "").slice(mwCursor) }); setMwCursor(0); return; }
          if (input === "w") { const r = fmt.deleteWordBeforeCursor(state.draft || "", mwCursor); dispatch({ type: "draft/set", value: r.value }); setMwCursor(r.cursorPos); return; }
          return;
        }
        if (key.meta) {
          if (input === "b") { setMwCursor(fmt.moveCursorByWord(state.draft || "", mwCursor, "backward")); return; }
          if (input === "f") { setMwCursor(fmt.moveCursorByWord(state.draft || "", mwCursor, "forward")); return; }
          if (input === "d") { const end = fmt.moveCursorByWord(state.draft || "", mwCursor, "forward"); const d = state.draft || ""; dispatch({ type: "draft/set", value: d.slice(0, mwCursor) + d.slice(end) }); return; }
        }
        if (key.backspace || key.delete) {
          const d = state.draft || "";
          if (key.meta || key.ctrl) { const r = fmt.deleteWordBeforeCursor(d, mwCursor); dispatch({ type: "draft/set", value: r.value }); setMwCursor(r.cursorPos); }
          else if (mwCursor > 0) { dispatch({ type: "draft/set", value: d.slice(0, mwCursor - 1) + d.slice(mwCursor) }); setMwCursor(mwCursor - 1); }
          return;
        }
        if (key.leftArrow) {
          if (!state.draft && typeof onArrowSideAtEmpty === "function") { onArrowSideAtEmpty("left"); return; }
          setMwCursor(fmt.moveCursorHorizontally(mwCursor, state.draft || "", "left"));
          return;
        }
        if (key.rightArrow) {
          if (!state.draft && typeof onArrowSideAtEmpty === "function") { onArrowSideAtEmpty("right"); return; }
          setMwCursor(fmt.moveCursorHorizontally(mwCursor, state.draft || "", "right"));
          return;
        }
        if (key.upArrow) { onArrowUpAtTop(); return; }
        if (key.downArrow) { onArrowDownAtBottom(state.draft); return; }
        if (input && !key.ctrl && !key.meta) {
          const filtered = input.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
          if (filtered) {
            const d = state.draft || "";
            dispatch({ type: "draft/set", value: d.slice(0, mwCursor) + filtered + d.slice(mwCursor) });
            setMwCursor(mwCursor + filtered.length);
          }
          return;
        }
        return;
      }
    }, { isActive: interactive });

    const statusText = computeStatusText(state.status, spinnerTick);
    const inputWidth = Math.max(20, (size.cols || 80) - 4);
    const promptPrefix = (() => {
      const projectPrefix = inCommittedProjectScope && currentProjectLabel ? `${currentProjectLabel} ` : "";
      const visibleTargetAgentLabel = state.focusMode === "dashboard" && state.dashboardView !== "agents"
        ? ""
        : targetAgentLabel;
      if (visibleTargetAgentLabel) return `${projectPrefix}›@${visibleTargetAgentLabel} `;
      return `${projectPrefix}› `;
    })();

    if (multiWindowActive) {
      const { renderDashboardLines } = require("./DashboardBar");
      const clampedCursor = fmt.clampCursorPos(mwCursor, state.draft || "");
      multiWindowChromeRef.current = {
        statusText,
        promptPrefix,
        draft: state.draft || "",
        cursor: clampedCursor,
        completions: completionsOpen ? completions : [],
        completionIndex: completionsOpen ? completionIndex : -1,
        completionWindowStart: completionsOpen ? completionWindowStart : 0,
        completionPageSize: POPUP_PAGE_SIZE,
        dashboardLines: renderDashboardLines({
          dashboardView: state.dashboardView,
          focusMode: state.focusMode,
          globalMode: state.globalMode,
          globalScope: state.globalScope,
          activeAgents: displayAgents,
          activeAgentMeta: displayAgentMeta,
          activeAgentId: targetAgentId || "",
          selectedAgentIndex: state.selectedAgentIndex,
          agentListWindowStart: state.agentListWindowStart,
          projectListWindowStart: state.projectListWindowStart,
          maxProjectWindow: 5,
          maxWidth: Math.max(20, size.cols || 80),
          getAgentLabel: (id) => getAgentLabelFor(displayAgentMeta.get(id), id),
          getAgentState: (id) => {
            const meta = displayAgentMeta.get(id);
            return meta && typeof meta.activity_state === "string" ? meta.activity_state : "";
          },
          launchMode: state.settings.launchMode,
          agentProvider: state.settings.agentProvider,
          modeOptions: state.modeOptions,
          selectedModeIndex: state.selectedModeIndex,
          providerOptions: state.providerOptions,
          selectedProviderIndex: state.selectedProviderIndex,
          cronTasks: state.cronTasks,
          selectedCronIndex: state.selectedCronIndex,
          projects: state.projects,
          selectedProjectIndex: state.selectedProjectIndex,
          activeProjectRoot: currentProjectRoot,
          dashHints: buildDashHints(state, targetAgentLabel),
        }),
      };
    }

    useEffect(() => {
      if (!multiWindowActive) return;
      const controller = multiWindowControllerRef.current;
      if (controller && typeof controller.renderAll === "function") {
        controller.renderAll();
      }
    }, [multiWindowActive, completionsOpen, completions.length, completionIndex, completionWindowStart]);

    if (multiWindowActive) {
      return null;
    }

    const renderChatLogLine = (item) => {
      const row = classifyChatLogLine((item && item.text) || "");
      const key = item && item.id ? item.id : `log-${row.body}`;
      if (row.kind === "spacer") {
        return h(Text, { key, color: "gray" }, " ");
      }
      const palette = {
        assistant: { marker: "cyan", speaker: "white", body: undefined, bold: true },
        agent: { marker: "cyan", speaker: "cyan", body: undefined, bold: false },
        error: { marker: "red", speaker: "red", body: "red", bold: true },
        success: { marker: "green", speaker: "green", body: "green", bold: false },
        divider: { marker: "gray", speaker: "gray", body: "gray", bold: false },
        banner: { marker: "cyan", speaker: "cyan", body: "cyan", bold: true },
        meta: { marker: "gray", speaker: "gray", body: "gray", bold: false },
        plain: { marker: "gray", speaker: "gray", body: undefined, bold: false },
      };
      const colors = palette[row.kind] || palette.plain;
      if (row.kind === "divider") {
        return h(Box, { key, marginBottom: 1 },
          h(Text, { color: colors.body, wrap: "truncate" }, row.body),
        );
      }
      if (row.kind === "banner") {
        return h(Box, { key, marginBottom: 1 },
          h(Text, { color: colors.body, bold: true, wrap: "truncate" }, row.body),
        );
      }
      return h(Box, { key, width: "100%", marginBottom: 1 },
        h(Box, { width: 2 },
          h(Text, { color: colors.marker, bold: row.kind === "error" }, row.marker || " "),
        ),
        row.speaker
          ? h(Text, { color: colors.speaker, bold: colors.bold }, row.speaker)
          : null,
        row.speaker
          ? h(Text, { color: "gray" }, " · ")
          : null,
        h(Text, { color: colors.body, wrap: "wrap" }, row.body || " "),
      );
    };

    if (state.viewingAgentId) {
      const maxWidth = Math.max(20, size.cols || 80);
      const logRows = Math.max(1, (size.rows || 24) - 5);
      const visibleRows = buildInternalLogRows(internalAgentView.lines || [], maxWidth, logRows);
      const status = internalStatusLabel(internalAgentView.status);
      const internalStatusText = computeInternalStatusText(internalAgentView, spinnerTick);
      const internalStatusColor = status === "blocked" ? "red" : (status === "ready" ? "gray" : "cyan");
      const inputText = String(internalAgentView.input || "");
      const cursor = Math.max(0, Math.min(inputText.length, Number(internalAgentView.cursor) || 0));
      const beforeCursor = inputText.slice(0, cursor);
      const cursorChar = inputText.slice(cursor, nextInternalBoundary(inputText, cursor)) || " ";
      const afterCursor = inputText.slice(cursor + (cursorChar === " " ? 0 : cursorChar.length));
      const barFocused = state.focusMode === "dashboard";
      const barIndex = Math.max(
        0,
        Math.min(displayAgents.length, Number(internalAgentView.barIndex) || 0),
      );
      const barHint = barFocused ? "│ ←/→ · Enter · ↑ · ^X" : "│ ↓ agents";
      const barItem = (text, index, options = {}) => {
        const keyboardSelected = barFocused && barIndex === index;
        return h(Text, {
          key: `agent-bar-${index}-${text}`,
          color: keyboardSelected || options.current === true ? undefined : "cyan",
          inverse: keyboardSelected,
          bold: options.current === true,
          wrap: "truncate",
        }, text);
      };
      const agentBarChildren = displayAgents.length === 0
        ? [h(Text, { key: "agent-bar-none", color: "cyan", wrap: "truncate" }, "none")]
        : displayAgents.flatMap((id, idx) => {
          const meta = displayAgentMeta.get(id);
          return [
            idx > 0 ? h(Text, { key: `agent-bar-space-${id}`, color: "gray", wrap: "truncate" }, "  ") : null,
            barItem(getAgentLabelFor(meta, id), idx + 1, {
              current: isInternalViewingAgent(id, meta, internalAgentView, state.viewingAgentId),
            }),
          ];
        }).filter(Boolean);
      return h(Box, { flexDirection: "column", width: "100%" },
        h(Box, { flexDirection: "column", width: "100%" },
          ...visibleRows.map((row, idx) => {
            const kind = row && row.kind ? row.kind : "agent";
            const color = kind === "user"
              ? "cyan"
              : (kind === "system" || kind === "meta" || kind === "spacer" ? "gray" : (kind === "error" ? "red" : undefined));
            return h(Text, {
              key: `agent-log-${idx}`,
              color,
              bold: Boolean(row && row.bold),
              wrap: "truncate",
            }, (row && row.text) || " ");
          }),
        ),
        h(Text, { color: internalStatusColor, wrap: "truncate" },
          fitPlainLine(internalStatusText, maxWidth)),
        h(Text, { color: "gray", wrap: "truncate" }, "─".repeat(maxWidth)),
        h(Box, { width: "100%" },
          h(Text, { color: "magenta" }, "› "),
          beforeCursor ? h(Text, { wrap: "truncate" }, beforeCursor) : null,
          h(Text, { inverse: true }, cursorChar),
          afterCursor ? h(Text, { wrap: "truncate" }, afterCursor) : null,
        ),
        h(Text, { color: "gray", wrap: "truncate" }, "─".repeat(maxWidth)),
        h(Box, { width: "100%" },
          h(Text, { color: "gray", wrap: "truncate" }, " "),
          barItem("ufoo", 0),
          h(Text, { color: "gray", wrap: "truncate" }, "  "),
          ...agentBarChildren,
          h(Text, { color: "gray", wrap: "truncate" }, `  ${barHint}`),
        ),
      );
    }

    return h(Box, { flexDirection: "column", width: "100%" },
      h(Box, { flexDirection: "column", width: "100%" },
        ...state.logLines.map(renderChatLogLine),
      ),
      state.activeMerge ? h(Box, null,
        h(Text, { color: state.activeMerge.entries.some((e) => e.isError) ? "red" : "cyan" },
          fmt.buildToolMergeRowText(state.activeMerge.entries)),
      ) : null,
      state.activeStream ? h(Box, { flexDirection: "column" },
        ...(() => {
          const lines = String(state.activeStream.text || "").split(/\r?\n/);
          const prefix = state.activeStream.publisher
            ? `${state.activeStream.publisher}: `
            : "";
          return lines.map((line, idx) => renderChatLogLine({
            id: `s-${idx}`,
            text: idx === 0 ? `${prefix}${line}` : `  ${line}`,
          }));
        })(),
      ) : null,
      h(Box, { marginTop: 1, width: "100%" },
        h(Text, { color: "gray" }, statusText),
        h(Box, { flexGrow: 1 }),
        h(Text, { color: "gray" }, `v${fmt.UCODE_VERSION}`),
      ),
      completionsOpen ? (() => {
        const start = Math.min(completionWindowStart, Math.max(0, completions.length - POPUP_PAGE_SIZE));
        const end = Math.min(completions.length, start + POPUP_PAGE_SIZE);
        const visible = completions.slice(start, end);
        return h(Box, { flexDirection: "column" },
          h(Text, { color: "gray" }, "─".repeat(Math.max(8, size.cols || 80))),
          ...visible.map((s, idxInWindow) => {
            const idx = start + idxInWindow;
            return h(Box, { key: `cmp-${idx}` },
              h(Text, { color: idx === completionIndex ? "cyan" : "gray", inverse: idx === completionIndex }, s.label),
              s.description ? h(Text, { color: "gray" }, `  ${s.description}`) : null,
            );
          }),
        );
      })() : null,
      h(Box, { width: "100%" },
        h(MultilineInput, {
          value: state.draft,
          valueVersion: draftVersion,
          onChange: (next) => {
            if (completionSuppressedDraft !== null && next !== completionSuppressedDraft) {
              setCompletionSuppressedDraft(null);
            }
            dispatch({ type: "draft/set", value: next });
          },
          onSubmit: (value) => {
            setCompletionSuppressedDraft(null);
            submit(value);
          },
          onCancel: () => {
            setCompletionSuppressedDraft(null);
            if (props.globalMode && state.globalScope === "project") {
              void switchToControllerRoot();
              return;
            }
            // Esc clears the current target if one is locked, otherwise
            // dismisses the in-flight task status. There's no per-request
            // AbortController on daemonConnection (the IPC layer is fire-
            // and-forget), so we clear the spinner so the user knows the
            // UI is responsive again.
            if (state.agentSelectionMode) {
              dispatch({ type: "agents/clearTarget" });
              return;
            }
            if (state.status && state.status.message) {
              dispatch({ type: "status/idle" });
            }
          },
          onArrowUpAtTop,
          onArrowDownAtBottom,
          onArrowLeftAtEmpty: () => onArrowSideAtEmpty("left"),
          onArrowRightAtEmpty: () => onArrowSideAtEmpty("right"),
          width: inputWidth,
          interactive: interactive && state.focusMode !== "dashboard",
          interceptArrowsAndEnter: completionsOpen,
          placeholder: "",
          promptPrefix,
          // Dashboard renders 2 rows in global mode (always shows the
          // projects rail) or when an agents/mode/provider/cron view is
          // focused; otherwise it's a single summary row. Telling
          // MultilineInput how many UI rows live below it lets the IME
          // composition popup follow the on-screen caret instead of
          // appearing at the bottom-right of the terminal.
          linesBelowInput: props.globalMode
            ? 2
            : (state.focusMode === "dashboard" ? 2 : 1),
        }),
      ),
      h(DashboardBar, {
        dashboardView: state.dashboardView,
        focusMode: state.focusMode,
        globalMode: state.globalMode,
        globalScope: state.globalScope,
        activeAgents: displayAgents,
        activeAgentMeta: displayAgentMeta,
        activeAgentId: targetAgentId || "",
        selectedAgentIndex: state.selectedAgentIndex,
        agentListWindowStart: state.agentListWindowStart,
        projectListWindowStart: state.projectListWindowStart,
        maxProjectWindow: 5,
        maxWidth: Math.max(20, size.cols || 80),
        getAgentLabel: (id) => getAgentLabelFor(displayAgentMeta.get(id), id),
        getAgentState: (id) => {
          const meta = displayAgentMeta.get(id);
          return meta && typeof meta.activity_state === "string" ? meta.activity_state : "";
        },
        launchMode: state.settings.launchMode,
        agentProvider: state.settings.agentProvider,
        modeOptions: state.modeOptions,
        selectedModeIndex: state.selectedModeIndex,
        providerOptions: state.providerOptions,
        selectedProviderIndex: state.selectedProviderIndex,
        cronTasks: state.cronTasks,
        selectedCronIndex: state.selectedCronIndex,
        projects: state.projects,
        selectedProjectIndex: state.selectedProjectIndex,
        activeProjectRoot: currentProjectRoot,
        dashHints: buildDashHints(state, targetAgentLabel),
      }),
    );
  };
}

function buildDashHints(state, targetAgentLabel) {
  void targetAgentLabel; // navigation hint removed by request
  return {
    agents: "←/→ select · Enter · ↓ mode · ↑ back",
    agentsGlobal: "←/→ select · Enter · ↓ mode · ↑ projects",
    agentsEmpty: "↓ mode · ↑ back",
    mode: "←/→ select · Enter · ↓ provider · ↑ back",
    provider: "←/→ select · Enter · ↓ cron · ↑ back",
    cron: "←/→ switch · Ctrl+X stop · ↑ back",
    projects: "Use /open <path> or /project switch <index|path>",
    projectsFocus: "←/→ switch · Ctrl+X close · ↓ second row · Enter confirm · ↑ back",
    projectsEmpty: "Run ufoo chat or ufoo daemon start in project directories",
  };
}

function computeStatusText(status, spinnerTick) {
  const message = String((status && status.message) || "");
  if (!message) return "CHAT · Ready";
  const type = String((status && status.type) || "thinking");
  if (type === "done" || type === "success") {
    const clean = stripBlessedTags(message).trim();
    return /^[✓✔]/.test(clean) ? clean : `✓ ${clean}`;
  }
  if (type === "error") {
    const clean = stripBlessedTags(message).trim();
    return /^[✗!]/.test(clean) ? clean : `✗ ${clean}`;
  }
  if (!isAnimatedStatusType(type)) return stripBlessedTags(message).trim() || "CHAT · Ready";
  const indicators = fmt.STATUS_INDICATORS[type] || fmt.STATUS_INDICATORS.thinking;
  const indicator = indicators[Math.max(0, Math.floor(Number(spinnerTick) || 0)) % indicators.length];
  const startedAt = Number.isFinite(status && status.startedAt) ? status.startedAt : 0;
  const timerText = status && status.showTimer && startedAt
    ? ` (${fmt.formatPendingElapsed(Date.now() - startedAt)}, esc cancel)`
    : "";
  return `${indicator} ${message}${timerText}`;
}

async function runChatInk(projectRoot, options = {}) {
  const env = bootstrapEnvironment(projectRoot, options);

  if (env.needsBootstrap || !fs.existsSync(env.runtimePaths.ufooDir)) {
    const repoRoot = path.join(__dirname, "..", "..", "..");
    const init = new env.UfooInit(repoRoot);
    await init.init({
      modules: "context,bus",
      project: projectRoot,
      controllerMode: env.globalMode,
    });
  }

  await ensureSubscriberId(projectRoot);

  if (!env.isRunning(projectRoot)) {
    env.startDaemon(projectRoot);
  }

  const { socketPath } = require("../../daemon");
  const { connectWithRetry } = require("../../chat/transport");
  const { createDaemonTransport } = require("../../chat/daemonTransport");
  const { createDaemonConnection } = require("../../chat/daemonConnection");
  const { createDaemonCoordinator } = require("../../chat/daemonCoordinator");
  const { startDaemon, stopDaemon } = require("../../chat/transport");
  const { loadConfig } = require("../../config");
  const { startAgentMirror, startInternalAgentMirror } = require("./agentMirror");
  const sock = socketPath(projectRoot);
  const daemonTransport = createDaemonTransport({
    projectRoot,
    sockPath: sock,
    isRunning: env.isRunning,
    startDaemon: env.startDaemon,
    connectWithRetry,
  });

  // The connection's `handleMessage` callback is filled in by ChatApp once
  // it mounts and has its dispatcher ready. We expose a setter so the
  // component can wire it without ChatApp needing to construct daemon
  // internals itself.
  let routedMessageHandler = () => {};
  const daemonConnection = createDaemonConnection({
    connectClient: daemonTransport.connectClient.bind(daemonTransport),
    handleMessage: (msg) => routedMessageHandler(msg),
    queueStatusLine: () => {},
    resolveStatusLine: () => {},
    logMessage: () => {},
  });
  const daemonCoordinator = createDaemonCoordinator({
    projectRoot,
    daemonTransport,
    daemonConnection,
    stopDaemon,
    startDaemon,
    logMessage: () => {},
    queueStatusLine: () => {},
    resolveStatusLine: () => {},
  });

  // We loop the ink mount so an "enter agent" request can unmount ink,
  // hand stdout/stdin to the raw PTY mirror, then bring ink back on exit.
  let pendingEnter = null;
  const baseProps = {
    activeProjectRoot: env.activeProjectRoot,
    projectRoot,
    globalMode: env.globalMode,
    globalScope: env.globalMode ? "controller" : "project",
    daemonConnection,
    daemonTransport,
    daemonCoordinator,
    env,
    initialSettings: loadConfig(projectRoot),
    setDaemonMessageHandler: (fn) => { routedMessageHandler = typeof fn === "function" ? fn : () => {}; },
    requestEnterAgentView: (agentId, enterOptions = {}) => {
      pendingEnter = {
        agentId,
        options: enterOptions && typeof enterOptions === "object" ? enterOptions : {},
      };
    },
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    pendingEnter = null;
    const handle = await runInk(
      (React, ink) => {
        const ChatApp = createChatApp({ React, ink, props: baseProps });
        return React.createElement(ChatApp);
      },
      { stdin: process.stdin, stdout: process.stdout, exitOnCtrlC: true }
    );

    // Wait until either the user exits the app or ChatApp asks to enter
    // an agent view. The component triggers the latter by setting
    // pendingEnter and then calling handle.unmount() via its onExit.
    await handle.waitUntilExit();
    if (!pendingEnter) return;

    // Hand stdout/stdin to the mirror. When it exits, loop and re-mount.
    const enterRequest = pendingEnter;
    pendingEnter = null;
    const enteredAgentId = enterRequest && enterRequest.agentId;
    const enterOptions = enterRequest && enterRequest.options ? enterRequest.options : {};
    const enteredProjectRoot = enterOptions.projectRoot || projectRoot;
    await new Promise((resolve) => {
      if (enterOptions.useBus) {
        startInternalAgentMirror({
          agentId: enteredAgentId,
          agentLabel: enterOptions.agentLabel,
          agentAliases: enterOptions.agentAliases,
          projectRoot: enteredProjectRoot,
          daemonConnection,
          setDaemonMessageHandler: (fn) => {
            routedMessageHandler = typeof fn === "function" ? fn : () => {};
          },
          onExit: resolve,
        });
        return;
      }
      startAgentMirror({
        agentId: enteredAgentId,
        projectRoot: enteredProjectRoot,
        onExit: resolve,
      });
    });
  }
}

module.exports = {
  runChatInk,
  createChatApp,
  bootstrapEnvironment,
  buildDirectBusSendRequest,
  buildPromptIpcRequest,
  chatHistoryOptionsForScope,
  classifyChatLogLine,
  createInkMultiWindowToggle,
  resolveActiveAgentId,
  resolveInjectSockPathForAgent,
  resolveAgentEnterRequest,
  resolveDashboardAgentEnterAction,
  buildEmptyProjectsDownActions,
  buildInternalLogRows,
  computeStatusText,
  computeInternalStatusText,
  inferStatusType,
  isAnimatedStatusType,
  resolveInternalKeyName,
  isInternalViewingAgent,
  applyInternalAgentTermWrite,
  appendInternalErrorToView,
};
