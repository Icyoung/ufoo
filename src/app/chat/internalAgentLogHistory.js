"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");

function stripAnsi(text = "") {
  return String(text || "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function decodeEscapedNewlines(text = "") {
  return String(text || "").replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

function normalizeText(text = "") {
  return stripAnsi(decodeEscapedNewlines(text)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readMatchingEventsFromFileReverse(filePath, aliases, limit) {
  if (limit <= 0) return [];
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const events = [];
    for (let index = lines.length - 1; index >= 0 && events.length < limit; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      let evt = null;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (isEventForAgent(evt, aliases)) events.push(evt);
    }
    return events;
  } catch {
    return [];
  }
}

function buildAgentAliases(agentId = "", agents = {}) {
  const aliases = new Set();
  const id = String(agentId || "").trim();
  if (!id) return aliases;
  aliases.add(id);
  const meta = agents && agents[id] ? agents[id] : null;
  if (meta) {
    for (const key of ["nickname", "scoped_nickname", "display_nickname"]) {
      if (meta[key]) aliases.add(String(meta[key]));
    }
  }
  return aliases;
}

function eventData(evt = {}) {
  return evt && evt.data && typeof evt.data === "object" ? evt.data : {};
}

function isEventForAgent(evt, aliases) {
  if (!evt || evt.event !== "message") return false;
  const data = eventData(evt);
  const candidates = [
    evt.publisher,
    evt.target,
    data.publisher,
    data.target,
    data.subscriber,
  ].filter(Boolean).map(String);
  return candidates.some((value) => aliases.has(value));
}

function parseStreamMessage(raw = "") {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.stream) return null;
    if (typeof parsed.delta === "string") return normalizeText(parsed.delta);
    if (parsed.done) return "";
    return "";
  } catch {
    return null;
  }
}

function loadInternalAgentTranscript(projectRoot, agentId, options = {}) {
  const paths = getUfooPaths(projectRoot || process.cwd());
  const maxEvents = Number.isFinite(options.maxEvents) ? Math.max(1, options.maxEvents) : 400;
  const maxEntries = Number.isFinite(options.maxEntries) ? Math.max(1, options.maxEntries) : 1000;
  let agents = {};
  try {
    const bus = JSON.parse(fs.readFileSync(paths.agentsFile, "utf8"));
    agents = bus.agents || {};
  } catch {
    agents = {};
  }

  const aliases = buildAgentAliases(agentId, agents);
  if (aliases.size === 0) return [];

  let files = [];
  try {
    files = fs.readdirSync(paths.busEventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(paths.busEventsDir, name));
  } catch {
    return [];
  }

  const reversedEvents = [];
  for (const file of files.slice(-7).reverse()) {
    if (reversedEvents.length >= maxEvents) break;
    const remaining = maxEvents - reversedEvents.length;
    reversedEvents.push(...readMatchingEventsFromFileReverse(file, aliases, remaining));
  }

  const entries = [];
  let streamEntry = null;
  function append(kind, text, seq) {
    const clean = normalizeText(text);
    if (!clean) return null;
    const entry = { id: `history-${seq || entries.length + 1}`, kind, text: clean };
    entries.push(entry);
    return entry;
  }
  for (const evt of reversedEvents.reverse()) {
    const data = eventData(evt);
    const rawMessage = typeof data.message === "string" ? data.message : "";
    const streamDelta = parseStreamMessage(rawMessage);
    const publisher = String(evt.publisher || "");
    const target = String(evt.target || data.target || "");
    const isFromAgent = aliases.has(publisher);
    const isToAgent = aliases.has(target) || aliases.has(String(data.subscriber || ""));

    if (streamDelta !== null) {
      if (isFromAgent && streamDelta) {
        if (streamEntry) streamEntry.text += streamDelta;
        else streamEntry = append("assistant", streamDelta, evt.seq);
      } else if (isFromAgent) {
        streamEntry = null;
      }
      continue;
    }

    if (isFromAgent) {
      append("assistant", rawMessage, evt.seq);
    } else if (isToAgent) {
      append("user", rawMessage, evt.seq);
    }
    streamEntry = null;
  }

  return entries.slice(-maxEntries);
}

module.exports = {
  loadInternalAgentTranscript,
  buildAgentAliases,
};
