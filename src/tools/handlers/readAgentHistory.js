"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");
const { loadAgentsData } = require("../../coordination/state/agentsStore");
const { redactSecrets } = require("../../runtime/privacy/redactor");

const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;
const MAX_DELTA_ACCUM_CHARS = 32000;

function asTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clipText(raw, maxChars) {
  const text = String(raw || "").trim();
  if (!text) return { text: "", truncated: false };
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function isStreamEnvelope(raw) {
  const text = String(raw || "").trim();
  if (!text || !text.startsWith("{") || !text.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && typeof parsed === "object" && parsed.stream === true);
  } catch {
    return false;
  }
}

function loadGroupRuntimes(groupsDir) {
  const out = [];
  if (!groupsDir || !fs.existsSync(groupsDir)) return out;
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
    return out;
  }

  for (const { fullPath } of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.group_id) {
        out.push(parsed);
      }
    } catch {
      // ignore malformed group files
    }
  }
  return out;
}

function readJsonlTailLines(filePath, maxBytes = MAX_FILE_READ_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return [];
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function collectMemberIds(member = {}) {
  const ids = new Set();
  for (const candidate of [
    member.subscriber_id,
    member.previous_subscriber_id,
    member.bootstrapped_subscriber_id,
    ...(Array.isArray(member.launch?.subscriber_ids) ? member.launch.subscriber_ids : []),
    ...(Array.isArray(member.previous_subscriber_ids) ? member.previous_subscriber_ids : []),
  ]) {
    const clean = asTrimmed(candidate);
    if (clean) ids.add(clean);
  }
  return [...ids];
}

function buildIdentityIndex(projectRoot, rawEvents = []) {
  const paths = getUfooPaths(projectRoot);
  let agents = {};
  try {
    const loaded = loadAgentsData(paths.agentsFile);
    agents = loaded && loaded.agents && typeof loaded.agents === "object" ? loaded.agents : {};
  } catch {
    agents = {};
  }

  const groups = loadGroupRuntimes(paths.groupsDir);
  const labelById = new Map();
  const idsByNickname = new Map();
  const idsByGroupRef = new Map();

  const registerId = (id, label = "") => {
    const cleanId = asTrimmed(id);
    if (!cleanId) return;
    const cleanLabel = asTrimmed(label);
    if (cleanLabel && !labelById.has(cleanId)) {
      labelById.set(cleanId, cleanLabel);
    }
    if (cleanLabel) {
      const key = cleanLabel.toLowerCase();
      if (!idsByNickname.has(key)) idsByNickname.set(key, new Set());
      idsByNickname.get(key).add(cleanId);
    }
  };

  for (const [id, meta] of Object.entries(agents)) {
    if (!meta || typeof meta !== "object") continue;
    const label = asTrimmed(meta.display_nickname || meta.nickname || meta.scoped_nickname || "");
    registerId(id, label);
    if (meta.nickname && meta.nickname !== label) registerId(id, meta.nickname);
    if (meta.scoped_nickname && meta.scoped_nickname !== label) registerId(id, meta.scoped_nickname);
    if (meta.group_id) {
      const gKey = String(meta.group_id).trim().toLowerCase();
      if (!idsByGroupRef.has(gKey)) idsByGroupRef.set(gKey, new Set());
      idsByGroupRef.get(gKey).add(id);
    }
    if (meta.group_template_alias) {
      const aKey = String(meta.group_template_alias).trim().toLowerCase();
      if (!idsByGroupRef.has(aKey)) idsByGroupRef.set(aKey, new Set());
      idsByGroupRef.get(aKey).add(id);
    }
  }

  for (const group of groups) {
    const groupRefs = [
      asTrimmed(group.group_id),
      asTrimmed(group.template_alias),
      asTrimmed(group.template_name),
    ].filter(Boolean).map((v) => v.toLowerCase());
    const members = Array.isArray(group.members) ? group.members : [];
    for (const member of members) {
      const memberLabel = asTrimmed(
        member.nickname || member.template_agent_id || member.member_id || member.scoped_nickname || ""
      );
      const ids = collectMemberIds(member);
      for (const id of ids) {
        registerId(id, memberLabel);
        for (const ref of groupRefs) {
          if (!idsByGroupRef.has(ref)) idsByGroupRef.set(ref, new Set());
          idsByGroupRef.get(ref).add(id);
        }
      }
    }
  }

  for (const evt of rawEvents) {
    if (!evt || typeof evt !== "object") continue;
    const data = evt.data && typeof evt.data === "object" ? evt.data : {};
    if (evt.event === "agent_renamed") {
      const id = asTrimmed(data.agent_id);
      const nick = asTrimmed(data.display_nickname || data.new_nickname);
      if (id && nick) {
        labelById.set(id, nick);
        registerId(id, nick);
      }
    } else if (evt.event === "agent_joined") {
      const id = asTrimmed(data.agent_id || data.subscriber_id || evt.publisher);
      const nick = asTrimmed(data.display_nickname || data.nickname);
      if (id && nick) registerId(id, nick);
    }
  }

  const resolveLabel = (rawId) => {
    const id = asTrimmed(rawId);
    if (!id) return "";
    if (id === "ufoo-agent" || id === "ufoo" || id.endsWith(":ufoo-agent")) return "ufoo";
    if (["user", "dashboard", "desktop", "chat", "terminal"].includes(id.toLowerCase())) return "user";
    if (labelById.has(id)) return labelById.get(id);
    return id;
  };

  const resolveFilterIds = (agentArg) => {
    const raw = asTrimmed(agentArg);
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower.startsWith("group:")) {
      const ref = lower.slice(6).trim();
      const set = new Set();
      if (idsByGroupRef.has(ref)) {
        for (const id of idsByGroupRef.get(ref)) set.add(id);
      }
      return set;
    }
    const set = new Set([raw]);
    if (idsByNickname.has(lower)) {
      for (const id of idsByNickname.get(lower)) set.add(id);
    }
    const label = labelById.get(raw);
    if (label && idsByNickname.has(label.toLowerCase())) {
      for (const id of idsByNickname.get(label.toLowerCase())) set.add(id);
    }
    return set;
  };

  const listKnownAgents = (filterIds = null) => {
    const seen = new Map();
    for (const [id, meta] of Object.entries(agents)) {
      if (id === "ufoo-agent") continue;
      if (filterIds && !filterIds.has(id)) continue;
      seen.set(id, {
        agent_id: id,
        label: resolveLabel(id),
        status: asTrimmed(meta?.status || "unknown"),
        activity_state: asTrimmed(meta?.activity_state || ""),
        group_id: asTrimmed(meta?.group_id || ""),
      });
    }
    for (const [id, label] of labelById.entries()) {
      if (id === "ufoo-agent" || seen.has(id)) continue;
      if (filterIds && !filterIds.has(id)) continue;
      seen.set(id, {
        agent_id: id,
        label,
        status: "archived",
        activity_state: "",
        group_id: "",
      });
    }
    return [...seen.values()];
  };

  return {
    agents,
    groups,
    resolveLabel,
    resolveFilterIds,
    listKnownAgents,
  };
}

