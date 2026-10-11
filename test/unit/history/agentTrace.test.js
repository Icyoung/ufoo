"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readAgentTrace, readAgentPerformance } = require("../../../src/coordination/history/agentTrace");

describe("read-only agent trace", () => {
  let root;
  const time = second => `2026-10-10T00:00:${String(second).padStart(2, "0")}.000Z`;
  function write(file, values) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, values.map(value => JSON.stringify(value)).join("\n") + "\n");
    return target;
  }
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-trace-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  test("metrics retain full lifecycles across trace pagination and time bounds, including identical timestamps", () => {
    write(".ufoo/agent/main/runtimes/main/events.jsonl", [
      { eventId: "z-start", sequence: 1, time: time(1), type: "task.started", taskRunId: "run", agentId: "ufoo-agent" },
      { eventId: "a-config", sequence: 2, time: time(1), type: "run.config", taskRunId: "run", agentId: "ufoo-agent", configuration: { model: "test", provider: "custom" } },
      { eventId: "b-delta", sequence: 3, time: time(2), type: "message.delta", taskRunId: "run", agentId: "ufoo-agent", text: "完成" },
      { eventId: "a-end", sequence: 4, time: time(9), type: "task.completed", taskRunId: "run", agentId: "ufoo-agent", result: { text: "已完成测试" } },
      { eventId: "z-second", sequence: 5, time: time(9), type: "task.started", taskRunId: "same-time", agentId: "ufoo-agent" },
      { eventId: "a-second", sequence: 6, time: time(9), type: "task.completed", taskRunId: "same-time", agentId: "ufoo-agent" },
    ]);
    const report = readAgentPerformance(root, { since: time(1), until: time(3), model: "test" });
    expect(report.summary.runs).toBe(1);
    expect(report.runs[0]).toMatchObject({ finalTextCharacters: 5, streamedCharacters: 2, timings: { elapsedMs: 8000, firstTextMs: 1000 } });
    expect(report.incomplete).toBe(false);
    expect(readAgentTrace(root, { limit: 1 }).performance.summary.runs).toBe(2);
    expect(readAgentPerformance(root).runs.find(r => r.taskRunId === "same-time")).toMatchObject({ status: "completed", timings: { elapsedMs: 0 } });
  });
  function fixture() {
    const first = { taskId: "child-1", workerId: "codex:first", parentTaskRunId: "parent", traceId: "parent", status: "queued", commandIds: ["dispatch-1"] };
    const second = { taskId: "child-2", workerId: "codex:second", parentTaskRunId: "parent", traceId: "parent", status: "running" };
    write(".ufoo/agent/main-control/runtimes/control/events.jsonl", [
      { eventId: "state-1", type: "capability.state_committed", capabilityId: "agent-management", time: time(1), value: { tasks: { "child-1": first, "child-2": second } } },
      { eventId: "dispatch-1", type: "command.resolved", commandId: "dispatch-1", time: time(2), result: { ok: true, seq: 10 } },
      { eventId: "state-2", type: "capability.state_committed", capabilityId: "agent-management", time: time(8), value: { tasks: { "child-1": { ...first, status: "accepted", report: { entry_id: "done", phase: "done", summary: "verified" }, acceptance: { evidence: ["test"] } }, "child-2": second } } },
    ]);
    write(".ufoo/agent/main/runtimes/main/events.jsonl", [
      { eventId: "parent-start", type: "task.started", time: time(0), taskRunId: "parent", agentId: "ufoo-agent", sessionId: "main" },
      { eventId: "model", type: "model.started", time: time(1), taskRunId: "parent", agentId: "ufoo-agent", provider: "codex", model: "test", estimatedInputTokens: 120 },
      { eventId: "compacted", type: "context.compaction.completed", time: time(7), taskRunId: "parent", agentId: "ufoo-agent", coveredCount: 30, batchCount: 10, durationMs: 25, usage: { input: 100, output: 12 } },
    ]);
    write(".ufoo/bus/events/2026-10-10.jsonl", [
      { seq: 10, event: "message", timestamp: time(2), publisher: "ufoo-agent", target: "codex:first", data: { task_id: "child-1", message: "fix parser", runtime_context: { traceId: "parent", parentTaskRunId: "parent" } } },
      ...[{ type: "task_started" }, { type: "tool_call", toolCallId: "patch", name: "apply_patch", args: { path: "source.js", api_key: "secret-long-value" } }, { type: "tool_result", toolCallId: "patch", status: "completed", output: "fixed", is_error: false }, { type: "task_completed" }].map((surface, index) => ({ seq: 11 + index, event: "agent_surface", timestamp: time(3 + index), publisher: "codex:first", data: { surface: { task_id: "child-1", taskRunId: "worker-1", parentTaskRunId: "parent", ...surface } } })),
      { seq: 18, event: "agent_surface", timestamp: time(4), publisher: "codex:second", data: { surface: { type: "tool_call", task_id: "child-2", taskRunId: "worker-2", toolCallId: "other", name: "bash" } } },
    ]);
    write(".ufoo/agent/reports.jsonl", [{ entry_id: "done", ts: time(7), task_id: "child-1", agent_id: "codex:first", phase: "done", scope: "private", summary: "verified" }]);
    write(".ufoo/bus/queues/codex:second/pending.jsonl", [{ seq: 20, target: "codex:second", data: { task_id: "child-2" } }]);
    write(".ufoo/bus/queues/codex:first/processing-test.jsonl", [{ seq: 10, target: "codex:first", data: { task_id: "child-1" } }]);
    write(".ufoo/agent/all-agents.json", [{ agents: { "codex:first": { nickname: "first" } } }]);
  }
  test("links parent, exact child, commands, reports, tool pairs and claimed queue without including a sibling", () => {
    fixture();
    const result = readAgentTrace(root, { task_id: "child-1", details: true });
    expect(result.incomplete).toBe(false);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe("accepted");
    expect(result.events.some(e => e.type === "command.resolved")).toBe(true);
    expect(result.events.some(e => e.type === "context.compaction.completed" && e.batchCount === 10)).toBe(true);
    expect(result.events.every(e => e.taskId !== "child-2" && e.agentId !== "codex:second")).toBe(true);
    expect(result.tools).toEqual([expect.objectContaining({ toolCallId: "patch", started: true, ended: true, outcome: "ok", durationMs: 1000 })]);
    expect(result.counts).toMatchObject({ modelCalls: 1, toolCalls: 1, unresolvedTools: 0, compactions: 1 });
    expect(result.queues).toEqual([expect.objectContaining({ taskId: "child-1", state: "claimed" })]);
    expect(JSON.stringify(result)).not.toContain("secret-long-value");
    expect(result.events.find(e => e.type === "tool.started").args.api_key).toBe("[REDACTED]");
    expect(readAgentTrace(root, { task_id: "parent" }).tasks).toHaveLength(2);
    expect(readAgentTrace(root, { agent_id: "first" }).events.every(e => e.agentId === "codex:first")).toBe(true);
  });
  test("returns stable latest pages and explicit oldest-first offsets; summaries omit full arguments", () => {
    fixture();
    const all = readAgentTrace(root, { limit: 2000 });
    const latest = readAgentTrace(root, { limit: 3 });
    expect(latest.events.map(e => e.id)).toEqual(all.events.slice(-3).map(e => e.id));
    expect(latest.has_more_before).toBe(true);
    const first = readAgentTrace(root, { limit: 3, offset: 0 });
    expect(first.next_offset).toBe(3);
    expect(first.events.map(e => e.id)).toEqual(all.events.slice(0, 3).map(e => e.id));
    expect(all.events.find(e => e.type === "tool.started")).not.toHaveProperty("args");
    expect(readAgentTrace(root, { session_id: "main" }).events.every(e => e.sessionId === "main")).toBe(true);
    expect(() => readAgentTrace(root, { since: "invalid" })).toThrow("ISO timestamp");
  });
  test("never mutates missing projects or repairs torn logs; explicitly reports partial source data", () => {
    expect(readAgentTrace(root).events).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
    const file = write(".ufoo/agent/main/runtimes/main/events.jsonl", [{ type: "task.started", eventId: "start", time: time(1), taskRunId: "main" }]);
    fs.appendFileSync(file, '{"type":"task.completed"');
    const before = fs.readFileSync(file, "utf8");
    const result = readAgentTrace(root);
    expect(result.incomplete).toBe(true);
    expect(result.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "incomplete_record" })]));
    expect(result.events.map(e => e.type)).toEqual(["task.started"]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(readAgentTrace(root, { maxReadBytes: 8 }).warnings.some(w => w.code === "source_tail_truncated")).toBe(true);
  });
  test("preserves explicit observation failures instead of presenting missing journals as complete evidence", () => {
    write(".ufoo/bus/events/2026-10-10.jsonl", [{ seq: 1, event: "agent_surface", timestamp: time(1), publisher: "ucode:one", data: { surface: { type: "runtime_event", task_id: "child", event: { type: "observation.warning", warning: { code: "observation_unavailable" } } } } }]);
    const result = readAgentTrace(root);
    expect(result.incomplete).toBe(true);
    expect(result.warnings[0].code).toBe("observation_unavailable");
  });
  test("metrics carry tool pairing warnings from the same trace evidence", () => {
    write(".ufoo/agent/main/runtimes/main/events.jsonl", [
      { type: "task.started", time: time(1), taskRunId: "run" },
      { type: "tool.started", time: time(2), taskRunId: "run", toolName: "read" },
      { type: "task.completed", time: time(3), taskRunId: "run" },
    ]);
    expect(readAgentPerformance(root)).toMatchObject({ incomplete: true,
      warnings: expect.arrayContaining([expect.objectContaining({ code: "missing_tool_call_id" })]) });
  });
  test("counts exposed SDK turns separately and treats nonzero command exits as tool errors", () => {
    write(".ufoo/bus/events/2026-10-10.jsonl", [
      ...[{ type: "turn_started" }, { type: "tool_call", toolCallId: "bash-1", name: "bash" }, { type: "tool_result", toolCallId: "bash-1", exitCode: 1, status: "completed" }, { type: "turn_completed" }].map((surface, index) => ({ seq: index + 1, event: "agent_surface", timestamp: time(index + 1), publisher: "codex:one", data: { surface: { task_id: "child", taskRunId: "run", ...surface } } })),
    ]);
    const result = readAgentTrace(root);
    expect(result.counts).toMatchObject({ modelCalls: 0, sdkTurns: 1, toolErrors: 1, unresolvedTools: 0 });
    expect(result.tools[0].outcome).toBe("error");
  });
  test("uses the native canonical journal once and preserves live observations when the journal is unavailable", () => {
    const native = { eventId: "native-1", type: "tool.started", time: time(2), taskId: "child", taskRunId: "native-run", parentTaskRunId: "worker-run", toolCallId: "call", toolName: "read", agentId: "ucode:one" };
    const file = write(".ufoo/agent/ucode/runtimes/session/events.jsonl", [native]);
    write(".ufoo/bus/events/2026-10-10.jsonl", [{ seq: 1, event: "agent_surface", timestamp: time(2), publisher: "ucode:one", data: { surface: { type: "runtime_event", task_id: "child", taskRunId: "worker-run", event: native } } },
      { seq: 2, event: "agent_surface", timestamp: time(2), publisher: "ucode:one", data: { surface: { type: "tool_call", task_id: "child", taskRunId: "worker-run", toolCallId: "call", name: "read" } } }]);
    expect(readAgentTrace(root).events.filter(e => e.type === "tool.started")).toHaveLength(1);
    fs.unlinkSync(file);
    expect(readAgentTrace(root).events.some(e => e.type === "tool.started" && e.toolCallId === "call")).toBe(true);
  });
});
