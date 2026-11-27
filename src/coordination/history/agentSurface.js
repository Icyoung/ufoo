"use strict";

const fs = require("fs");
const path = require("path");
const MessageManager = require("../bus/message");
const { getUfooPaths } = require("../state/paths");
const { redactSecrets } = require("../../runtime/privacy/redactor");

// Display events are observations, not messages. They never enter an agent's
// inbox and never depend on which peer receives the task's final reply.
function createAgentSurfacePublisher(projectRoot, subscriber) {
  const paths = getUfooPaths(projectRoot);
  const sequence = new MessageManager(paths.busDir, {}, null);
  let pending = Promise.resolve();
  let batch = [];
  let timer = null;
  let lastError = "";
  function reportError(error) {
    const message = redactSecrets(String(error?.message || "unknown display stream error"));
    if (message !== lastError) process.stderr.write(`[internal] display stream unavailable: ${message}\n`);
    lastError = message;
  }
  function drain() {
    if (timer) clearTimeout(timer);
    timer = null;
    const events = batch;
    batch = [];
    for (const safeEvent of events) {
      pending = pending.then(async () => {
        fs.mkdirSync(paths.busEventsDir, { recursive: true });
        const seq = await sequence.getNextSeq();
        const timestamp = new Date().toISOString();
        fs.appendFileSync(path.join(paths.busEventsDir, `${timestamp.slice(0, 10)}.jsonl`), JSON.stringify({
          seq, timestamp, type: "status/agent-surface", event: "agent_surface",
          publisher: subscriber, target: "*", data: { subscriber, surface: safeEvent },
        }) + "\n");
        lastError = "";
      }).catch(reportError);
    }
  }
  function enqueue(event) {
    let safeEvent;
    try { safeEvent = JSON.parse(redactSecrets(JSON.stringify(event))); }
    catch (error) { reportError(error); return; }
    // Stamp observation time at enqueue so live and replayed surfaces derive
    // identical durations (records are batched before they get a timestamp).
    if (safeEvent && typeof safeEvent === "object" && !Number.isFinite(safeEvent.observed_at)) {
      safeEvent.observed_at = Date.now();
    }
    const last = batch.at(-1);
    if (["text_delta", "thinking_delta"].includes(safeEvent.type) && last?.type === safeEvent.type
        && String(last.delta || "").length < 32000) last.delta = String(last.delta || "") + String(safeEvent.delta || "");
    else batch.push(safeEvent);
    if (!timer) { timer = setTimeout(drain, 40); timer.unref?.(); }
  }
  return { enqueue, flush: () => { drain(); return pending; } };
}

function resolveAgentLineageIds(projectRoot, agentId, meta = null) {
  const canonical = String(agentId || "").trim();
  if (!canonical) return [];
  const ids = new Set([canonical]);
  const root = String(projectRoot || "").trim();
  if (!root) return [...ids];

  const paths = getUfooPaths(root);
  let diskMeta = null;
  try {
    if (paths.agentsFile && fs.existsSync(paths.agentsFile)) {
      const parsed = JSON.parse(fs.readFileSync(paths.agentsFile, "utf8"));
      diskMeta = parsed?.agents?.[canonical] || null;
    }
  } catch {
    diskMeta = null;
  }

  const combined = { ...(diskMeta || {}), ...(meta && typeof meta === "object" ? meta : {}) };
  for (const prev of [
    combined.previous_subscriber_id,
    ...(Array.isArray(combined.previous_subscriber_ids) ? combined.previous_subscriber_ids : []),
  ]) {
    const clean = String(prev || "").trim();
    if (clean) ids.add(clean);
  }

  const providerSessionId = String(combined.provider_session_id || combined.session_id || "").trim();

  // Check group member records for prior subscriber IDs across resumes
  try {
    if (paths.groupsDir && fs.existsSync(paths.groupsDir)) {
      for (const name of fs.readdirSync(paths.groupsDir)) {
        if (!name.endsWith(".json")) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(path.join(paths.groupsDir, name), "utf8"));
        } catch {
          continue;
        }
        for (const member of Array.isArray(parsed?.members) ? parsed.members : []) {
          if (!member || typeof member !== "object") continue;
          const memberIds = [
            member.subscriber_id,
            member.previous_subscriber_id,
            member.bootstrapped_subscriber_id,
            ...(Array.isArray(member.previous_subscriber_ids) ? member.previous_subscriber_ids : []),
            ...(Array.isArray(member.launch?.subscriber_ids) ? member.launch.subscriber_ids : []),
          ].map((item) => String(item || "").trim()).filter(Boolean);
          const sessionMatch = providerSessionId
            && String(member.provider_session_id || "").trim() === providerSessionId;
          if (sessionMatch || memberIds.includes(canonical)) {
            for (const item of memberIds) ids.add(item);
          }
        }
      }
    }
  } catch {
    // ignore group scan errors
  }

  // For resumed ucode sessions (including sessions resumed before previous_subscriber_ids
  // persistence was added), recover prior subscriber IDs from the durable runtime event log.
  if (providerSessionId && !providerSessionId.includes("/") && !providerSessionId.includes("\\")) {
    try {
      const runtimeEventsPath = path.join(paths.ufooDir, "agent", "ucode", "runtimes", providerSessionId, "events.jsonl");
      if (fs.existsSync(runtimeEventsPath)) {
        const raw = fs.readFileSync(runtimeEventsPath, "utf8");
        const re = /"agentId"\s*:\s*"([^"]+)"/g;
        let match = re.exec(raw);
        while (match) {
          const found = String(match[1] || "").trim();
          if (found) ids.add(found);
          match = re.exec(raw);
        }
      }
    } catch {
      // ignore runtime event scan errors
    }
  }

  return [...ids];
}

