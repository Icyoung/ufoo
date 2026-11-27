"use strict";

/**
 * Chat / input history persistence (Phase 0B extraction from ChatApp).
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TRANSIENT_CONNECTION_PATTERNS = Object.freeze([
  /\bfailed to reconnect to daemon\b/i,
  /\breconnecting to daemon\b/i,
  /\bdaemon offline\b/i,
  /\bdaemon reconnected\b/i,
  /\bdaemon restarted\b/i,
  /\bdaemon switched\b/i,
  /\bdaemon disconnected\b/i,
  /\bdisconnected from daemon\b/i,
  /\bswitching daemon connection\b/i,
  /\bswitch connection timed out\b/i,
  /\bswitch failed\b/i,
  /\bfailed to connect target daemon\b/i,
  /\bconnecting to (?:global)?daemon\b/i,
  /\brestarting daemon\b/i,
  /\bdaemon did not start in time\b/i,
  /\bconnection lost\b/i,
]);

const OPERATIONAL_LIFECYCLE_PATTERNS = Object.freeze([
  /^(?:launched|closed|resumed)\s+(?:a\s+|an\s+|\d+\s+)?[a-z0-9_.:-]+/i,
  /^stopped\s+\d+\s+agent\(s\)/i,
  /^closed project\b/i,
  /^found\s+\d+\s+recoverable agent\(s\)/i,
  /^(?:entered|exited)\s+(?:multi|side)-window\b/i,
  /^no active agents for multi-window mode$/i,
  /^entering agent\s+\S+/i,
  /^returned from agent\b/i,
  /^window layouts unavailable\b/i,
  /^launch mode:\s*\S+/i,
  /^message delivered$/i,
  /^settings:$/i,
  /^ucode config (?:updated|cleared)\b/i,
  /^ufoo-agent:\s+already\s+\S+/i,
  /^thinking:\s*(?:off|low|medium|high|xhigh|max)$/i,
  /^\/(?:model|settings|multi|window|close|launch|provider|daemon|project|open|resume|answer)\b/i,
  /^(?:settings saved|model set to|thinking set to|provider set to)\b/i,
  /^(?:recoverable agents:|no recoverable agents|skipped:)$/i,
  /^group started\b/i,
  /^group:\s+\S+\s+\[(?:active|stopped|dry_run|completed)\]/i,
]);

const OPERATIONAL_BULLET_PATTERNS = Object.freeze([
  /^•\s*(?:agent|router|ucode|use|provider|model|url|transport):\s+/i,
  /^•\s*\S+\s+\[[^\]]+\]\s+\([^)]+\)\s*->\s*\S+/i,
]);

const OPERATIONAL_USER_ECHO_PATTERNS = Object.freeze([
  /^›\s*(?:showing settings|updating settings|showing agent provider|setting agent provider to\b|toggling multi-pane view|setting launch mode to\b|launching\s+(?:a\s+|an\s+|\d+\s+|group\b|solo\b|agent\b|codex\b|claude\b|ucode\b|agy\b|antigravity\b|ufoo\b)|closing\s+|stopping\s+(?:group\b|the ufoo daemon|cron task\b)|starting the ufoo daemon|restarting the ufoo daemon|checking daemon status|switching to project\b|opening project\b|showing current project|listing running projects|resuming\s+|choose an agent or group to resume|opening\s+settings|switching\s+window|clearing the chat log|activating\s+)/i,
]);

function stripFormattingTags(text = "") {
  return String(text || "")
    .replace(/\{\/?[a-z0-9_#-]+(?:-[a-z0-9_-]+)*\}/gi, "")
    .trim();
}

function normalizeOperationalText(text = "") {
  return stripFormattingTags(text)
    .replace(/^(?:ufoo(?:-agent)?\s*·\s*)/i, "")
    .replace(/^[✓✗•›←→]\s*/, "")
    .trim();
}

