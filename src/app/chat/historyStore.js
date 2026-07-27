"use strict";

/**
 * Chat / input history persistence (Phase 0B extraction from ChatApp).
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { stripBlessedTags } = require("../../ui/chatLogModel");

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

function normalizeHistoryLogLines(text = "") {
  const clean = stripBlessedTags(text);
  return clean.split(/\r?\n/);
}

function loadChatHistory(projectRoot, cap = 200, options = {}) {
  const file = chatHistoryFilePath(projectRoot, options);
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    const pushLine = (line = "", sourceType = "") => {
      const value = String(line || "");
      if (!value.trim()) {
        if (out.length > 0) {
          const last = out[out.length - 1];
          const lastText = typeof last === "object" ? last.text : last;
          if (lastText !== "") out.push({ text: "", sourceType: sourceType || "system" });
        }
        return;
      }
      out.push(sourceType ? { text: value, sourceType } : value);
    };
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!entry) continue;
        if (entry.type === "spacer") {
          pushLine("", "system");
          continue;
        }
        const text = String(entry.text || "");
        if (!text) continue;
        const sourceType = String(entry.type || "");
        const stripped = text.replace(/\{[^{}]+\}/g, "");
        for (const renderedLine of normalizeHistoryLogLines(stripped)) {
          pushLine(renderedLine, sourceType);
        }
      } catch {
        // ignore malformed lines
      }
    }
    while (out.length > 0) {
      const first = out[0];
      const firstText = typeof first === "object" ? first.text : first;
      if (firstText !== "") break;
      out.shift();
    }
    while (out.length > 0) {
      const last = out[out.length - 1];
      const lastText = typeof last === "object" ? last.text : last;
      if (lastText !== "") break;
      out.pop();
    }
    const capped = out.slice(-cap);
    while (capped.length > 0) {
      const first = capped[0];
      const firstText = typeof first === "object" ? first.text : first;
      if (firstText !== "") break;
      capped.shift();
    }
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
