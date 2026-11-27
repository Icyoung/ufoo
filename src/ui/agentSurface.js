"use strict";

// Presentation state shared by the standalone coding TUI and embedded agents.
// Providers supply events; this module owns no model, process or terminal.
const fmt = require("./format");
const { toolStatus, statusForAgentPhase, planLinesFromItems } = require("./agentPresentation");

const FILE_MUTATION_TOOL_RE = /^(?:apply_patch|edit|write|multiedit|notebookedit|edit_file|write_file|write_to_file|replace_in_file|replace_file_content|multi_replace_file_content|create_file|delete_file|multi_edit|patch_file|modify_file)$/i;

const DIRECT_USER_SOURCES = new Set([
  "ufoo-desktop",
  "ufoo-desktop-worker",
  "ufoo-desktop-handoff",
  "chat-direct",
  "chat-agent-view",
  "chat-internal-agent-view",
  "rust-multi-window",
  "user",
]);

function classifyIncomingSender(event = {}) {
  const publisher = String(event.publisher || "").trim();
  const source = String(event.source || "").trim().toLowerCase();
  const requestKind = String(event.requestKind || "").trim().toLowerCase();
  if (DIRECT_USER_SOURCES.has(source)) {
    return { sender_kind: "user", sender_id: "" };
  }
  if (!publisher || publisher === "user" || publisher === "unknown") {
    return { sender_kind: "user", sender_id: "" };
  }
  if (publisher === "ufoo-agent" || publisher.endsWith(":ufoo-agent")) {
    if (
      requestKind === "worker-task"
      || source === "ufoo-agent"
      || source === "group"
      || source === "group-bootstrap"
      || source === "workflow-handoff"
    ) {
      return { sender_kind: "coordinator", sender_id: "ufoo-agent" };
    }
    return { sender_kind: "user", sender_id: "" };
  }
  return { sender_kind: "peer", sender_id: publisher };
}

function normalizeFileChangeKind(rawKind = "", toolName = "") {
  const k = String(rawKind || "").trim().toLowerCase();
  if (k === "add" || k === "added" || k === "create" || k === "created") return "added";
  if (k === "delete" || k === "deleted" || k === "remove" || k === "removed") return "deleted";
  if (k === "update" || k === "updated" || k === "modify" || k === "modified" || k === "edit") return "modified";
  const t = String(toolName || "").trim().toLowerCase();
  if (t.includes("create")) return "added";
  if (t.includes("delete") || t.includes("remove")) return "deleted";
  return "modified";
}

function extractFilePathsFromToolArgs(toolName = "", args = {}) {
  const name = String(toolName || "").trim();
  const lower = name.toLowerCase();
  const isMutation = FILE_MUTATION_TOOL_RE.test(lower)
    || /\b(?:edit|write|patch|create|delete|modify)\b/i.test(lower);
  if (!isMutation || !args || typeof args !== "object") return [];
  const rawPaths = [];
  const push = (val, kindHint = "") => {
    if (typeof val !== "string") return;
    for (const part of val.split(",")) {
      const clean = part.trim();
      if (clean && !clean.startsWith("http://") && !clean.startsWith("https://")) {
        rawPaths.push({ path: clean, kind: normalizeFileChangeKind(kindHint, name) });
      }
    }
  };
  if (args.file_path) push(args.file_path);
  if (args.path) push(args.path);
  if (args.target_file) push(args.target_file);
  if (args.TargetFile) push(args.TargetFile);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) push(p);
  }
  if (Array.isArray(args.locations)) {
    for (const loc of args.locations) {
      if (loc && typeof loc.path === "string") push(loc.path);
    }
  }
  return rawPaths;
}

function extractFileChangesFromToolOutput(output, toolName = "") {
  if (!output || typeof output !== "object") return [];
  const out = [];
  const changes = Array.isArray(output.changes) ? output.changes : [];
  for (const item of changes) {
    if (!item || typeof item !== "object" || !item.path) continue;
    out.push({
      path: String(item.path).trim(),
      kind: normalizeFileChangeKind(item.kind || item.type || item.status, toolName),
    });
  }
  return out;
}

function eventTime(event) {
  return Number.isFinite(event?.observed_at) ? event.observed_at : Date.now();
}

