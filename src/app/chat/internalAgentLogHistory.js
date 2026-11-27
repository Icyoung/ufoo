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

function loadGroupMemberIndex(groupsDir) {
  const index = new Map();
  if (!groupsDir || !fs.existsSync(groupsDir)) return index;
  let files = [];
  try {
    files = fs.readdirSync(groupsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const fullPath = path.join(groupsDir, name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fullPath).mtimeMs || 0; } catch {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return index;
  }

  for (const { fullPath } of files) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch {
      continue;
    }
    const members = Array.isArray(parsed?.members) ? parsed.members : [];
    for (const member of members) {
      if (!member || typeof member !== "object") continue;
      const label = String(
        member.nickname
        || member.template_agent_id
        || member.member_id
        || member.scoped_nickname
        || ""
      ).trim();
      if (!label) continue;
      const ids = new Set();
      for (const candidate of [
        member.subscriber_id,
        member.previous_subscriber_id,
        member.bootstrapped_subscriber_id,
        ...(Array.isArray(member.launch?.subscriber_ids) ? member.launch.subscriber_ids : []),
        ...(Array.isArray(member.previous_subscriber_ids) ? member.previous_subscriber_ids : []),
      ]) {
        const clean = String(candidate || "").trim();
        if (clean) ids.add(clean);
      }
      for (const id of ids) {
        if (index.has(id)) continue;
        const type = String(
          member.type
          || member.agent
          || (id.includes(":") ? id.split(":")[0] : "")
          || "worker"
        ).trim();
        index.set(id, { label, type });
      }
    }
  }
  return index;
}

function loadBusNicknameMap(files) {
  const map = new Map();
  for (const file of files) {
    let lines = [];
    try {
      lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line || (!line.includes("agent_renamed") && !line.includes("agent_joined"))) continue;
      let evt = null;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt || typeof evt !== "object") continue;
      const data = eventData(evt);
      if (evt.event === "agent_renamed") {
        const id = String(data.agent_id || "").trim();
        const nick = String(data.display_nickname || data.new_nickname || "").trim();
        if (id && nick) map.set(id, nick);
      } else if (evt.event === "agent_joined") {
        const id = String(data.agent_id || data.subscriber_id || evt.publisher || "").trim();
        const nick = String(data.display_nickname || data.nickname || "").trim();
        if (id && nick && !map.has(id)) map.set(id, nick);
      }
    }
  }
  return map;
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
  const groupMemberIndex = loadGroupMemberIndex(paths.groupsDir);

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

  const recentFiles = files.slice(-7);
  const busNicknameMap = loadBusNicknameMap(recentFiles);
  const reversedEvents = [];
  for (const file of recentFiles.slice().reverse()) {
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
      const source = String(data.source || "").trim().toLowerCase();
      const isDirectUser = [
        "ufoo-desktop", "ufoo-desktop-worker", "ufoo-desktop-handoff",
        "chat-direct", "chat-agent-view", "chat-internal-agent-view", "rust-multi-window", "user",
      ].includes(source);
      const isCoordinator = !isDirectUser && (publisher === "ufoo-agent" || publisher.endsWith(":ufoo-agent"))
        && (source === "ufoo-agent" || source === "group" || source === "group-bootstrap" || Boolean(data.task_id));
      const isPeer = !isDirectUser && Boolean(publisher) && publisher !== "user" && publisher !== "unknown"
        && publisher !== "ufoo-agent" && !publisher.endsWith(":ufoo-agent");
      const entry = append("user", rawMessage, evt.seq);
      if (entry) {
        if (isPeer) {
          const senderMeta = agents[publisher] || {};
          const groupMember = groupMemberIndex.get(publisher) || null;
          const busNick = busNicknameMap.get(publisher) || "";
          entry.sender_kind = "peer";
          entry.sender_id = publisher;
          entry.sender_label = String(
            senderMeta.display_nickname
            || senderMeta.nickname
            || groupMember?.label
            || busNick
            || publisher
          );
          entry.sender_type = String(
            senderMeta.agent_type
            || senderMeta.type
            || groupMember?.type
            || publisher.split(":")[0]
            || "worker"
          );
        } else if (isCoordinator) {
          entry.sender_kind = "coordinator";
          entry.sender_id = "ufoo-agent";
          entry.sender_label = "ufoo";
          entry.sender_type = "ufoo";
        } else {
          entry.sender_kind = "user";
        }
      }
    }
    streamEntry = null;
  }

  return entries.slice(-maxEntries);
}

module.exports = {
  loadInternalAgentTranscript,
  buildAgentAliases,
};
