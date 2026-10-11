"use strict";
const { readAgentTrace } = require("../../coordination/history/agentTrace");
function runTraceCommand(taskId, options = {}) {
  const query = { task_id: options.task || taskId || "", agent_id: options.agent, session_id: options.session, since: options.since,
    limit: options.limit || (options.follow ? 2000 : 200), offset: options.offset, details: options.details === true };
  const root = options.project || process.cwd();
  const seen = new Set();
  let state = "";
  const emit = () => {
    const result = readAgentTrace(root, query);
    if (options.json && !options.follow) { console.log(JSON.stringify(result, null, 2)); return; }
    const signature = JSON.stringify({ tasks: result.tasks.map(t => [t.taskId || t.id, t.status, t.reportPhase || t.report?.phase]),
      counts: result.counts, outcomes: result.performance.summary.outcomes, queues: result.queues, warnings: result.warnings });
    if (signature !== state) {
      if (options.json) console.log(JSON.stringify({ type: "trace.state", projectRoot: result.projectRoot, tasks: result.tasks,
        counts: result.counts, performance: result.performance, queues: result.queues, warnings: result.warnings }));
      else console.log(`Trace: ${result.total} events; ${result.tasks.map(t => `${t.taskId || t.id}=${t.status}`).join(", ") || "no delegated tasks"}${result.incomplete ? " (partial sources; use --json for warnings)" : ""}`);
      state = signature;
    }
    for (const e of result.events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      console.log(options.json ? JSON.stringify(e) : `${e.time} ${e.agentId || "runtime"} ${e.type} ${e.toolName || ""} ${e.summary || ""}${e.durationMs === undefined ? "" : ` (${e.durationMs}ms)`}`);
      if (!options.json && options.details && (e.args || e.result)) console.log(JSON.stringify({ args: e.args, result: e.result }));
    }
    // Bound a long-lived follower's memory; retain the most recent event IDs.
    if (seen.size > 10000) for (const id of [...seen].slice(0, seen.size - 10000)) seen.delete(id);
  };
  emit();
  if (!options.follow) return;
  const timer = setInterval(() => { try { emit(); } catch (error) { console.error(error.message); } }, 1000);
  const stop = () => { clearInterval(timer); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  return stop;
}
module.exports = { runTraceCommand };
