"use strict";

const { createAgentSurface, projectSurfaceEvent } = require("../../../src/ui/agentSurface");

test("streaming and replay render split Markdown without changing source or user/tool text", () => {
  const view = createAgentSurface();
  const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");
  const first = projectSurfaceEvent(view, "stream.delta", { id: "answer", text: "现在 **Son" });
  expect(first.name).toBe("transcript.append");
  const second = projectSurfaceEvent(view, "stream.delta", { id: "answer", text: "arr 已启动**\n\n## 检查\n- **通过**" });
  expect(second.name).toBe("transcript.patch");
  expect(plain(second.payload.text)).toBe("现在 Sonarr 已启动\n\n检查\n- 通过");
  expect(second.payload.text).toContain("\x1b[1m");
  expect(view.snapshot().entries[0].text).toBe(second.payload.text);
  const replay = projectSurfaceEvent(view, "transcript.reset", { entries: [
    { id: "saved", kind: "assistant", text: "**恢复的回答**" },
    { id: "user", kind: "user", text: "**原始输入**" },
    { id: "tool", kind: "tool", text: "**原始输出**" },
  ] });
  expect(plain(replay.payload.entries[0].text)).toBe("恢复的回答");
  expect(replay.payload.entries[1].text).toBe("**原始输入**");
  expect(replay.payload.entries[2].text).toBe("**原始输出**");
});

test("stream Markdown retains fences across chunks and aligns whole tables", () => {
  const view = createAgentSurface();
  const plain = text => text.replace(/\x1b\[[0-9;]*m/g, "");
  for (const text of ["```md\n**literal**", "\n```\n\n| 项目 | 结果 |\n", "| --- | --- |\n| **检查** | 通过 |"])
    projectSurfaceEvent(view, "stream.delta", { id: "answer", text });
  const text = plain(view.snapshot().entries[0].text);
  expect(text).toContain("│ **literal**");
  expect(text).toContain("│ 检查");
  expect(text).not.toContain("**检查**");
  expect(text).toContain("┼");
});

test("formatting leaves identifiers with underscores readable", () => {
  const view = createAgentSurface();
  projectSurfaceEvent(view, "stream.delta", { id: "answer", text: "VISIBLE_BEFORE_DONE and config_file_name.json" });
  expect(view.snapshot().entries[0].text).toBe("VISIBLE_BEFORE_DONE and config_file_name.json");
});

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
  expect(view.snapshot().entries[3].detail).not.toContain("[exit 0]");
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
    view.accept({ type: "tool_result", toolCallId: "1", output: { stdout: "a.js\nb.js", stderr: "error" }, is_error: true, exitCode: 2 });
    view.accept({ type: "text_delta", delta: "x".repeat(100000) });
  }
  expect(view.snapshot().entries).toHaveLength(3);
  expect(view.snapshot().entries.at(-1).text).toHaveLength(64000);
  const tool = view.snapshot().entries.find((row) => row.kind === "tool");
  expect(tool.detail).toContain("a.js\nb.js\nerror");
  expect(tool.detail).toContain("[exit 2]");
  expect(tool.text).toContain("Failed");
});

