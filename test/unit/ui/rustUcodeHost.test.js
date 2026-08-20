"use strict";

const {
  buildPlanSetPayload,
  normalizeToolLogEntry,
  splitUcodeBannerRow,
  createThinkingLogPublisher,
  createLeadingWhitespaceNormalizer,
  appendNaturalLanguageResult,
  buildUcodeAgentsSnapshot,
  buildUcodeCompletionItems,
} = require("../../../src/ui/rustUcodeHost");
const { createToolMergePublisher } = require("../../../src/ui/toolMergeBridge");

describe("rustUcodeHost helpers", () => {
  test("normalizeToolLogEntry maps tool log into merge entry", () => {
    const entry = normalizeToolLogEntry({
      tool: "bash",
      phase: "result",
      args: { command: "ls" },
      result: { ok: true, stdout: "a" },
    });
    expect(entry).toBeTruthy();
    expect(entry.tool).toBe("bash");
    expect(entry.isError).toBe(false);
  });

  test("normalizeToolLogEntry returns null without tool", () => {
    expect(normalizeToolLogEntry({})).toBeNull();
  });

  test("splitUcodeBannerRow preserves the literal logo for native styling", () => {
    expect(splitUcodeBannerRow(
      "█ █ █▀▀ █▀█ █▀▄ █▀▀  Model: test",
      0
    )).toEqual({
      logo: "█ █ █▀▀ █▀█ █▀▄ █▀▀",
      metadata: "Model: test",
    });
  });

  test("thinking publisher keeps deltas in one mutable log entry", () => {
    const events = [];
    const status = { onThinkingDelta: jest.fn(), reset: jest.fn() };
    const thinking = createThinkingLogPublisher(
      (name, payload) => events.push({ name, payload }),
      status,
      "stream-1"
    );

    thinking.onThinkingDelta("first ");
    thinking.onThinkingDelta("second");
    thinking.stop();

    expect(events).toEqual([
      { name: "thinking.start", payload: { id: "stream-1-thinking" } },
      { name: "thinking.delta", payload: { id: "stream-1-thinking", text: "first " } },
      { name: "thinking.delta", payload: { id: "stream-1-thinking", text: "second" } },
    ]);
    expect(status.onThinkingDelta).toHaveBeenCalledTimes(2);
    expect(status.reset).toHaveBeenCalledTimes(1);
  });

  test("leading whitespace normalizer suppresses blank stream rows", () => {
    const normalize = createLeadingWhitespaceNormalizer();
    expect(normalize("\n\n  ")).toBe("");
    expect(normalize("\n  hello")).toBe("hello");
    expect(normalize("\nworld")).toBe("\nworld");
  });

  test("streamed natural-language results are not appended a second time", () => {
    const appendLog = jest.fn();
    const format = jest.fn(() => "same streamed answer");
    expect(appendNaturalLanguageResult(
      { ok: true, streamed: true, summary: "same streamed answer" },
      format,
      appendLog
    )).toBe(false);
    expect(format).not.toHaveBeenCalled();
    expect(appendLog).not.toHaveBeenCalled();

    expect(appendNaturalLanguageResult(
      { ok: true, streamed: false, summary: "one answer" },
      () => "one answer",
      appendLog
    )).toBe(true);
    expect(appendLog).toHaveBeenCalledWith("one answer", "assistant");
  });

  test("buildPlanSetPayload tolerates empty execution state", () => {
    const payload = buildPlanSetPayload(null);
    expect(payload).toMatchObject({ summary: "", lines: [] });
  });

  test("buildUcodeAgentsSnapshot maps bus agents into footer snapshot", () => {
    const fmt = require("../../../src/ui/format");
    const originalLoad = fmt.loadActiveAgents;
    const originalFilter = fmt.filterSelectableAgents;
    fmt.loadActiveAgents = () => ([
      { fullId: "codex:a1", id: "a1", type: "codex", nickname: "alpha", status: "active" },
      { fullId: "claude:b2", id: "b2", type: "claude", nickname: "", status: "active" },
    ]);
    fmt.filterSelectableAgents = (agents) => agents;
    try {
      const snap = buildUcodeAgentsSnapshot("/tmp/ws", "");
      expect(snap.agents).toHaveLength(2);
      expect(snap.agents[0]).toMatchObject({ id: "codex:a1", label: "alpha" });
      expect(snap.footer).toContain("alpha");
      expect(snap.footer).toContain("claude:b2");
    } finally {
      fmt.loadActiveAgents = originalLoad;
      fmt.filterSelectableAgents = originalFilter;
    }
  });

  test("buildUcodeAgentsSnapshot empty list uses Agents: none", () => {
    const fmt = require("../../../src/ui/format");
    const originalLoad = fmt.loadActiveAgents;
    const originalFilter = fmt.filterSelectableAgents;
    fmt.loadActiveAgents = () => [];
    fmt.filterSelectableAgents = () => [];
    try {
      expect(buildUcodeAgentsSnapshot("/tmp/ws")).toEqual({
        agents: [],
        footer: "Agents: none",
      });
    } finally {
      fmt.loadActiveAgents = originalLoad;
      fmt.filterSelectableAgents = originalFilter;
    }
  });

  test("tool merge publisher collapses via shared bridge", () => {
    const events = [];
    const tools = createToolMergePublisher((name, payload) => events.push({ name, payload }));
    tools.beginScope();
    const a = normalizeToolLogEntry({ tool: "read", phase: "result", result: { ok: true } });
    const b = normalizeToolLogEntry({ tool: "bash", phase: "result", result: { ok: true } });
    tools.pushTool(a);
    tools.pushTool(b);
    tools.flush();
    expect(events.some((e) => e.name === "tool.group")).toBe(true);
  });

  test("buildUcodeCompletionItems includes @ agent matches", async () => {
    const fmt = require("../../../src/ui/format");
    const originalLoad = fmt.loadActiveAgents;
    const originalFilter = fmt.filterSelectableAgents;
    fmt.loadActiveAgents = () => ([
      { fullId: "codex:a1", id: "a1", nickname: "alpha", status: "active" },
      { fullId: "claude:b2", id: "b2", nickname: "bravo", status: "active" },
    ]);
    fmt.filterSelectableAgents = (agents) => agents;
    try {
      const items = await buildUcodeCompletionItems({
        text: "@al",
        workspaceRoot: "/tmp/ws",
      });
      expect(items.some((item) => item.kind === "agent" && item.label === "@alpha")).toBe(true);
    } finally {
      fmt.loadActiveAgents = originalLoad;
      fmt.filterSelectableAgents = originalFilter;
    }
  });

  test("buildUcodeCompletionItems prefers remote /model catalog", async () => {
    const items = await buildUcodeCompletionItems({
      text: "/model ",
      workspaceRoot: "/tmp/ws",
      state: { model: "gpt-4.1", provider: "openai" },
      remoteModels: ["gpt-4.1", "o3-mini", "custom-remote-model"],
    });
    const labels = items.map((item) => String(item.label || ""));
    expect(labels.some((label) => label.includes("custom-remote-model"))).toBe(true);
    expect(items.some((item) => /models route/i.test(String(item.description || "")))).toBe(true);
  });
});
