"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { loadAgentsData } = require("../ufoo/agentsStore");
const { redactSecrets, redactString } = require("../providerapi/redactor");

const HISTORY_DEBUG = process.env.UFOO_HISTORY_DEBUG === "1";
const debugLog = (...args) => { if (HISTORY_DEBUG) console.error("[history]", ...args); };

/**
 * Input Timeline — aggregates all agent inputs into a unified chat-like history.
 *
 * Sources:
 * 1. Bus events (message/targeted) — inter-agent messages, appended in real-time
 * 2. Claude ​Code session JSONL — manual user inputs, synced by daemon every ~30s
 * 3. Codex session rollout files — manual user inputs, synced by daemon every ~30s
 *
 * Incremental builds use a watermark file tracking:
 * - busLastSeq: last processed bus event seq number
 * - lastTs: last processed timestamp (used to skip session file records + mtime filter)
 * - entryCount: maintained count (avoids full-scan just to count)
 * - builtAt: when last build ran
 *
 * Output format (JSONL per entry):
 * {
 *   ts: ISO timestamp,
 *   source: "bus" | "manual",
 *   from: display label (nickname or "user"),
 *   fromId: subscriber ID or "user",
 *   to: display label,
 *   toId: subscriber ID or "",
 *   message: string
 * }
 */

// ---------------------------------------------------------------------------
// Paths (all derived from getUfooPaths to avoid hardcoding)
// ---------------------------------------------------------------------------

function getHistoryDir(projectRoot) {
  return getUfooPaths(projectRoot).historyDir;
}

function getTimelineFile(projectRoot) {
  return path.join(getHistoryDir(projectRoot), "input-timeline.jsonl");
}

function getWatermarkFile(projectRoot) {
  return path.join(getHistoryDir(projectRoot), "watermark.json");
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

const WATERMARK_LOCK_STALE_MS = 10000;

function readWatermark(projectRoot) {
  try {
    const file = getWatermarkFile(projectRoot);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    }
  } catch {
    // corrupted — treat as fresh
  }
  return { busLastSeq: 0, lastTs: "", entryCount: 0 };
}

/**
 * Synchronous non-blocking file lock for watermark writes.
 * Returns lock handle on success, null if lock is held (caller skips update).
 */
function acquireWatermarkLock(projectRoot) {
  const lockFile = path.join(getHistoryDir(projectRoot), "watermark.lock");
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeSync(fd, `${process.pid}\n`);
    return { fd, lockFile };
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const stat = fs.statSync(lockFile);
        if (Date.now() - stat.mtimeMs > WATERMARK_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          const fd = fs.openSync(lockFile, "wx");
          fs.writeSync(fd, `${process.pid}\n`);
          return { fd, lockFile };
        }
      } catch {
        // give up
      }
    }
    return null;
  }
}

function releaseWatermarkLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch { /* ignore */ }
  try { fs.unlinkSync(lock.lockFile); } catch { /* ignore */ }
}

function writeWatermark(projectRoot, watermark) {
  fs.mkdirSync(getHistoryDir(projectRoot), { recursive: true });
  fs.writeFileSync(getWatermarkFile(projectRoot), JSON.stringify(watermark, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// JSONL helpers
// ---------------------------------------------------------------------------

/**
 * Stream-parse a JSONL file line by line.
 * Calls fn(record) for each valid line; stops early if fn returns false.
 */
function streamJSONL(filePath, fn) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf("\n", start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (fn(record) === false) return;
    } catch {
      // skip malformed
    }
  }
}

/**
 * Read the last N records from a JSONL file (tail-read, avoids full load).
 */
function readTailJSONL(filePath, limit = 50) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size === 0) return [];

  if (stat.size < 512 * 1024) {
    const results = [];
    streamJSONL(filePath, (r) => { results.push(r); });
    return results.slice(-limit);
  }

  const chunkSize = Math.min(stat.size, limit * 2048);
  const buf = Buffer.alloc(chunkSize);
  const fd = fs.openSync(filePath, "r");
  try {
    const offset = Math.max(0, stat.size - chunkSize);
    fs.readSync(fd, buf, 0, chunkSize, offset);
    const lines = buf.toString("utf8").split(/\r?\n/).filter(Boolean);
    const startIdx = offset > 0 ? 1 : 0; // skip possible partial first line
    const results = [];
    for (let i = startIdx; i < lines.length; i++) {
      try { results.push(JSON.parse(lines[i])); } catch { /* skip */ }
    }
    return results.slice(-limit);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function buildNicknameLookup(projectRoot) {
  const data = loadAgentsData(getUfooPaths(projectRoot).agentsFile);
  const lookup = new Map();
  for (const [id, meta] of Object.entries(data.agents || {})) {
    if (meta && meta.nickname) lookup.set(id, meta.nickname);
  }
  return lookup;
}

function buildSessionLookup(projectRoot) {
  const data = loadAgentsData(getUfooPaths(projectRoot).agentsFile);
  const lookup = new Map();
  for (const [id, meta] of Object.entries(data.agents || {})) {
    if (meta && meta.provider_session_id) {
      lookup.set(meta.provider_session_id, {
        subscriberId: id,
        nickname: meta.nickname || id,
      });
    }
  }
  return lookup;
}

/**
 * Derive the Claude projects directory for this project root.
 * Claude stores sessions at: ~/.claude/projects/<path-with-dashes>/<sessionId>.jsonl
 */
function getClaudeProjectDir(projectRoot) {
  const slug = path.resolve(projectRoot).replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", slug);
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function extractUserText(record) {
  const msg = record.message;
  if (!msg || typeof msg !== "object") return "";
  const content = msg.content;
  if (typeof content === "string") return content.replace(/<[^>]+>/g, "").trim();
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c && c.text ? c.text : ""))
      .join("")
      .replace(/<[^>]+>/g, "")
      .trim();
  }
  return "";
}