function summarizeToolValue(value, maxChars = 400) {
  if (typeof value === "string") return clipText(value, maxChars).text;
  if (Array.isArray(value)) {
    const joined = value.map((item) => (typeof item === "string" ? item : item?.text || "")).filter(Boolean).join("\n");
    return clipText(joined, maxChars).text;
  }
  if (value && typeof value === "object") {
    try {
      return clipText(JSON.stringify(value), maxChars).text;
    } catch {
      return "";
    }
  }
  return "";
}

function readAgentHistory(projectRoot, args = {}) {
  const root = projectRoot || process.cwd();
  const paths = getUfooPaths(root);
  const agentFilter = asTrimmed(args.agent || args.agent_id || args.target || "");
  const query = asTrimmed(args.query || "").toLowerCase();
  const limit = Number.isFinite(Number(args.limit))
    ? Math.max(1, Math.min(Math.floor(Number(args.limit)), 100))
    : 20;
  const beforeSeq = Number.isFinite(Number(args.before_seq)) && Number(args.before_seq) > 0
    ? Math.floor(Number(args.before_seq))
    : null;
  const maxChars = Number.isFinite(Number(args.max_chars))
    ? Math.max(100, Math.min(Math.floor(Number(args.max_chars)), 8000))
    : 1600;
  const includeTools = args.include_tools === true;
  const maxDays = Number.isFinite(Number(args.max_days))
    ? Math.max(1, Math.min(Math.floor(Number(args.max_days)), 30))
    : 7;

  let files = [];
  try {
    files = fs.readdirSync(paths.busEventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .slice(-maxDays);
  } catch {
    files = [];
  }

  const rawEvents = [];
  for (const file of files) {
    const lines = readJsonlTailLines(path.join(paths.busEventsDir, file));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object") rawEvents.push(parsed);
      } catch {
        // skip malformed lines
      }
    }
  }
  rawEvents.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));

  const identity = buildIdentityIndex(root, rawEvents);
  const filterIds = identity.resolveFilterIds(agentFilter);

  const busMessageSeqs = new Set();
  const timeline = [];
  const activeTurns = new Map(); // agentId -> { turnId, startSeq, ts, text, publisher }

  const flushTurn = (agentId, endSeq, endTs, finalTextOverride = "", status = "completed", errorText = "") => {
    const active = activeTurns.get(agentId);
    const rawBody = asTrimmed(finalTextOverride) || asTrimmed(active?.text || "");
    const seq = Number(endSeq) || Number(active?.startSeq) || 0;
    const ts = asTrimmed(endTs) || asTrimmed(active?.ts) || "";
    activeTurns.delete(agentId);
    if (rawBody) {
      timeline.push({
        seq,
        ts,
        source: "surface",
        role: "assistant",
        status,
        agent_id: agentId,
        agent_label: identity.resolveLabel(agentId),
        sender_id: agentId,
        sender_label: identity.resolveLabel(agentId),
        target_id: active?.publisher || "",
        target_label: active?.publisher ? identity.resolveLabel(active.publisher) : "",
        text: rawBody,
      });
    }
    if (errorText) {
      timeline.push({
        seq,
        ts,
        source: "surface",
        role: "error",
        status,
        agent_id: agentId,
        agent_label: identity.resolveLabel(agentId),
        sender_id: agentId,
        sender_label: identity.resolveLabel(agentId),
        target_id: "",
        target_label: "",
        text: errorText,
      });
    }
  };

  for (const evt of rawEvents) {
    const seq = Number(evt.seq) || 0;
    const ts = asTrimmed(evt.timestamp || evt.ts || "");
    const data = evt.data && typeof evt.data === "object" ? evt.data : {};

    if (evt.event === "message") {
      const msg = typeof data.message === "string"
        ? data.message
        : (data.message !== undefined && data.message !== null ? JSON.stringify(data.message) : "");
      if (!msg.trim() || isStreamEnvelope(msg)) continue;
      const senderId = asTrimmed(evt.publisher);
      const targetId = asTrimmed(evt.target);
      if (seq > 0) busMessageSeqs.add(seq);
      const primaryAgentId = targetId && targetId !== "ufoo-agent" && targetId !== "*"
        ? targetId
        : senderId;
      timeline.push({
        seq,
        ts,
        source: "bus",
        role: "message",
        status: "delivered",
        agent_id: primaryAgentId,
        agent_label: identity.resolveLabel(primaryAgentId),
        sender_id: senderId,
        sender_label: identity.resolveLabel(senderId),
        target_id: targetId,
        target_label: identity.resolveLabel(targetId),
        text: msg.trim(),
      });
      continue;
    }

    if (evt.event === "agent_surface") {
      const agentId = asTrimmed(data.subscriber || evt.publisher);
      const surface = data.surface && typeof data.surface === "object" ? data.surface : null;
      if (!agentId || !surface || !surface.type) continue;

      if (surface.type === "task_started") {
        if (activeTurns.has(agentId)) {
          flushTurn(agentId, seq, ts, "", "interrupted");
        }
        activeTurns.set(agentId, {
          turnId: asTrimmed(surface.taskRunId || surface.task_id || String(seq)),
          startSeq: seq,
          ts,
          text: "",
          publisher: asTrimmed(surface.publisher || ""),
        });
        const queueSeq = Number(surface.queueSequence);
        const promptMsg = asTrimmed(surface.message);
        if (promptMsg && !(Number.isFinite(queueSeq) && queueSeq > 0 && busMessageSeqs.has(queueSeq))) {
          const pub = asTrimmed(surface.publisher || "user");
          timeline.push({
            seq,
            ts,
            source: "surface",
            role: "prompt",
            status: "received",
            agent_id: agentId,
            agent_label: identity.resolveLabel(agentId),
            sender_id: pub,
            sender_label: identity.resolveLabel(pub),
            target_id: agentId,
            target_label: identity.resolveLabel(agentId),
            text: promptMsg,
          });
        }
      } else if (surface.type === "text_delta") {
        let turn = activeTurns.get(agentId);
        if (!turn) {
          turn = { turnId: String(seq), startSeq: seq, ts, text: "", publisher: "" };
          activeTurns.set(agentId, turn);
        }
        const delta = String(surface.delta || "");
        if (delta && turn.text.length < MAX_DELTA_ACCUM_CHARS) {
          turn.text += delta.slice(0, MAX_DELTA_ACCUM_CHARS - turn.text.length);
        }
      } else if (surface.type === "tool_call" && includeTools) {
        const toolName = asTrimmed(surface.name || "tool");
        const argSummary = summarizeToolValue(surface.args, 300);
        timeline.push({
          seq,
          ts,
          source: "surface",
          role: "tool",
          status: "started",
          tool_name: toolName,
          agent_id: agentId,
          agent_label: identity.resolveLabel(agentId),
          sender_id: agentId,
          sender_label: identity.resolveLabel(agentId),
          target_id: "",
          target_label: "",
          text: argSummary ? `${toolName}: ${argSummary}` : toolName,
        });
      } else if (surface.type === "tool_result" && includeTools) {
        const toolName = asTrimmed(surface.name || "tool");
        const outSummary = summarizeToolValue(surface.output ?? surface.result, 400);
        if (outSummary) {
          timeline.push({
            seq,
            ts,
            source: "surface",
            role: "tool_result",
            status: surface.isError ? "error" : "done",
            tool_name: toolName,
            agent_id: agentId,
            agent_label: identity.resolveLabel(agentId),
            sender_id: agentId,
            sender_label: identity.resolveLabel(agentId),
            target_id: "",
            target_label: "",
            text: outSummary,
          });
        }
      } else if (surface.type === "task_completed" || surface.type === "task_paused") {
        flushTurn(
          agentId,
          seq,
          ts,
          asTrimmed(surface.finalText || ""),
          surface.type === "task_paused" ? "waiting_user" : "completed"
        );
      } else if (surface.type === "task_failed") {
        flushTurn(agentId, seq, ts, "", "failed", asTrimmed(surface.error || "task failed"));
      } else if (surface.type === "task_cancelled") {
        flushTurn(agentId, seq, ts, "", "cancelled");
      }
    }
  }

  for (const [agentId, turn] of activeTurns.entries()) {
    if (asTrimmed(turn.text)) {
      flushTurn(agentId, turn.startSeq, turn.ts, "", "running");
    }
  }

  // Deduplicate identical assistant reply emitted both as bus message and surface completion right next to each other
  const deduped = [];
  for (const item of timeline) {
    const prev = deduped.at(-1);
    if (
      prev
      && prev.sender_id === item.sender_id
      && prev.text === item.text
      && Math.abs((item.seq || 0) - (prev.seq || 0)) <= 3
      && prev.source !== item.source
    ) {
      // Prefer bus message when it carries explicit target_id; otherwise prefer surface
      if (item.source === "bus" && item.target_id && !prev.target_id) {
        deduped[deduped.length - 1] = item;
      }
      continue;
    }
    deduped.push(item);
  }

  const filtered = deduped.filter((item) => {
    if (beforeSeq !== null && item.seq >= beforeSeq) return false;
    if (filterIds) {
      const matchedAgent = filterIds.has(item.agent_id)
        || filterIds.has(item.sender_id)
        || filterIds.has(item.target_id);
      if (!matchedAgent) return false;
    }
    if (query) {
      const haystack = [
        item.text,
        item.agent_label,
        item.agent_id,
        item.sender_label,
        item.target_label,
        item.tool_name || "",
      ].join("\n").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  const hasMore = filtered.length > limit;
  const page = filtered.slice(-limit).map((item) => {
    const redacted = redactSecrets(item.text);
    const clipped = clipText(redacted, maxChars);
    return {
      seq: item.seq,
      ts: item.ts,
      role: item.role,
      status: item.status,
      agent_id: item.agent_id,
      agent_label: item.agent_label,
      sender_id: item.sender_id,
      sender_label: item.sender_label,
      target_id: item.target_id,
      target_label: item.target_label,
      ...(item.tool_name ? { tool_name: item.tool_name } : {}),
      text: clipped.text,
      truncated: clipped.truncated,
    };
  });

  const nextBeforeSeq = hasMore && page.length > 0 && page[0].seq > 0
    ? page[0].seq
    : null;

  return {
    ok: true,
    project_root: root,
    scanned_files: files.length,
    filter: {
      agent: agentFilter || null,
      query: query || null,
      before_seq: beforeSeq,
      include_tools: includeTools,
    },
    count: page.length,
    total_matched: filtered.length,
    has_more: hasMore,
    next_before_seq: nextBeforeSeq,
    agents: identity.listKnownAgents(filterIds),
    entries: page,
  };
}

function readAgentHistoryHandler(ctx = {}, args = {}) {
  return readAgentHistory(ctx.projectRoot || process.cwd(), args);
}

module.exports = {
  readAgentHistory,
  readAgentHistoryHandler,
};