test("rawMarkdown preserves raw Markdown, tracks tool_status lifecycle, and aggregates session changed_files", () => {
  const view = createAgentSurface({ rawMarkdown: true });
  view.accept({ type: "task_started", task_id: "t1", message: "review decisions" });
  view.accept({ type: "tool_call", toolCallId: "c1", name: "apply_patch", args: { path: "/repo/.ufoo/context/report.md" } });
  expect(view.snapshot().entries.find((e) => e.kind === "tool")).toMatchObject({
    tool_name: "apply_patch",
    tool_status: "running",
  });
  view.accept({
    type: "tool_result",
    toolCallId: "c1",
    status: "completed",
    output: { changes: [{ path: "/repo/.ufoo/context/report.md", kind: "add" }] },
  });
  expect(view.snapshot().entries.find((e) => e.kind === "tool")).toMatchObject({
    tool_status: "done",
  });
  view.accept({ type: "tool_call", toolCallId: "c2", name: "Edit", args: { file_path: "src/app.js" } });
  view.accept({ type: "tool_result", toolCallId: "c2", status: "completed", output: "ok" });
  view.accept({ type: "text_delta", delta: "**11 组**见[分析报告](/repo/.ufoo/context/report.md)" });
  view.accept({ type: "task_completed" });

  const snap = view.snapshot();
  const assistant = snap.entries.find((e) => e.kind === "assistant");
  const tools = snap.entries.filter((e) => e.kind === "tool");
  expect(assistant.text).toBe("**11 组**见[分析报告](/repo/.ufoo/context/report.md)");
  expect(assistant.text).not.toContain("\x1b[");
  expect(tools[0].changed_files).toEqual([
    { path: "/repo/.ufoo/context/report.md", kind: "added" },
  ]);
  expect(tools[1].changed_files).toEqual([
    { path: "src/app.js", kind: "modified" },
  ]);
  expect(snap.changed_files).toEqual([
    { path: "/repo/.ufoo/context/report.md", kind: "added" },
    { path: "src/app.js", kind: "modified" },
  ]);

  view.accept({ type: "surface_cleared" });
  const clearedSnap = view.snapshot();
  expect(clearedSnap.entries).toEqual([]);
  expect(clearedSnap.changed_files).toEqual([]);
  expect(clearedSnap.plan).toEqual([]);
  expect(clearedSnap.busy).toBe(false);
  expect(clearedSnap.status).toBe("ready");
});

test("classifies incoming peer, coordinator, and direct user senders and normalizes Codex/Claude tool rows", () => {
  const view = createAgentSurface({ rawMarkdown: true });

  // Direct user message (via desktop UI source)
  view.accept({
    type: "task_started",
    task_id: "t-user",
    publisher: "ufoo-agent",
    source: "ufoo-desktop-worker",
    requestKind: "bus-message",
    message: "Please audit startup latency",
  });
  // Peer agent message (e.g. reviewer -> architect)
  view.accept({
    type: "task_started",
    task_id: "t-peer",
    publisher: "codex:1670b65b",
    requestKind: "bus-message",
    message: "Independent review complete",
  });
  // Coordinator delegation (ufoo-agent -> worker)
  view.accept({
    type: "task_started",
    task_id: "t-coord",
    publisher: "ufoo-agent",
    requestKind: "worker-task",
    message: "Run tests in worktree",
  });

  // Codex shell-wrapped bash + MCP tool + Claude Grep/MCP tools
  view.accept({
    type: "tool_call",
    toolCallId: "bash1",
    name: "bash",
    args: { command: '/bin/zsh -lc "rg -n getSessionId shared/src"' },
  });
  view.accept({
    type: "tool_result",
    toolCallId: "bash1",
    output: "shared/src/Analytics.kt:12",
  });
  view.accept({
    type: "tool_call",
    toolCallId: "mcp1",
    name: "ufoo.dispatch_message",
    args: { target: "builder", message: "Please double-check B1" },
  });
  view.accept({
    type: "tool_call",
    toolCallId: "grep1",
    name: "Grep",
    args: { pattern: "HttpTimeout", path: "shared/src" },
  });
  view.accept({
    type: "tool_call",
    toolCallId: "cmcp1",
    name: "mcp__ufoo__report_agent_status",
    args: { phase: "done", summary: "Audit complete" },
  });

  const snap = view.snapshot();
  const users = snap.entries.filter((e) => e.kind === "user");
  expect(users[0]).toMatchObject({ sender_kind: "user" });
  expect(users[0].sender_id).toBeUndefined();
  expect(users[1]).toMatchObject({ sender_kind: "peer", sender_id: "codex:1670b65b" });
  expect(users[2]).toMatchObject({ sender_kind: "coordinator", sender_id: "ufoo-agent" });

  const tools = snap.entries.filter((e) => e.kind === "tool");
  expect(tools[0].text).toBe("• Bash rg -n getSessionId shared/src");
  expect(tools[0].detail).toContain("shared/src/Analytics.kt:12");
  expect(tools[1].text).toBe("• Send Message @builder · Please double-check B1");
  expect(tools[2].text).toBe("• Grep HttpTimeout · shared/src");
  expect(tools[3].text).toBe("• Report Status done · Audit complete");
});