function isProbeMarker(text) {
  return /^\/ufoo\s+\S+$/.test(text) || /^\$ufoo\s+\S+$/.test(text);
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/**
 * Collect new bus events since watermark.busLastSeq.
 * Skips event files whose date is strictly before the watermark date.
 */
function collectBusMessages(projectRoot, watermark = {}) {
  const eventsDir = getUfooPaths(projectRoot).busEventsDir;
  if (!fs.existsSync(eventsDir)) return { entries: [], maxSeq: watermark.busLastSeq || 0 };

  const minSeq = watermark.busLastSeq || 0;
  const nicknames = buildNicknameLookup(projectRoot);
  const entries = [];
  let maxSeq = minSeq;
  const watermarkDate = watermark.lastTs ? watermark.lastTs.slice(0, 10) : "";

  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    if (watermarkDate && file < `${watermarkDate}.jsonl`) continue;
    streamJSONL(path.join(eventsDir, file), (evt) => {
      if (!evt.seq || evt.seq <= minSeq) return;
      if (evt.type !== "message/targeted" || evt.event !== "message") return;
      if (!evt.data || !evt.data.message) return;
      if (evt.seq > maxSeq) maxSeq = evt.seq;
      entries.push({
        ts: evt.timestamp,
        source: "bus",
        from: nicknames.get(evt.publisher) || evt.publisher,
        fromId: evt.publisher,
        to: nicknames.get(evt.target) || evt.target,
        toId: evt.target,
        message: evt.data.message,
      });
    });
  }

  return { entries, maxSeq };
}

/**
 * Collect new manual user inputs from Claude ​Code session files.
 * Uses mtime to skip unmodified files; within modified files filters by timestamp.
 */
function collectClaudeManualInputs(projectRoot, watermark = {}) {
  const claudeProjectDir = getClaudeProjectDir(projectRoot);
  if (!fs.existsSync(claudeProjectDir)) return [];

  const sessionLookup = buildSessionLookup(projectRoot);
  const entries = [];
  const cutoffMs = watermark.lastTs ? new Date(watermark.lastTs).getTime() : 0;

  const sessionToAgent = new Map();
  for (const [sessionId, info] of sessionLookup) {
    if (info.subscriberId.startsWith("claude-code:")) {
      sessionToAgent.set(sessionId, info);
    }
  }

  let sessionFiles;
  if (sessionToAgent.size > 0) {
    sessionFiles = [];
    for (const sessionId of sessionToAgent.keys()) {
      const filePath = path.join(claudeProjectDir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) sessionFiles.push({ filePath, sessionId });
    }
  } else {
    try {
      sessionFiles = fs.readdirSync(claudeProjectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ filePath: path.join(claudeProjectDir, f), sessionId: f.replace(".jsonl", "") }));
    } catch {
      return entries;
    }
  }

  for (const { filePath, sessionId } of sessionFiles) {
    if (cutoffMs > 0) {
      try {
        if (fs.statSync(filePath).mtimeMs <= cutoffMs) continue;
      } catch { continue; }
    }

    const agent = sessionToAgent.get(sessionId);
    const toLabel = agent ? agent.nickname : `session:${sessionId.slice(0, 8)}`;
    const toId = agent ? agent.subscriberId : "";

    streamJSONL(filePath, (record) => {
      if (record.type !== "user") return;
      if (cutoffMs > 0 && record.timestamp) {
        if (new Date(record.timestamp).getTime() <= cutoffMs) return;
      }
      const text = extractUserText(record);
      if (!text || isProbeMarker(text)) return;
      entries.push({
        ts: record.timestamp || "",
        source: "manual",
        from: "user",
        fromId: "user",
        to: toLabel,
        toId,
        message: text,
      });
    });
  }

  return entries;
}