function isTransientConnectionHistoryEntry(type = "", text = "", meta = {}) {
  if (meta && typeof meta === "object") {
    if (meta.transient === true || meta.ephemeral === true || meta.persist === false) {
      return true;
    }
  }
  const normalizedType = String(type || "").trim().toLowerCase();
  if (normalizedType === "user" || normalizedType === "assistant" || normalizedType === "bus" || normalizedType === "tool" || normalizedType === "thinking") {
    return false;
  }
  const cleaned = stripFormattingTags(text);
  if (!cleaned) return false;
  return TRANSIENT_CONNECTION_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function isOperationalUiHistoryEntry(type = "", text = "", meta = {}) {
  if (meta && typeof meta === "object") {
    if (meta.operational === true || meta.ui_event === true) return true;
  }
  const normalizedType = String(type || "").trim().toLowerCase();
  if (normalizedType === "tool" || normalizedType === "thinking" || normalizedType === "bus") {
    return false;
  }
  const cleaned = stripFormattingTags(text);
  if (!cleaned) return false;
  if (normalizedType === "user") {
    return OPERATIONAL_USER_ECHO_PATTERNS.some((pattern) => pattern.test(cleaned));
  }
  if (normalizedType === "system" && /(?:^|\n)\/answer\s+\S+\s+<reply>\s*$/i.test(cleaned)) {
    return true;
  }
  if (OPERATIONAL_BULLET_PATTERNS.some((pattern) => pattern.test(cleaned))) {
    return true;
  }
  const normalized = normalizeOperationalText(cleaned);
  if (!normalized) return false;
  return OPERATIONAL_LIFECYCLE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldSkipChatHistoryEntry(type = "", text = "", meta = {}) {
  return isTransientConnectionHistoryEntry(type, text, meta)
    || isOperationalUiHistoryEntry(type, text, meta);
}

function projectRootToId(projectRoot) {
  try {
    const { buildProjectId } = require("../../runtime/projects");
    return buildProjectId(projectRoot || process.cwd());
  } catch {
    return crypto.createHash("sha256").update(String(projectRoot || "")).digest("hex").slice(0, 16);
  }
}

function inputHistoryFilePath(projectRoot, options = {}) {
  const { getUfooPaths } = require("../../coordination/state/paths");
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
  const { getUfooPaths } = require("../../coordination/state/paths");
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
        if (!entry || typeof entry !== "object") continue;
        const sourceType = String(entry.type || entry.kind || "system");
        const text = sourceType === "spacer" ? "" : String(entry.text || "").replace(/\r\n?/g, "\n");
        if (!text && sourceType !== "spacer") continue;
        if (shouldSkipChatHistoryEntry(sourceType, text, entry.meta)) continue;
        if (!text.trim() && (!out.length || !out[out.length - 1].text.trim())) continue;
        // A transcript block is the persistence unit. Splitting it into lines
        // loses tool/thinking folds, speakers, paragraphs and fenced code.
        out.push({ ...entry, text, sourceType,
          meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
        });
      } catch {
        // ignore malformed lines
      }
    }
    while (out.length > 0 && !out[out.length - 1].text.trim()) out.pop();
    const capped = out.slice(-cap);
    while (capped.length > 0 && !capped[0].text.trim()) capped.shift();
    return capped;
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
    // best-effort
  }
}

function appendChatHistory(projectRoot, type, text, meta = {}, options = {}) {
  const value = String(text || "");
  if (!value && type !== "spacer") return;
  if (shouldSkipChatHistoryEntry(type, value, meta)) return;
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
    // best-effort
  }
}

function clearChatHistory(projectRoot, options = {}) {
  const file = chatHistoryFilePath(projectRoot, options);
  try {
    if (fs.existsSync(file)) {
      fs.writeFileSync(file, "", "utf8");
    }
    return true;
  } catch {
    return false;
  }
}

function chatHistoryOptionsForScope({ globalMode = false, globalScope = "controller" } = {}) {
  return {
    globalMode: Boolean(globalMode && globalScope !== "project"),
  };
}

module.exports = {
  projectRootToId,
  inputHistoryFilePath,
  chatHistoryFilePath,
  loadChatHistory,
  loadInputHistory,
  appendInputHistory,
  appendChatHistory,
  clearChatHistory,
  chatHistoryOptionsForScope,
  isTransientConnectionHistoryEntry,
  isOperationalUiHistoryEntry,
  shouldSkipChatHistoryEntry,
};