function createAgentSurface(options = {}) {
  const maxEntries = options.maxEntries || 1000;
  const maxText = options.maxText || 256000;
  const rawMarkdown = options.rawMarkdown === true;
  let entries = [];
  let sequence = 0;
  let turn = "turn-0";
  let segment = 0;
  let status = "ready";
  let busy = false;
  let usage = "";
  let plan = [];
  let idlePlanHint = "";
  let revision = 0;
  let startedAt = 0;
  let waiting = false;
  let submitted = [];
  let activityOwnsStatus = false;
  let runningTask = false;
  const background = new Map();
  let contextUsage = "";
  const tools = new Map();
  const changedFiles = new Map();
  const renderedEntries = new WeakMap();

  function recordChangedFiles(items = []) {
    for (const item of items) {
      if (!item || !item.path) continue;
      const cleanPath = String(item.path).trim();
      if (!cleanPath) continue;
      const existing = changedFiles.get(cleanPath);
      const nextKind = existing && existing.kind === "added" && item.kind === "modified"
        ? "added"
        : (item.kind || "modified");
      changedFiles.set(cleanPath, { path: cleanPath, kind: nextKind });
    }
  }

  function presentEntry(row) {
    if (rawMarkdown || !["assistant", "thinking"].includes(row.kind) || /\x1b\[/.test(row.text)) return { ...row };
    let cached = renderedEntries.get(row);
    if (!cached || cached.source !== row.text) {
      cached = { source: row.text, text: fmt.renderLogLinesWithMarkdownAnsi(row.text, { inCodeBlock: false }).join("\n") };
      renderedEntries.set(row, cached);
    }
    return { ...row, text: cached.text };
  }

  function getEntry(id) {
    const row = entries.find((row) => row.id === id);
    return row ? presentEntry(row) : null;
  }

  function bound() {
    for (const entry of entries) {
      entry.text = String(entry.text || "").slice(-64000);
      entry.detail = String(entry.detail || "").slice(-64000);
    }
    let size = entries.reduce((n, e) => n + e.text.length + e.detail.length, 0);
    while (entries.length > maxEntries || (size > maxText && entries.length > 1)) {
      const removed = entries.shift();
      size -= removed.text.length + removed.detail.length;
      tools.delete(removed.id);
    }
    revision += 1;
  }

  function entry(id, kind, text = "", detail = "") {
    let row = entries.find((row) => row.id === id);
    if (!row) {
      row = { id, kind, text, detail, speaker: "", expanded: false };
      entries.push(row);
    }
    return row;
  }

  function apply(name, payload = {}) {
    if (name === "transcript.reset") {
      entries = (payload.entries || []).map((row) => ({ detail: "", speaker: "", expanded: false, ...row }));
      tools.clear();
      changedFiles.clear();
    } else if (name === "transcript.append") {
      const row = payload.entry || payload;
      Object.assign(entry(row.id || `entry-${++sequence}`, row.kind || "system"), row);
    } else if (name === "transcript.patch") {
      const row = entries.find((row) => row.id === payload.id);
      if (row && typeof payload.text === "string") row.text = payload.text;
    } else if (name === "stream.start") {
      busy = true;
      startedAt = Date.now();
    } else if (name === "stream.delta") {
      const id = payload.id || "stream";
      let row = entries.find((item) => item.id === id);
      if (!row) {
        row = { id, kind: "assistant", text: "", detail: "", speaker: "", expanded: false };
        if (payload.aboveTools) {
          let insertIdx = entries.length;
          while (insertIdx > 0 && ["tool", "thinking"].includes(entries[insertIdx - 1].kind)) {
            insertIdx -= 1;
          }
          entries.splice(insertIdx, 0, row);
        } else {
          entries.push(row);
        }
      }
      const chunk = String(payload.text || payload.delta || "");
      row.text = payload.reset ? chunk : row.text + chunk;
      busy = true;
      if (!startedAt) startedAt = Date.now();
    } else if (name === "thinking.start" || name === "thinking.delta") {
      const row = entry(payload.id || "thinking", "thinking");
      if (name === "thinking.delta") {
        const chunk = String(payload.text || "");
        row.text = payload.reset ? chunk : row.text + chunk;
      }
    } else if (name === "stream.done") {
      const { tool_group_id: toolGroupId, thinking_id: thinkingId } = payload;
      if (toolGroupId || thinkingId) {
        entries = entries.filter((row) =>
          !(row.kind === "tool" && row.id === toolGroupId)
          && !(row.kind === "thinking" && row.id === thinkingId));
      }
      for (const row of entries) {
        if (row.streaming) row.streaming = false;
        if (row.kind === "tool" && row.tool_status === "running") {
          row.tool_status = payload.reason === "error" ? "error" : "done";
        }
      }
      busy = false;
      status = payload.reason === "error" ? "error" : "ready";
    } else if (["tool.start", "tool.result", "tool.group"].includes(name)) {
      const row = entry(payload.id || `tool-${++sequence}`, "tool");
      row.text = String(payload.summary || payload.text || "tool");
      row.detail = String(payload.detail || payload.expanded_text || "");
      if (payload.turn_id) row.turn_id = payload.turn_id;
      if (payload.tool_name) row.tool_name = payload.tool_name;
      if (payload.tool_status) {
        row.tool_status = payload.tool_status;
      }
      if (Array.isArray(payload.changed_files) && payload.changed_files.length > 0) {
        row.changed_files = payload.changed_files;
      }
      if (Number.isFinite(payload.duration_ms)) row.duration_ms = payload.duration_ms;
      if (!rawMarkdown && row.detail && !row.text.includes("Ctrl+O") && row.detail.includes("\n")) row.text += " (Ctrl+O expand)";
    } else if (name === "status.set") {
      status = String(payload.text || "ready");
      if (typeof payload.busy === "boolean") busy = payload.busy;
      if (busy && !startedAt) startedAt = Date.now();
    } else if (name === "usage.set") {
      usage = String(payload.label || payload.text || "");
    } else if (name === "plan.set") {
      plan = (payload.lines || []).map(String);
      idlePlanHint = String(payload.idle_hint || "");
    } else {
      return false;
    }
    bound();
    return true;
  }

  function accept(event = {}) {
    const type = event.type;
    if (type === "surface_cleared") {
      entries.length = 0;
      changedFiles.clear();
      tools.clear();
      submitted.length = 0;
      background.clear();
      plan = [];
      idlePlanHint = "";
      usage = "";
      contextUsage = "";
      runningTask = false;
      waiting = false;
      busy = false;
      startedAt = 0;
      activityOwnsStatus = false;
      status = "ready";
      return apply("transcript.reset", { entries: [] });
    }
    if (type === "task_submitted") {
      submitted.push({ message: String(event.message || ""), at: Date.now() });
      waiting = false;
      if (!busy) {
        activityOwnsStatus = false;
        startedAt = Date.now();
        return apply("status.set", { text: "Waiting for agent…", busy: true });
      }
      bound();
      return true;
    }
    if (type === "submission_failed") {
      const index = submitted.findIndex((item) => item.message === event.message);
      if (index >= 0) submitted.splice(index, 1);
      apply("transcript.append", { kind: "error", text: event.error });
      return runningTask ? true : apply("status.set", { text: "error", busy: false });
    }
    if (type === "task_started") {
      const queued = submitted.findIndex((item) => item.message === String(event.message || ""));
      if (queued >= 0) submitted.splice(queued, 1);
      activityOwnsStatus = false;
      runningTask = true;
      waiting = false;
      startedAt = 0;
      turn = String(event.task_id || `turn-${++sequence}`);
      segment = 0;
      tools.clear();
      const message = String(event.message || "");
      const last = entries[entries.length - 1];
      const sender = classifyIncomingSender(event);
      if (message && queued < 0 && !(last?.kind === "user" && last.text === message)) {
        apply("transcript.append", {
          id: `${turn}-user`,
          kind: "user",
          text: message,
          sender_kind: sender.sender_kind,
          ...(sender.sender_id ? { sender_id: sender.sender_id } : {}),
        });
      }
      status = "Waiting for model…";
      return apply("stream.start", {});
    }
    if (type === "turn_started" || type === "thread_started") {
      waiting = false;
      activityOwnsStatus = false;
      return apply("status.set", { text: "Waiting for model…", busy: true });
    }
    if (type === "phase") {
      const text = statusForAgentPhase(event.phase || {});
      return text ? apply("status.set", { text, busy: true }) : false;
    }
    if (type === "status") {
      waiting = event.state === "waiting_input";
      return apply("status.set", { text: event.text || event.state, busy: event.busy ?? !waiting });
    }
    if (type === "context_usage") {
      contextUsage = String(event.meter?.label || "");
      return apply("usage.set", { text: contextUsage });
    }
    if (type === "plan") return apply("plan.set", { ...event, lines: event.lines || planLinesFromItems(event.items || []) });
    if (type === "background_task") {
      const id = String(event.task_id || "");
      if (!id) return false;
      background.set(id, { ...background.get(id), ...Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) });
      if (background.size > 100) background.delete(background.keys().next().value);
      bound();
      return true;
    }
    if (type === "text_delta") {
      status = "Generating response…";
      return apply("stream.delta", { id: `${turn}-text-${segment}`, text: event.delta });
    }
    if (type === "thinking_delta") {
      status = "Thinking…";
      busy = true;
      return apply("thinking.delta", { id: `${turn}-thinking-${segment}`, text: event.delta });
    }
    if (type === "tool_call") {
      segment += 1;
      const id = `${turn}-tool-${String(event.toolCallId || segment)}`;
      const name = String(event.name || "tool");
      const args = event.args || {};
      const detail = fmt.normalizeToolLogDetail(name.toLowerCase(), { ...args, path: args.path || args.file_path }, {});
      const normalized = fmt.normalizeToolMergeEntry({ tool: name.toLowerCase(), detail, isError: false });
      const summary = fmt.buildUcodeToolRowText([normalized]) || `• ${name}`;
      const argChanges = extractFilePathsFromToolArgs(name, args);
      const toolFiles = new Map();
      for (const ch of argChanges) toolFiles.set(ch.path, ch);
      const rawCommand = typeof args.command === "string"
        ? args.command
        : (typeof args.cmd === "string" ? args.cmd : "");
      const headerContext = rawCommand ? `$ ${rawCommand}` : summary.replace(/^• /, "");
      tools.set(id, { summary, headerContext, output: "", name, startedAt: eventTime(event), files: toolFiles });
      recordChangedFiles(argChanges);
      status = toolStatus(name);
      busy = true;
      if (["plan", "TodoWrite", "update_plan"].includes(name)) {
        apply("plan.set", { lines: planLinesFromItems(args.items || args.todos || args.plan || []) });
      }
      return apply("tool.start", {
        id,
        summary,
        turn_id: turn,
        tool_name: name,
        tool_status: "running",
        ...(toolFiles.size > 0 ? { changed_files: [...toolFiles.values()] } : {}),
      });
    }
    if (type === "tool_result") {
      const id = `${turn}-tool-${String(event.toolCallId || "tool")}`;
      const tool = tools.get(id) || { summary: "• Tool", headerContext: "Tool", output: "", name: "tool", startedAt: 0, files: new Map() };
      const output = typeof event.output === "string" ? event.output
        : Array.isArray(event.output) ? event.output.map((block) => block?.text || "").join("\n")
        : event.output == null ? "" : typeof event.output === "object"
          ? [event.output.stdout, event.output.stderr, event.output.content, event.output.error].filter((text) => typeof text === "string" && text).join("\n") || JSON.stringify(event.output)
          : String(event.output);
      tool.output = (tool.output + output).slice(-64000);
      const outChanges = extractFileChangesFromToolOutput(event.output, tool.name);
      if (!tool.files) tool.files = new Map();
      for (const ch of outChanges) {
        const prev = tool.files.get(ch.path);
        tool.files.set(ch.path, {
          path: ch.path,
          kind: prev && prev.kind === "added" && ch.kind === "modified" ? "added" : ch.kind,
        });
      }
      tools.set(id, tool);
      recordChangedFiles(outChanges);
      const isError = Boolean(event.is_error || (Number.isFinite(event.exitCode) && event.exitCode !== 0));
      if (isError && !tool.summary.startsWith("• Failed: ")) tool.summary = tool.summary.replace(/^• /, "• Failed: ");
      const exit = Number.isFinite(event.exitCode) && event.exitCode !== 0 ? `\n[exit ${event.exitCode}]` : "";
      const detailHeader = tool.headerContext || tool.summary.replace(/^• /, "");
      const detail = [detailHeader, tool.output + exit].filter(Boolean).join("\n");
      const inProgress = event.status === "in_progress";
      if (!inProgress) status = "Waiting for model…";
      const durationMs = !inProgress && tool.startedAt ? Math.max(0, eventTime(event) - tool.startedAt) : undefined;
      return apply("tool.result", {
        id,
        summary: tool.summary,
        detail,
        turn_id: turn,
        tool_name: tool.name,
        tool_status: inProgress ? "running" : (isError ? "error" : "done"),
        is_error: isError,
        ...(tool.files.size > 0 ? { changed_files: [...tool.files.values()] } : {}),
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
      });
    }
    if (["task_completed", "task_failed", "task_cancelled", "task_paused"].includes(type)) {
      if (event.error) apply("transcript.append", { kind: "error", text: event.error });
      if (event.usage) accept({ type: "usage", usage: event.usage });
      apply("stream.done", { reason: type === "task_failed" ? "error" : "complete" });
      activityOwnsStatus = false;
      runningTask = false;
      if (type === "task_cancelled") status = "cancelled";
      if (waiting) status = "Waiting for reply…";
      else if (submitted.length) apply("status.set", { text: "Waiting for agent…", busy: true });
      return true;
    }
    if (type === "interaction") {
      waiting = true;
      status = "Waiting for reply…";
      busy = false;
      return apply("transcript.append", { id: `${turn}-interaction`, kind: "system", text: (event.lines || []).join("\n") });
    }
    if (type === "usage") {
      const u = event.usage || {};
      return apply("usage.set", { text: contextUsage || `${u.input_tokens ?? u.input ?? 0} in · ${u.output_tokens ?? u.output ?? 0} out` });
    }
    if (type === "activity") {
      if (event.authoritative !== true && (busy || waiting)) return false;
      const state = String(event.state || "ready");
      const at = Date.parse(event.ts || "");
      if (submitted.length && state !== "working" && state !== "busy" && (!at || at < submitted[0].at)) return false;
      if (["working", "busy", "processing"].includes(state)) {
        if (!activityOwnsStatus && submitted.length) submitted.shift();
        activityOwnsStatus = true;
        runningTask = true;
        waiting = false;
        if (!startedAt) startedAt = Number(event.started_at) || Date.now();
        const detail = String(event.detail || "");
        const text = detail.startsWith("tool ") ? toolStatus(detail.slice(5))
          : detail === "thinking" ? "Thinking…" : detail || "Working…";
        return apply("status.set", { text, busy: true });
      }
      activityOwnsStatus = false;
      runningTask = false;
      waiting = ["waiting_input", "waiting"].includes(state);
      const text = waiting ? "Waiting for reply…" : ["blocked", "error"].includes(state)
        ? `blocked${event.detail ? ` · ${event.detail}` : ""}`
        : state === "starting" ? "Starting agent…" : "ready";
      return apply("status.set", { text, busy: state === "starting" });
    }
    return false;
  }

  function toggleExpanded() {
    const row = [...entries].reverse().find((row) => row.kind === "thinking" || (row.kind === "tool" && row.detail));
    if (!row) return false;
    row.expanded = !row.expanded;
    revision += 1;
    return true;
  }

  function snapshot() {
    const bg = [...background.values()];
    const running = bg.filter((task) => ["running", "pending"].includes(task.status)).length;
    const done = bg.filter((task) => task.status === "completed").length;
    const failed = bg.filter((task) => ["failed", "stopped", "killed"].includes(task.status)).length;
    const suffix = [running && `${running} running`, done && `${done} done`, failed && `${failed} failed`].filter(Boolean).join("/");
    const label = `${status}${!busy && status === "ready" && idlePlanHint ? ` · ${idlePlanHint}` : ""}${submitted.length > 1 || (submitted.length && runningTask) ? ` · queued ${submitted.length} · Alt+Enter immediately` : ""}${suffix ? ` · BG ${suffix}` : ""}`;
    return {
      entries: entries.map(presentEntry),
      status: label,
      busy,
      usage,
      plan: plan.slice(),
      changed_files: [...changedFiles.values()],
      revision,
      started_at: startedAt,
    };
  }

  return { apply, accept, snapshot, getEntry, toggleExpanded };
}

// Keep source deltas in the surface; send the rendered entry as a replacement
// so delimiters split across chunks and multi-line tables can be re-evaluated.
function projectSurfaceEvent(surface, name, payload = {}) {
  const delta = name === "stream.delta" || name === "thinking.delta";
  const id = payload.id || (name === "thinking.delta" ? "thinking" : "stream");
  const exists = delta && Boolean(surface.getEntry(id));
  surface.apply(name, payload);
  if (delta) {
    const snapEntries = surface.snapshot().entries;
    const isLast = snapEntries.length > 0 && snapEntries[snapEntries.length - 1].id === id;
    if (!exists && !isLast) {
      return { name: "transcript.reset", payload: { entries: snapEntries } };
    }
    const row = surface.getEntry(id);
    return { name: exists ? "transcript.patch" : "transcript.append", payload: row };
  }
  if (name === "transcript.reset") return { name, payload: { ...payload, entries: surface.snapshot().entries } };
  return { name, payload };
}

module.exports = { createAgentSurface, projectSurfaceEvent };