function readAgentSurfaceEvents(projectRoot, agentIds, maxBytes = 2 * 1024 * 1024) {
  const accepted = new Set(agentIds);
  const dir = getUfooPaths(projectRoot).busEventsDir;
  let files;
  try { files = fs.readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort().slice(-2); }
  catch { return []; }
  const events = [];
  for (const file of files) {
    let fd;
    try {
      fd = fs.openSync(path.join(dir, file), "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(Math.min(size, maxBytes));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start) lines.shift();
      for (const line of lines) {
        if (!line || !line.includes('"agent_surface"')) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "agent_surface" && accepted.has(event.publisher) && event.data?.surface?.type) events.push(event);
        } catch { /* An incomplete tail is picked up by the live bridge. */ }
      }
    } catch { /* History can rotate while a pane attaches. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

// Keep partial rows as bytes: a provider can append in the middle of a UTF-8
// character. File offsets, rather than sequence high-water marks, retain late
// appends from concurrent writers.
function createAgentSurfaceReader(projectRoot, maxBytes = 2 * 1024 * 1024) {
  const cursors = new Map();
  const dir = getUfooPaths(projectRoot).busEventsDir;
  return {
    read(agentIds) {
      const accepted = new Set(agentIds);
      let files;
      try { files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().slice(-2); }
      catch { return []; }
      const events = [];
      for (const name of files) {
        let fd;
        try {
          fd = fs.openSync(path.join(dir, name), "r");
          const stat = fs.fstatSync(fd);
          let cursor = cursors.get(name);
          if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.offset) {
            cursor = { ino: stat.ino, offset: Math.max(0, stat.size - maxBytes), partial: Buffer.alloc(0) };
            cursor.skipFirst = cursor.offset > 0;
          }
          if (stat.size - cursor.offset > maxBytes) {
            cursor.offset = stat.size - maxBytes;
            cursor.partial = Buffer.alloc(0);
            cursor.skipFirst = true;
          }
          const buffer = Buffer.alloc(Math.max(0, stat.size - cursor.offset));
          const read = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
          cursor.offset += read;
          const content = Buffer.concat([cursor.partial, buffer.subarray(0, read)]);
          const end = content.lastIndexOf(10);
          const skipFirst = cursor.skipFirst;
          if (end >= 0) cursor.skipFirst = false;
          cursor.partial = content.subarray(end + 1);
          if (cursor.partial.length > maxBytes) {
            cursor.partial = cursor.partial.subarray(-maxBytes);
            cursor.skipFirst = true;
          }
          cursors.set(name, cursor);
          if (end < 0) continue;
          const lines = content.subarray(0, end).toString("utf8").split("\n");
          if (skipFirst) lines.shift();
          for (const line of lines) {
            try {
              const event = JSON.parse(line);
              if (event.event === "agent_surface" && accepted.has(event.publisher) && event.data?.surface?.type) events.push(event);
            } catch { /* Ignore unrelated or malformed observations. */ }
          }
        } catch { /* A writer can rotate the file between stat and read. */ }
        finally { if (fd !== undefined) fs.closeSync(fd); }
      }
      for (const name of cursors.keys()) if (!files.includes(name)) cursors.delete(name);
      return events;
    },
  };
}

module.exports = {
  createAgentSurfacePublisher,
  readAgentSurfaceEvents,
  createAgentSurfaceReader,
  resolveAgentLineageIds,
};
