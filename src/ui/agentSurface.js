"use strict";

// Presentation state shared by the standalone coding TUI and embedded agents.
// Providers supply events; this module owns no model, process or terminal.
const fmt = require("./format");
const { toolStatus, statusForAgentPhase, planLinesFromItems } = require("./agentPresentation");

function createAgentSurface(options = {}) {
  const maxEntries = options.maxEntries || 1000;
  const maxText = options.maxText || 256000;
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
      entry(payload.id || "stream", "assistant").text += String(payload.text || payload.delta || "");
      busy = true;
      if (!startedAt) startedAt = Date.now();
    } else if (name === "thinking.start" || name === "thinking.delta") {
      const row = entry(payload.id || "thinking", "thinking");
      if (name === "thinking.delta") row.text += String(payload.text || "");
    } else if (name === "stream.done") {
      busy = false;
      status = payload.reason === "error" ? "error" : "ready";
    } else if (["tool.start", "tool.result", "tool.group"].includes(name)) {
      const row = entry(payload.id || `tool-${++sequence}`, "tool");
      row.text = String(payload.summary || payload.text || "tool");
      row.detail = String(payload.detail || payload.expanded_text || "");
      if (row.detail && !row.text.includes("Ctrl+O") && row.detail.includes("\n")) row.text += " (Ctrl+O expand)";
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
      if (message && queued < 0 && !(last?.kind === "user" && last.text === message)) {
        apply("transcript.append", { id: `${turn}-user`, kind: "user", text: message });
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
      tools.set(id, { summary, output: "" });
      status = toolStatus(name);
      busy = true;
      if (["plan", "TodoWrite", "update_plan"].includes(name)) {
        apply("plan.set", { lines: planLinesFromItems(args.items || args.todos || args.plan || []) });
      }
      return apply("tool.start", { id, summary });
    }
    if (type === "tool_result") {
      const id = `${turn}-tool-${String(event.toolCallId || "tool")}`;
      const tool = tools.get(id) || { summary: "• Tool", output: "" };
      const output = typeof event.output === "string" ? event.output
        : Array.isArray(event.output) ? event.output.map((block) => block?.text || "").join("\n")
        : event.output == null ? "" : typeof event.output === "object"
          ? [event.output.stdout, event.output.stderr, event.output.content, event.output.error].filter((text) => typeof text === "string" && text).join("\n") || JSON.stringify(event.output)
          : String(event.output);
      tool.output = (tool.output + output).slice(-64000);
      tools.set(id, tool);
      if (event.is_error || (Number.isFinite(event.exitCode) && event.exitCode !== 0)) tool.summary = tool.summary.replace(/^• /, "• Failed: ");
      const exit = Number.isFinite(event.exitCode) && event.exitCode !== 0 ? `\n[exit ${event.exitCode}]` : "";
      const detail = [tool.summary.replace(/^• /, ""), tool.output + exit].filter(Boolean).join("\n");
      if (event.status !== "in_progress") status = "Waiting for model…";
      return apply("tool.result", { id, summary: tool.summary, detail });
    }
    if (["task_completed", "task_failed", "task_cancelled"].includes(type)) {
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
    const label = `${status}${!busy && status === "ready" && idlePlanHint ? ` · ${idlePlanHint}` : ""}${submitted.length > 1 || (submitted.length && runningTask) ? ` · queued ${submitted.length}` : ""}${suffix ? ` · BG ${suffix}` : ""}`;
    return { entries: entries.map((row) => ({ ...row })), status: label, busy, usage, plan: plan.slice(), revision, started_at: startedAt };
  }

  return { apply, accept, snapshot, toggleExpanded };
}

module.exports = { createAgentSurface };
