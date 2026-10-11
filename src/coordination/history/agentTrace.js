"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../state/paths");
const { redactSecrets } = require("../../runtime/privacy/redactor");
const { normalizeTraceContext } = require("../../agents/runtime/protocol/traceContext");
const { observationFingerprint } = require("../../agents/runtime/protocol/runObservation");
const { summarizeAgentPerformance } = require("./agentPerformance");

const TYPES = { run_config: "run.config", task_started: "task.started", task_completed: "task.completed", task_failed: "task.failed", task_cancelled: "task.cancelled", task_paused: "task.paused",
  turn_started: "model.started", turn_completed: "model.completed", turn_failed: "model.failed", tool_call: "tool.started", text_delta: "message.delta", thinking_delta: "thinking.delta", context_usage: "context.usage" };
const clip = value => String(value || "").replace(/\s+/g, " ").slice(0, 240);

/** Read-only view over canonical journals, reports, display events and queues. */
function readAgentTrace(projectRoot, options = {}) {
  const root = path.resolve(projectRoot);
  const paths = getUfooPaths(root);
  const warnings = [];
  const entries = dir => {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") warnings.push({ source: path.relative(root, dir), code: error.code || "source_unavailable" }); return []; }
  };
  let remaining = Math.max(1, Math.floor(Number(options.maxReadBytes) || 32 * 1024 * 1024));
  const read = file => {
    let fd;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) return [];
      if (!stat.isFile()) { warnings.push({ source: path.relative(root, file), code: "invalid_source_type" }); return []; }
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      const count = Math.min(size, 2 * 1024 * 1024, remaining);
      if (count < size) warnings.push({ source: path.relative(root, file), code: "source_tail_truncated", totalBytes: size, readBytes: count });
      if (!count) return [];
      remaining -= count;
      const buffer = Buffer.alloc(count);
      fs.readSync(fd, buffer, 0, count, size - count);
      const text = buffer.toString("utf8");
      let lines = text.split("\n");
      if (lines.at(-1)?.trim()) { warnings.push({ source: path.relative(root, file), code: "incomplete_record" }); lines.pop(); }
      if (count < size) lines.shift();
      return lines.flatMap((line, index) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line);
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid record");
          return [{ value, line: index, source: path.relative(root, file) }];
        }
        catch { warnings.push({ source: path.relative(root, file), code: "incomplete_or_invalid_record" }); return []; }
      });
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push({ source: path.relative(root, file), code: error.code || "source_unavailable" });
      return [];
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  const runtimes = [];
  for (const namespace of entries(paths.agentDir).filter(e => e.isDirectory())) {
    const dir = path.join(paths.agentDir, namespace.name, "runtimes");
    for (const session of entries(dir).filter(e => e.isDirectory())) runtimes.push(path.join(dir, session.name, "events.jsonl"));
  }
  if (runtimes.length > 200) warnings.push({ code: "runtime_file_limit", total: runtimes.length, read: 200 });
  const modified = file => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } };
  const records = runtimes.sort((a, b) => modified(b) - modified(a)).slice(0, 200).flatMap(read);
  const tasks = new Map();
  const events = [];
  function add(event, record, index = "") {
    const value = { id: `${record.source}:${record.value.eventId || record.value.seq || record.value.sequence || record.value.entry_id || record.value.timestamp || record.line}${index}`,
      source: record.source, ...event, time: String(event.time || event.timestamp || event.ts || "") };
    if (event.type === "observation.warning") warnings.push({ source: record.source, code: event.warning?.code || "observation_unavailable" });
    delete value.eventId;
    if (!options.details) { delete value.args; delete value.result; delete value.text; delete value.phase; delete value.message; delete value.error; }
    events.push(value);
  }
  function normalize(event) {
    const result = event.result || {};
    return { type: event.type, time: event.time || event.timestamp || "", sequence: event.sequence,
      sessionId: event.sessionId, agentId: event.agentId || (event.sessionId === "control" ? "ufoo-agent" : ""),
      traceId: event.traceId, taskId: event.taskId || event.request?.taskId, taskRunId: event.taskRunId, parentTaskRunId: event.parentTaskRunId || event.request?.parentTaskRunId,
      parentSessionId: event.parentSessionId, requestId: event.requestId || event.request?.requestId, turnId: event.turnId, toolCallId: event.toolCallId, toolName: event.toolName,
      attemptId: event.attemptId, argumentFingerprint: event.argumentFingerprint || (event.args ? observationFingerprint(event.args) : undefined),
      durationMs: event.durationMs, usage: event.usage || result.usage, status: event.status,
      ...(event.configuration ? { configuration: event.configuration } : {}),
      ...(event.repeatedSteps !== undefined ? { repeatedSteps: event.repeatedSteps } : {}),
      ...(typeof event.text === "string" ? { textCharacters: [...event.text].length } : {}),
      ...(typeof result.text === "string" ? { finalTextCharacters: [...result.text].length } : {}),
      ...(event.finalTextCharacters != null ? { finalTextCharacters: event.finalTextCharacters } : {}),
      ...(result.code ? { resultCode: result.code } : {}),
      provider: event.provider, model: event.model, transport: event.transport, estimatedInputTokens: event.estimatedInputTokens,
      ...(["model.started", "model.completed", "model.failed"].includes(event.type) ? { modelScope: event.modelScope || "api-call" } : {}),
      summary: clip(event.error?.message || event.error || result.error?.message || result.error || event.text || result.text || event.phase?.type || event.type),
      ...(event.args ? { args: event.args } : {}), ...(event.result ? { result: event.result, ok: result.ok } : {}),
      ...(event.text ? { text: event.text } : {}), ...(event.phase ? { phase: event.phase } : {}),
      ...(event.binding ? { binding: event.binding } : {}), ...(event.code ? { code: event.code } : {}), ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.warning ? { warning: event.warning } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(String(event.type || "").startsWith("context.compaction") ? { coveredCount: event.coveredCount, batchCount: event.batchCount, checkpointVersion: event.version, sourceArchive: event.sourceArchive } : {}) };
  }
  for (const record of records) {
    const e = record.value;
    if (e.type === "capability.state_committed") {
      const assignments = e.capabilityId === "agent-management" ? e.value?.tasks : e.capabilityId === "task-execution" ? e.value?.jobs : null;
      for (const task of Object.values(assignments || {})) {
        const id = task.taskId || task.taskRunId || task.id;
        const previous = tasks.get(id);
        if (previous?.status !== task.status || previous?.report?.entry_id !== task.report?.entry_id) add({ type: "delegation.state", time: e.time,
          taskId: id, taskRunId: task.taskRunId, traceId: task.traceId, parentTaskRunId: task.parentTaskRunId, parentSessionId: task.parentSessionId,
          agentId: task.workerId || task.id, status: task.status, summary: `${task.status}${task.report?.phase ? ` (${task.report.phase})` : ""}` }, record, `:${id}`);
        tasks.set(id, task);
      }
      continue;
    }
    if (e.type && typeof e.type !== "string") { warnings.push({ source: record.source, code: "invalid_event_type" }); continue; }
    if (!e.type || ["command.started", "command.resolved"].includes(e.type)) {
      if (e.type) {
        const task = [...tasks.values()].find(task => task.commandIds?.includes(e.commandId));
        add({ ...normalize(e), taskId: task?.taskId, parentTaskRunId: task?.parentTaskRunId, traceId: task?.traceId,
          agentId: task?.workerId || "ufoo-agent", commandId: e.commandId, commandKind: e.kind,
          summary: `${e.type} ${e.kind || e.commandId || ""}` }, record);
      }
      continue;
    }
    add(normalize(e), record);
  }
  const busFiles = entries(paths.busEventsDir).filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => path.join(paths.busEventsDir, e.name)).sort().reverse();
  if (busFiles.length > 14) warnings.push({ code: "bus_day_limit", total: busFiles.length, read: 14 });
  const bus = busFiles.slice(0, 14).flatMap(read);
  const nativeRuns = new Set(records.filter(r => r.source.includes("/ucode/runtimes/"))
    .flatMap(r => [r.value.taskRunId, r.value.parentTaskRunId]).filter(Boolean));
  const committedEvents = new Set(records.map(r => r.value.eventId).filter(Boolean));
  for (const record of bus) {
    const e = record.value;
    if (e.event === "agent_surface") {
      const surface = e.data?.surface || {};
      // Native core events have their own canonical journal. Avoid displaying
      // the same tool/text lifecycle again through its presentation adapter.
      if (surface.type === "runtime_event") {
        if (surface.event && !committedEvents.has(surface.event.eventId)) add({ ...normalize(surface.event),
          agentId: e.publisher, taskId: surface.task_id || surface.taskId, time: surface.event.time || e.timestamp }, record);
        continue;
      }
      if (nativeRuns.has(surface.taskRunId) && ["tool_call", "tool_result", "text_delta", "thinking_delta", "turn_started", "turn_completed"].includes(surface.type)) continue;
      const type = surface.type === "tool_result" ? surface.status === "in_progress" ? "tool.progress" : "tool.completed" : TYPES[surface.type] || surface.type;
      add({ ...normalize({ ...surface, type, modelScope: "sdk-turn", toolName: surface.name, text: surface.delta, result: surface.type === "tool_result" ? { output: surface.output,
        ok: surface.is_error !== true && surface.status !== "failed" && (!Number.isFinite(surface.exitCode) || surface.exitCode === 0), exitCode: surface.exitCode } : undefined }),
        time: e.timestamp, agentId: e.publisher, taskId: surface.task_id || surface.taskId, busSequence: e.seq, queueSequence: surface.queueSequence, model: surface.model, provider: surface.provider,
        summary: clip(surface.error || surface.delta || surface.name || surface.phase?.type || type) }, record);
    } else if (e.event === "message" && e.data?.runtime_context) {
      add({ ...normalizeTraceContext(e.data.runtime_context), type: "queue.enqueued", time: e.timestamp, agentId: e.target, publisher: e.publisher,
        busSequence: e.seq, taskId: e.data.task_id, summary: clip(e.data.message), ...(options.details ? { message: e.data.message } : {}) }, record);
    } else if (e.event === "activity_state_changed") {
      add({ type: "agent.activity", time: e.timestamp, agentId: e.publisher, status: e.data?.state, summary: [e.data?.state, e.data?.detail].filter(Boolean).join(" ") }, record);
    }
  }
  for (const record of read(path.join(paths.agentDir, "reports.jsonl"))) {
    const e = record.value;
    add({ ...normalizeTraceContext(e.meta), type: `report.${e.phase}`, time: e.ts, agentId: e.agent_id, taskId: e.task_id, reportSource: e.source,
      reportCharacters: [...String(e.summary || e.message || e.error || "")].length,
      ...(e.meta?.cancelled ? { cancelled: true } : {}),
      reportId: e.entry_id, scope: e.scope, controllerId: e.controller_id, summary: clip(e.error || e.summary || e.message || e.phase) }, record);
  }
  const queues = [];
  for (const dir of entries(paths.busQueuesDir).filter(e => e.isDirectory())) {
    const base = path.join(paths.busQueuesDir, dir.name);
    for (const file of entries(base).filter(e => e.isFile() && (e.name === "pending.jsonl" || e.name.includes("processing")))) {
      for (const record of read(path.join(base, file.name))) {
        const e = record.value;
        queues.push({ agentId: e.target, publisher: e.publisher, taskId: e.data?.task_id || e.data?.runtime_context?.taskId,
          sequence: e.seq, enqueuedAt: e.timestamp, state: file.name === "pending.jsonl" ? "pending" : "claimed", source: record.source });
      }
    }
  }
  const reportQueue = path.join(paths.busDir, "control", "report");
  for (const file of entries(reportQueue).filter(e => e.isFile() && (e.name === "pending.jsonl" || e.name.includes("processing")))) {
    for (const record of read(path.join(reportQueue, file.name))) {
      const report = record.value.data?.report;
      if (report) queues.push({ kind: "report", agentId: report.agent_id, taskId: report.task_id, phase: report.phase,
        state: file.name === "pending.jsonl" ? "pending" : "claimed", source: record.source });
    }
  }
  let agents = {};
  try { agents = JSON.parse(fs.readFileSync(paths.agentsFile, "utf8")).agents || {}; } catch { /* optional registration */ }
  const requestedAgent = options.agent_id || "";
  const agentId = Object.keys(agents).find(id => id === requestedAgent || agents[id].nickname === requestedAgent) || requestedAgent;
  const selected = String(options.task_id || "");
  const related = new Set(selected ? [selected] : []);
  if (selected) {
    // Expand only descendants; include parent lifecycle as evidence without
    // pulling in unrelated sibling jobs that happen to share that parent.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks.values()) if (related.has(task.taskId || task.taskRunId || task.id) || related.has(task.parentTaskRunId)) {
        for (const id of [task.taskId, task.taskRunId, task.id].filter(Boolean)) if (!related.has(id)) { related.add(id); changed = true; }
      }
      for (const e of events) if (related.has(e.taskId) && e.taskRunId && !related.has(e.taskRunId)) { related.add(e.taskRunId); changed = true; }
    }
  }
  const selectedTasks = [...tasks.values()].filter(t => (!selected || related.has(t.taskId || t.taskRunId || t.id)) && (!agentId || t.workerId === agentId || t.id === agentId));
  const parents = new Set(selectedTasks.map(t => t.parentTaskRunId).filter(Boolean));
  const since = options.since ? Date.parse(options.since) : null;
  if (since !== null && !Number.isFinite(since)) throw new Error("since must be an ISO timestamp");
  const scoped = events.filter(e => (!selected || related.has(e.taskId) || related.has(e.taskRunId) || parents.has(e.taskRunId))
    && (!agentId || e.agentId === agentId)
    && (!options.session_id || e.sessionId === options.session_id)).sort((a, b) => a.time.localeCompare(b.time)
      || (a.source === b.source ? (a.sequence || a.busSequence || 0) - (b.sequence || b.busSequence || 0) : 0) || a.id.localeCompare(b.id));
  const matched = scoped.filter(e => since === null || Date.parse(e.time) >= since);
  const selectedQueues = queues.filter(q => (!selected || related.has(q.taskId)) && (!agentId || q.agentId === agentId));
  const limit = Math.max(1, Math.min(2000, Number(options.limit) || 200));
  const offset = options.offset === undefined ? Math.max(0, matched.length - limit) : Math.max(0, Math.floor(Number(options.offset) || 0));
  const last = offset + limit;
  const toolCalls = new Map();
  for (const e of matched.filter(e => ["tool.started", "tool.completed", "tool.failed"].includes(e.type))) {
    if (!e.toolCallId) warnings.push({ source: e.source, code: "missing_tool_call_id" });
    const key = `${e.taskRunId || e.taskId || e.agentId}:${e.toolCallId || e.id}`;
    if (!toolCalls.has(key)) toolCalls.set(key, { toolCallId: e.toolCallId, toolName: e.toolName, agentId: e.agentId, taskRunId: e.taskRunId, started: false, ended: false });
    const call = toolCalls.get(key);
    if (e.type === "tool.started") { call.started = true; call.startedAt ||= e.time; }
    else { call.ended = true; call.endedAt = e.time; call.outcome = e.type === "tool.failed" ? "unknown" : e.ok === false ? "error" : "ok";
      call.durationMs = e.durationMs ?? (call.startedAt ? Math.max(0, Date.parse(e.time) - Date.parse(call.startedAt)) : undefined); }
  }
  const taskView = task => options.details ? task : { taskId: task.taskId || task.id, taskRunId: task.taskRunId,
    traceId: task.traceId, workerId: task.workerId, parentTaskRunId: task.parentTaskRunId, parentSessionId: task.parentSessionId,
    status: task.status, reportPhase: task.report?.phase, summary: clip(task.report?.error || task.report?.summary || task.report?.message), acceptance: task.acceptance };
  const performance = summarizeAgentPerformance(scoped.filter(e => !selected || related.has(e.taskId) || related.has(e.taskRunId)), selectedTasks, selectedQueues,
    { ...(options.performanceQuery || { since: options.since, includeRuns: false }), warnings });
  return redactSecrets({ version: 1, projectRoot: root, taskId: selected || null, total: matched.length, offset,
    next_offset: last < matched.length ? last : null, has_more_before: offset > 0,
    events: matched.slice(offset, last), tasks: selectedTasks.slice(-100).map(taskView),
    counts: { modelCalls: matched.filter(e => e.type === "model.started" && e.modelScope === "api-call").length,
      sdkTurns: matched.filter(e => e.type === "model.started" && e.modelScope === "sdk-turn").length,
      modelFailures: matched.filter(e => e.type === "model.failed").length, toolCalls: toolCalls.size,
      toolErrors: [...toolCalls.values()].filter(t => t.outcome === "error").length,
      unresolvedTools: [...toolCalls.values()].filter(t => !t.ended || t.outcome === "unknown").length,
      compactions: matched.filter(e => e.type === "context.compaction.completed").length,
      compactionFailures: matched.filter(e => e.type === "context.compaction.failed").length },
    tools: [...toolCalls.values()],
    performance,
    queues: selectedQueues.slice(-100),
    incomplete: warnings.length > 0, warnings });
}

function readAgentPerformance(projectRoot, options = {}) {
  const trace = readAgentTrace(projectRoot, { task_id: options.task_id, agent_id: options.agent_id, session_id: options.session_id,
    maxReadBytes: options.maxReadBytes, limit: 1, performanceQuery: options });
  return { projectRoot: trace.projectRoot, taskId: trace.taskId, ...trace.performance };
}

module.exports = { readAgentTrace, readAgentPerformance };
