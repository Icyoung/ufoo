"use strict";

const { createAgentSurface } = require("../../../src/ui/agentSurface");

test("submit, execution phases, queue, interaction, failure and cancellation retain an honest status", () => {
  const view = createAgentSurface();
  view.accept({ type: "task_submitted", message: "first" });
  expect(view.snapshot()).toMatchObject({ busy: true, status: "Waiting for agent…" });
  view.accept({ type: "task_started", task_id: "one", message: "first" });
  const started = view.snapshot().started_at;
  view.accept({ type: "turn_started" });
  view.accept({ type: "phase", phase: { type: "request_start" } });
  expect(view.snapshot()).toMatchObject({ busy: true, status: "Waiting for model…", started_at: started });
  view.accept({ type: "thinking_delta", delta: "thinking" });
  expect(view.snapshot().status).toBe("Thinking…");
  view.accept({ type: "tool_call", name: "Read", toolCallId: "read", args: { file_path: "a.js" } });
  expect(view.snapshot().status).toBe("Reading file…");
  view.accept({ type: "task_submitted", message: "next" });
  expect(view.snapshot().status).toContain("queued 1");
  view.accept({ type: "task_completed" });
  expect(view.snapshot()).toMatchObject({ busy: true, status: "Waiting for agent…" });
  view.accept({ type: "task_started", task_id: "two", message: "next" });
  view.accept({ type: "context_usage", meter: { label: "12K / 200K" } });
  view.accept({ type: "interaction", lines: ["Pick one"] });
  view.accept({ type: "task_completed", usage: { input_tokens: 12000 } });
  expect(view.snapshot()).toMatchObject({ busy: false, status: "Waiting for reply…", usage: "12K / 200K" });
  view.accept({ type: "task_submitted", message: "1" });
  view.accept({ type: "task_started", task_id: "three", message: "1" });
  view.accept({ type: "task_failed", error: "request failed" });
  expect(view.snapshot()).toMatchObject({ busy: false, status: "error" });
  view.accept({ type: "task_started", task_id: "four" });
  view.accept({ type: "task_cancelled" });
  expect(view.snapshot()).toMatchObject({ busy: false, status: "cancelled" });
});

test("legacy activity can finish work while stale idle cannot clear a newly submitted task", () => {
  const view = createAgentSurface();
  view.accept({ type: "task_submitted", message: "work" });
  view.accept({ type: "activity", state: "idle", authoritative: true, ts: "2020-01-01" });
  expect(view.snapshot().busy).toBe(true);
  view.accept({ type: "activity", state: "working", detail: "thinking", authoritative: true });
  expect(view.snapshot().status).toBe("Thinking…");
  view.accept({ type: "activity", state: "working", detail: "tool bash", authoritative: true });
  expect(view.snapshot().status).toBe("Running command…");
  view.accept({ type: "activity", state: "idle", authoritative: true });
  expect(view.snapshot()).toMatchObject({ busy: false, status: "ready" });
});

test("compaction, retries, authentication, plan and background tasks share the status surface", () => {
  const view = createAgentSurface();
  for (const [type, status] of [["compacting", "Compacting context…"], ["retry", "Retrying request (2/3)…"], ["authenticating", "Authenticating…"], ["cancelling", "cancelling…"]]) {
    view.accept({ type: "phase", phase: { type, attempt: 2, max_retries: 3 } });
    expect(view.snapshot()).toMatchObject({ busy: true, status });
  }
  view.accept({ type: "tool_call", name: "TodoWrite", args: { todos: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }] } });
  expect(view.snapshot().plan).toEqual(["✓ Read", "→ Fix"]);
  view.accept({ type: "background_task", task_id: "bg", status: "running" });
  view.accept({ type: "background_task", task_id: "bg", status: undefined, description: "progress" });
  expect(view.snapshot().status).toContain("BG 1 running");
  view.accept({ type: "background_task", task_id: "bg", status: "completed" });
  expect(view.snapshot().status).toContain("BG 1 done");
});

test("live text, thinking and tool output stay ordered and tool IDs can repeat across tasks", () => {
  const view = createAgentSurface();
  view.accept({ type: "task_started", task_id: "one", message: "work" });
  view.accept({ type: "thinking_delta", delta: "considering" });
  view.accept({ type: "text_delta", delta: "before" });
  view.accept({ type: "tool_call", toolCallId: "1", name: "bash", args: { command: "npm test" } });
  view.accept({ type: "tool_result", toolCallId: "1", output: "first\n" });
  view.accept({ type: "tool_result", toolCallId: "1", output: "second\n", exitCode: 0 });
  view.accept({ type: "text_delta", delta: "after" });
  expect(view.snapshot()).toMatchObject({ busy: true, status: "Generating response…" });
  expect(view.snapshot().entries.map((row) => row.kind)).toEqual(["user", "thinking", "assistant", "tool", "assistant"]);
  expect(view.snapshot().entries[3].detail).toContain("first\nsecond\n");
  view.accept({ type: "task_completed", usage: { input_tokens: 5, output_tokens: 9 } });
  expect(view.snapshot()).toMatchObject({ busy: false, usage: "5 in · 9 out" });
  view.accept({ type: "task_started", task_id: "two", message: "another" });
  view.accept({ type: "tool_call", toolCallId: "1", name: "read", args: { path: "a.js" } });
  view.accept({ type: "tool_result", toolCallId: "1", output: "file contents" });
  expect(view.snapshot().entries.filter((row) => row.kind === "tool")).toHaveLength(2);
  expect(view.snapshot().entries[3].detail).toContain("first\nsecond\n");
  view.toggleExpanded();
  expect(view.snapshot().entries.at(-1).expanded).toBe(true);
});

test("local input is echoed once; stale activity does not erase live/waiting status", () => {
  const view = createAgentSurface();
  view.apply("transcript.append", { kind: "user", text: "hello" });
  view.accept({ type: "task_started", task_id: "one", message: "hello" });
  view.accept({ type: "text_delta", delta: "literal \\n code" });
  view.accept({ type: "activity", state: "ready" });
  expect(view.snapshot().busy).toBe(true);
  expect(view.snapshot().entries.filter((row) => row.kind === "user")).toHaveLength(1);
  expect(view.snapshot().entries.at(-1).text).toBe("literal \\n code");
  view.accept({ type: "interaction", lines: ["Choose a path"] });
  view.accept({ type: "task_completed" });
  view.accept({ type: "activity", state: "ready" });
  expect(view.snapshot()).toMatchObject({ busy: false, status: "Waiting for reply…" });
});

test("bounded state evicts old output and keeps native tool stdout readable", () => {
  const view = createAgentSurface({ maxEntries: 3, maxText: 80000 });
  for (let n = 0; n < 5; n++) {
    view.accept({ type: "task_started", task_id: `task-${n}`, message: "hello" });
    view.accept({ type: "tool_call", toolCallId: "1", name: "bash", args: { command: "ls" } });
    view.accept({ type: "tool_result", toolCallId: "1", output: { stdout: "a.js\nb.js", stderr: "error" }, is_error: true });
    view.accept({ type: "text_delta", delta: "x".repeat(100000) });
  }
  expect(view.snapshot().entries).toHaveLength(3);
  expect(view.snapshot().entries.at(-1).text).toHaveLength(64000);
  const tool = view.snapshot().entries.find((row) => row.kind === "tool");
  expect(tool.detail).toContain("a.js\nb.js\nerror");
  expect(tool.text).toContain("Failed");
});
