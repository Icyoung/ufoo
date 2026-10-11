"use strict";

/**
 * Chat / input history persistence (Phase 0B extraction from ChatApp).
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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
  chatHistoryOptionsForScope,
};