/**
 * Collect new manual user inputs from Codex session rollouts.
 * Skips date directories older than watermark date; skips files by mtime.
 */
function collectCodexManualInputs(projectRoot, watermark = {}) {
  const sessionLookup = buildSessionLookup(projectRoot);
  if (sessionLookup.size === 0) return [];

  const entries = [];
  const sessionsBase = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(sessionsBase)) return entries;

  const cutoffMs = watermark.lastTs ? new Date(watermark.lastTs).getTime() : 0;
  const cutoffDate = watermark.lastTs ? watermark.lastTs.slice(0, 10) : "";

  const codexSessions = new Map();
  for (const [sessionId, info] of sessionLookup) {
    if (info.subscriberId.startsWith("codex:")) codexSessions.set(sessionId, info);
  }
  if (codexSessions.size === 0) return entries;

  let years;
  try { years = fs.readdirSync(sessionsBase).filter((d) => /^\d{4}$/.test(d)); } catch { return entries; }

  for (const y of years) {
    if (cutoffDate && y < cutoffDate.slice(0, 4)) continue;
    const yDir = path.join(sessionsBase, y);
    let months;
    try { months = fs.readdirSync(yDir).filter((d) => /^\d{2}$/.test(d)); } catch { continue; }
    for (const m of months) {
      if (cutoffDate && `${y}-${m}` < cutoffDate.slice(0, 7)) continue;
      const mDir = path.join(yDir, m);
      let days;
      try { days = fs.readdirSync(mDir).filter((d) => /^\d{2}$/.test(d)); } catch { continue; }
      for (const d of days) {
        if (cutoffDate && `${y}-${m}-${d}` < cutoffDate) continue;
        const dDir = path.join(mDir, d);
        let files;
        try {
          files = fs.readdirSync(dDir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
        } catch { continue; }

        for (const file of files) {
          const filePath = path.join(dDir, file);
          if (cutoffMs > 0) {
            try { if (fs.statSync(filePath).mtimeMs <= cutoffMs) continue; } catch { continue; }
          }

          let sessionId = "";
          streamJSONL(filePath, (rec) => {
            if (rec.type === "session_meta" && rec.payload?.id) {
              sessionId = rec.payload.id;
              return false;
            }
          });

          const agent = codexSessions.get(sessionId);
          if (!agent) continue;

          streamJSONL(filePath, (rec) => {
            if (rec.type !== "message" || rec.role !== "user") return;
            if (cutoffMs > 0 && rec.timestamp) {
              if (new Date(rec.timestamp).getTime() <= cutoffMs) return;
            }
            const content = typeof rec.content === "string"
              ? rec.content
              : Array.isArray(rec.content)
                ? rec.content.map((c) => c.text || "").join("")
                : "";
            if (!content) return;
            entries.push({
              ts: rec.timestamp ? new Date(rec.timestamp).toISOString() : new Date().toISOString(),
              source: "manual",
              from: "user",
              fromId: "user",
              to: agent.nickname,
              toId: agent.subscriberId,
              message: content,
            });
          });
        }
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Real-time append (called from EventBus.send)
// ---------------------------------------------------------------------------

/**
 * Append a single bus message to the timeline immediately on send.
 * Uses file lock to safely advance the watermark; if lock is contended,
 * skips the watermark update (next build will catch up — no data lost).
 */
function appendBusEntry(projectRoot, { seq, timestamp, publisher, target, message, nicknames = null }) {
  try {
    fs.mkdirSync(getHistoryDir(projectRoot), { recursive: true });
    const timelineFile = getTimelineFile(projectRoot);

    const nicknameMap = nicknames || buildNicknameLookup(projectRoot);
    const entry = {
      ts: timestamp,
      source: "bus",
      from: nicknameMap.get(publisher) || publisher,
      fromId: publisher,
      to: nicknameMap.get(target) || target,
      toId: target,
      message: redactString(message),
    };

    fs.appendFileSync(timelineFile, JSON.stringify(redactSecrets(entry)) + "\n", "utf8");

    if (seq) {
      const lock = acquireWatermarkLock(projectRoot);
      if (lock) {
        try {
          const watermark = readWatermark(projectRoot);
          if (seq > (watermark.busLastSeq || 0)) {
            watermark.busLastSeq = seq;
            if (timestamp && (!watermark.lastTs || timestamp > watermark.lastTs)) {
              watermark.lastTs = timestamp;
            }
            watermark.entryCount = (watermark.entryCount || 0) + 1;
            writeWatermark(projectRoot, watermark);
          }
        } finally {
          releaseWatermarkLock(lock);
        }
      }
      // lock contended → watermark update skipped; next build will reprocess
    }
  } catch (err) {
    debugLog("appendBusEntry failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Incremental build
// ---------------------------------------------------------------------------

/**
 * Build the timeline incrementally (or fully with force=true).
 * Reads watermark → collects only new entries → appends → updates watermark.
 * entryCount is maintained in the watermark to avoid full-file counting.
 */
function buildTimeline(projectRoot, { force = false } = {}) {
  fs.mkdirSync(getHistoryDir(projectRoot), { recursive: true });
  const timelineFile = getTimelineFile(projectRoot);

  const watermark = force ? { busLastSeq: 0, lastTs: "", entryCount: 0 } : readWatermark(projectRoot);

  const busResult = collectBusMessages(projectRoot, watermark);
  const claudeEntries = collectClaudeManualInputs(projectRoot, watermark);
  const codexEntries = collectCodexManualInputs(projectRoot, watermark);

  const newEntries = [...busResult.entries, ...claudeEntries, ...codexEntries];
  newEntries.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (newEntries.length === 0 && !force) {
    return { count: watermark.entryCount || 0, newCount: 0, file: timelineFile };
  }

  const lock = acquireWatermarkLock(projectRoot);
  try {
    if (force) {
      const content = newEntries.map((e) => JSON.stringify(redactSecrets(e))).join("\n") + (newEntries.length > 0 ? "\n" : "");
      fs.writeFileSync(timelineFile, content, "utf8");
    } else {
      fs.appendFileSync(
        timelineFile,
        newEntries.map((e) => JSON.stringify(redactSecrets(e))).join("\n") + "\n",
        "utf8"
      );
    }

    const prevCount = force ? 0 : (watermark.entryCount || 0);
    const lastEntry = newEntries[newEntries.length - 1];
    const newWatermark = {
      busLastSeq: busResult.maxSeq,
      lastTs: lastEntry ? lastEntry.ts : watermark.lastTs,
      entryCount: prevCount + newEntries.length,
      builtAt: new Date().toISOString(),
    };
    writeWatermark(projectRoot, newWatermark);
    return { count: newWatermark.entryCount, newCount: newEntries.length, file: timelineFile };
  } catch (err) {
    debugLog("buildTimeline failed:", err.message);
    throw err;
  } finally {
    releaseWatermarkLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Read / format / render
// ---------------------------------------------------------------------------

function readTimeline(projectRoot, limit = 50) {
  return readTailJSONL(getTimelineFile(projectRoot), limit);
}

function formatEntry(entry) {
  if (entry.source === "bus") {
    const label = entry.fromId && entry.fromId !== entry.from
      ? `${entry.fromId}(${entry.from})` : entry.from;
    return `[ufoo]<from:${label}> ${entry.message}`;
  }
  // manual: focus on who received it, not who sent (always user)
  const toLabel = entry.toId && entry.toId !== entry.to
    ? `${entry.toId}(${entry.to})` : entry.to;
  return `[manual]<to:${toLabel}> ${entry.message}`;
}

function renderTimelineForPrompt(projectRoot, limit = 30) {
  const entries = readTimeline(projectRoot, limit);
  if (entries.length === 0) return "";

  const lines = entries.map((entry) => {
    const time = entry.ts ? entry.ts.slice(0, 16).replace("T", " ") : "?";
    const prefix = entry.source === "bus"
      ? `[ufoo]<from:${entry.from}>`
      : `[manual]<to:${entry.to}>`;
    const msg = entry.message.length > 200 ? entry.message.slice(0, 200) + "..." : entry.message;
    return `${time} ${prefix} ${msg}`;
  });

  return [
    "## Team Activity (recent agent inputs)",
    "",
    "This shows recent prompts sent to agents. Use it to understand what each agent is working on.",
    "",
    ...lines,
  ].join("\n");
}

function showTimeline(projectRoot, limit = 50) {
  const entries = readTimeline(projectRoot, limit);
  if (entries.length === 0) {
    console.log("No timeline entries found. Run `ufoo history build` first.");
    return;
  }
  console.log(`=== Input Timeline (${entries.length} entries) ===\n`);
  for (const entry of entries) {
    const time = entry.ts ? entry.ts.slice(0, 19).replace("T", " ") : "?";
    console.log(`[${time}] ${formatEntry(entry)}`);
  }
}

module.exports = {
  getHistoryDir,
  getTimelineFile,
  getWatermarkFile,
  buildTimeline,
  appendBusEntry,
  readTimeline,
  readWatermark,
  formatEntry,
  renderTimelineForPrompt,
  showTimeline,
  getClaudeProjectDir,
  collectBusMessages,
  collectClaudeManualInputs,
  collectCodexManualInputs,
};
