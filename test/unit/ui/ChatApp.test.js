"use strict";

/**
 * Lightweight, framework-free coverage for ChatApp. Mirrors the UcodeApp
 * test approach: we don't render with ink-testing-library because jest
 * runs in CJS mode and ink is ESM-only — that path would force
 * --experimental-vm-modules on the whole suite. Real TTY render coverage is
 * handled manually; component behaviour is pinned with focused unit tests.
 */

const path = require("path");

const {
  createChatApp,
  createChatStatusLine,
  createInternalStatusLine,
  createInkStreamState,
  createThrottledSender,
  decorateStaticLogEntry,
  buildChatLogDisplayLines,
  bootstrapEnvironment,
  buildInternalLogRows,
  buildDirectBusSendRequest,
  buildPromptIpcRequest,
  chatHistoryOptionsForScope,
  classifyChatLogLine,
  buildChatLogLineModel,
  buildChatLogGroups,
  computeStatusText,
  computeInternalStatusText,
  createInkMultiWindowToggle,
  inferStatusType,
  isAnimatedStatusType,
  isInternalViewingAgent,
  resolveInternalAgentBarIndex,
  resolveActiveAgentId,
  resolveInjectSockPathForAgent,
  resolveAgentEnterRequest,
  resolveDashboardAgentEnterAction,
  buildEmptyProjectsDownActions,
  resolveInternalKeyName,
  applyInternalAgentTermWrite,
  appendInternalErrorToView,
  staticChatLogItemGapPlan,
} = require("../../../src/ui/ink/ChatApp");

describe("createChatApp", () => {
  test("returns a render function for stub React + ink", () => {
    const React = require("react");
    const ink = {
      Box: () => null,
      Text: () => null,
      Static: () => null,
      useInput: () => undefined,
      useApp: () => ({ exit: () => {} }),
      useStdout: () => ({ stdout: null }),
    };
    const props = {
      activeProjectRoot: "/tmp/ufoo-test",
      globalMode: false,
    };
    const ChatApp = createChatApp({ React, ink, props, interactive: false });
    expect(typeof ChatApp).toBe("function");
  });
});

describe("chat status line", () => {
  test("done and error statuses render static indicators", () => {
    expect(computeStatusText({ message: "Done", type: "done" }, 0)).toBe("✓ Done");
    expect(computeStatusText({ message: "✓ Done", type: "done" }, 4)).toBe("✓ Done");
    expect(computeStatusText({ message: "✓ Done", type: "typing" }, 4)).toBe("✓ Done");
    expect(computeStatusText({ message: "r2 tc3 tok1200 done", type: "typing" }, 4))
      .toBe("✓ r2 tc3 tok1200 done");
    expect(computeStatusText({ message: "failed", type: "error" }, 2)).toBe("✗ failed");
  });

  test("status type inference keeps completed statuses non-animated", () => {
    expect(inferStatusType("✓ Done", "typing")).toBe("done");
    expect(inferStatusType("Bus message processed", "typing")).toBe("done");
    expect(inferStatusType("r2 tc3 tok1200 done", "typing")).toBe("done");
    expect(isAnimatedStatusType("done")).toBe(false);
    expect(isAnimatedStatusType("typing")).toBe(true);
  });

  test("terminal resolve statuses stay static via the none type", () => {
    // Replies like "← Launched 1 kimi agent(s)" must not animate forever.
    expect(inferStatusType("← Launched 1 kimi agent(s)", "none")).toBe("none");
    expect(isAnimatedStatusType("none")).toBe(false);
    expect(computeStatusText({ message: "← Launched 1 kimi agent(s)", type: "none" }, 3))
      .toBe("← Launched 1 kimi agent(s)");
  });
});

describe("chat log display classification", () => {
  test("classifies speaker, success, error, and divider rows", () => {
    expect(classifyChatLogLine("ufoo · 已交给 qa")).toMatchObject({
      kind: "assistant",
      speaker: "ufoo",
      body: "已交给 qa",
    });
    expect(classifyChatLogLine("codex-1 · done")).toMatchObject({
      kind: "agent",
      speaker: "codex-1",
      body: "done",
    });
    expect(classifyChatLogLine("Error: boom")).toMatchObject({ kind: "error", speaker: "error", body: "boom" });
    expect(classifyChatLogLine("✓ Done")).toMatchObject({ kind: "success", body: "Done" });
    expect(classifyChatLogLine("─── history ───")).toMatchObject({ kind: "divider" });
  });

  test("classifies ucode-style user prompts", () => {
    expect(classifyChatLogLine("› ship it")).toMatchObject({
      kind: "user",
      marker: "›",
      body: "ship it",
    });
    expect(buildChatLogLineModel("ship it", { sourceType: "user" })).toMatchObject({
      kind: "user",
      markerText: "› ",
      bodyText: "ship it",
    });
    expect(buildChatLogLineModel("› @qa check status", { sourceType: "user" })).toMatchObject({
      kind: "user",
      bodyText: "@qa check status",
    });
  });

  test("sourceType maps reply/bus/report/system roles", () => {
    expect(buildChatLogLineModel("ufoo · launched", { sourceType: "reply" })).toMatchObject({
      kind: "assistant",
      marker: "◆",
      speaker: "ufoo",
    });
    expect(buildChatLogLineModel("qa · done", { sourceType: "bus" })).toMatchObject({
      kind: "agent",
      marker: "◇",
      speaker: "qa",
    });
    expect(buildChatLogLineModel("qa · task finished", {
      sourceType: "report",
      meta: { event: "controller_report" },
    })).toMatchObject({
      kind: "report",
      marker: "●",
      speaker: "qa",
      bodyText: "task finished",
    });
    expect(buildChatLogLineModel("No active agents", { sourceType: "system" })).toMatchObject({
      kind: "system",
      marker: " ",
      markerText: "  ",
    });
    expect(buildChatLogLineModel("  • provider: anthropic", { sourceType: "system" })).toMatchObject({
      kind: "plain",
      marker: "",
      bodyText: expect.stringContaining("provider: anthropic"),
    });
    const configGroup = buildChatLogGroups([
      { id: "a", text: "✓ ucode config updated (global)", sourceType: "system" },
      { id: "b", text: "  • provider: anthropic", sourceType: "system" },
      { id: "c", text: "  • model: kimi-k3", sourceType: "system" },
    ]);
    expect(configGroup).toHaveLength(1);
    expect(configGroup[0]).toMatchObject({
      kind: "success",
      entries: [
        { continuation: false, row: { kind: "success" } },
        { continuation: true, row: { kind: "plain" } },
        { continuation: true, row: { kind: "plain" } },
      ],
    });
  });

  test("classifies chat banner rows with metadata as banner lines", () => {
    const line = "  █ █ █▀▀ █▀█ █▀█  Version: 2.4.7";
    expect(classifyChatLogLine(line)).toMatchObject({
      kind: "banner",
      body: line,
    });
    expect(buildChatLogLineModel(line)).toMatchObject({
      markerText: "  ",
      bodyText: line,
    });
  });

  test("speaker rows reserve a visible gap after marker and wrap from speaker edge", () => {
    expect(buildChatLogLineModel("builder- · hello")).toMatchObject({
      markerText: "◇  ",
      speaker: "builder-",
      bodyText: "hello",
    });
  });

  test("agent and assistant bodies render shared markdown ansi", () => {
    const row = buildChatLogLineModel("ufoo · use **bold** and `code`");
    expect(row).toMatchObject({
      kind: "assistant",
      speaker: "ufoo",
    });
    expect(row.bodyText).toContain("bold");
    expect(row.bodyText).toContain("code");
    expect(row.bodyText).not.toContain("**bold**");
    expect(row.bodyText).not.toContain("`code`");

    const state = { inCodeBlock: false };
    const open = buildChatLogLineModel("codex · ```js", { markdownState: state });
    expect(state.inCodeBlock).toBe(true);
    expect(open.bodyText).toContain("code");
    const body = buildChatLogLineModel("const x = 1", { markdownState: state });
    expect(state.inCodeBlock).toBe(true);
    expect(body.bodyText).toContain("const x = 1");
    const close = buildChatLogLineModel("```", { markdownState: state });
    expect(state.inCodeBlock).toBe(false);
    expect(close.bodyText).toContain("└");
  });

  test("user and system bodies skip markdown", () => {
    expect(buildChatLogLineModel("› use **bold**", { sourceType: "user" }).bodyText)
      .toContain("**bold**");
    expect(buildChatLogLineModel("note **x**", { sourceType: "system" }).bodyText)
      .toContain("**x**");
  });

  test("subscriber-id speaker rows and continuations avoid the plain gutter", () => {
    expect(buildChatLogLineModel("claude-code:221e94 · Handoff")).toMatchObject({
      kind: "agent",
      markerText: "◇  ",
      speaker: "claude-code:221e94",
      bodyText: "Handoff",
    });

    expect(buildChatLogLineModel("                    Current state:")).toMatchObject({
      kind: "plain",
      marker: "",
      markerText: "  ",
      bodyText: "Current state:",
    });
  });

  test("groups speaker messages with continuation lines into transcript cells", () => {
    const groups = buildChatLogGroups([
      { id: "a", text: "claude-code:221e94 · Handoff", sourceType: "bus" },
      { id: "b", text: "" },
      { id: "c", text: "                    Current state:", sourceType: "bus" },
      { id: "d", text: "                    • Reviewed docs", sourceType: "bus" },
      { id: "e", text: "✓ Message delivered" },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      kind: "agent",
      entries: [
        { continuation: false, row: { speaker: "claude-code:221e94", bodyText: "Handoff" } },
        { continuation: true, row: { kind: "spacer" } },
        { continuation: true, row: { kind: "plain", bodyText: "Current state:" } },
        { continuation: true, row: { kind: "plain", bodyText: "• Reviewed docs" } },
      ],
    });
    expect(groups[1]).toMatchObject({
      kind: "success",
      entries: [{ continuation: false, row: { bodyText: "Message delivered" } }],
    });
  });
});

describe("bootstrapEnvironment", () => {
  test("returns canonical project root and globalMode flag", () => {
    const env = bootstrapEnvironment("/tmp/ufoo-test", { globalMode: false });
    expect(env.globalMode).toBe(false);
    expect(typeof env.activeProjectRoot).toBe("string");
    expect(env.runtimePaths).toBeTruthy();
    // We don't assert needsBootstrap (depends on filesystem state) — the
    // important contract is that the helper is pure-of-side-effects and
    // hands back the runtime helpers it found.
    expect(typeof env.UfooInit).toBe("function");
    expect(typeof env.isRunning).toBe("function");
    expect(typeof env.startDaemon).toBe("function");
  });
});

describe("direct bus send helpers", () => {
  test("selected agent send uses daemon bus_send message field", () => {
    expect(buildDirectBusSendRequest({
      text: "测试文字 不要回复",
      targetAgentId: "codex:7",
    })).toEqual({
      target: "codex:7",
      message: "测试文字 不要回复",
      source: "chat-direct",
    });
  });

  test("manual @target message resolves nickname against active agents", () => {
    const meta = new Map([
      ["codex:8", { nickname: "codex-8" }],
    ]);
    expect(resolveActiveAgentId("codex-8", ["codex:8"], meta)).toBe("codex:8");
    expect(buildDirectBusSendRequest({
      text: "@codex-8 测试文字 不要回复",
      activeAgents: ["codex:8"],
      activeAgentMeta: meta,
    })).toEqual({
      target: "codex:8",
      message: "测试文字 不要回复",
      source: "chat-direct",
    });
  });
});

describe("multi-window helpers", () => {
  test("toggle enters and exits controller", () => {
    let active = false;
    const setActive = jest.fn((value) => { active = value; });
    const controller = {
      enter: jest.fn(() => { active = true; return true; }),
      exit: jest.fn(() => { active = false; }),
      isActive: jest.fn(() => active),
    };
    const toggle = createInkMultiWindowToggle({
      getController: () => controller,
      setActive,
      logMessage: jest.fn(),
    });

    expect(toggle()).toBe(true);
    expect(controller.enter).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith(true);

    expect(toggle()).toBe(true);
    expect(controller.exit).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith(false);
  });

  test("toggle logs unavailable when controller cannot be created", () => {
    const logMessage = jest.fn();
    const toggle = createInkMultiWindowToggle({
      getController: () => null,
      logMessage,
    });

    expect(toggle()).toBe(false);
    expect(logMessage).toHaveBeenCalledWith("error", "✗ Multi-window mode is not available");
  });

  test("inject socket path uses agent queue safe name", () => {
    const result = resolveInjectSockPathForAgent("/tmp/ufoo-project", "codex:abc");
    expect(result).toContain(path.join(".ufoo", "bus", "queues", "codex_abc", "inject.sock"));
  });
});

describe("agent enter request helpers", () => {
  test("internal queue agents enter through bus mode", () => {
    const request = resolveAgentEnterRequest({
      agentId: "codex:1",
      projectRoot: "/repo/project-a",
      activeAgentMeta: new Map([
        ["codex:1", { launch_mode: "internal", nickname: "codex-1" }],
      ]),
    });

    expect(request).toMatchObject({
      agentId: "codex:1",
      projectRoot: "/repo/project-a",
      launchMode: "internal",
      useBus: true,
      supportsInternalQueue: true,
      supportsSocket: false,
    });
  });

  test("internal pty agents keep socket mirror mode", () => {
    const request = resolveAgentEnterRequest({
      agentId: "codex:2",
      activeAgentMeta: new Map([
        ["codex:2", { launch_mode: "internal" }],
      ]),
    });

    expect(request).toMatchObject({
      launchMode: "internal",
      useBus: true,
      supportsInternalQueue: true,
      supportsSocket: false,
    });
  });

  test("terminal and tmux agents activate instead of entering mirror view", () => {
    for (const launchMode of ["terminal", "tmux"]) {
      const request = resolveAgentEnterRequest({
        agentId: "codex:2",
        activeAgentMeta: new Map([
          ["codex:2", { launch_mode: launchMode }],
        ]),
      });

      expect(request).toMatchObject({
        launchMode,
        useBus: false,
        supportsActivate: true,
      });
      expect(resolveDashboardAgentEnterAction(request)).toBe("activate");
    }
  });

  test("dashboard enter keeps internal agents in the chat window", () => {
    const request = resolveAgentEnterRequest({
      agentId: "codex:1",
      activeAgentMeta: new Map([
        ["codex:1", { launch_mode: "internal" }],
      ]),
    });

    expect(resolveDashboardAgentEnterAction(request)).toBe("internal");
  });
});

describe("dashboard navigation helpers", () => {
  test("empty global Projects absorbs first Down and second Down enters Agents", () => {
    expect(buildEmptyProjectsDownActions({
      emptyProjectsDownArmed: false,
      selectedAgentIndex: -1,
    }, ["codex:1"])).toEqual([
      { type: "projects/armEmptyDown" },
    ]);

    expect(buildEmptyProjectsDownActions({
      emptyProjectsDownArmed: true,
      selectedAgentIndex: -1,
    }, ["codex:1"])).toEqual([
      { type: "view/set", view: "agents" },
      { type: "agents/select", index: 0 },
    ]);
  });
});

describe("internal agent view helpers", () => {
  test("formats internal log rows with ucode-like prompt and markdown treatment", () => {
    const rows = buildInternalLogRows([
      "ufoo internal agent · codex-7",
      "agent: codex:7",
      "",
      "> run build",
      "* # Done",
      "* - item one",
      "Error: failed",
    ], 24, 20);

    expect(rows.map((row) => row.text.trimEnd())).toEqual([
      "· ufoo internal agent ·",
      "  codex-7",
      "  agent: codex:7",
      "",
      "› run build",
      "Done",
      "• item one",
      "Error: failed",
    ]);
    expect(rows[0].bold).toBe(true);
    expect(rows[4].kind).toBe("user");
    expect(rows[7].kind).toBe("error");
  });

  test("computes internal status text with spinner and elapsed time", () => {
    const text = computeInternalStatusText({
      label: "codex-7",
      status: "working",
      detail: "Running command",
      statusStartedAt: 1000,
    }, 1, 3500);

    expect(text).toContain("codex-7 · Working · Running command");
    expect(text).toContain("(2 s)");
    expect(text).toContain("Esc back");
  });

  test("marks internal stream ready on done-only frame", () => {
    const current = {
      agentId: "codex:7",
      label: "codex-7",
      lines: ["answer"],
      status: "working",
      detail: "",
      statusStartedAt: 1000,
    };

    const next = applyInternalAgentTermWrite(current, "codex:7", "", {
      done: true,
      streamPayload: { stream: true, done: true, reason: "end" },
    });

    expect(next.status).toBe("ready");
    expect(next.statusStartedAt).toBe(0);
    expect(next.lines).toEqual(["answer"]);
  });

  test("appends daemon errors into the active internal view", () => {
    const current = {
      agentId: "codex:7",
      label: "codex-7",
      lines: ["prompt"],
      status: "working",
      detail: "",
      statusStartedAt: 1000,
    };

    const next = appendInternalErrorToView(current, "codex:7", "bus_send rejected");

    expect(next.status).toBe("blocked");
    expect(next.detail).toBe("bus_send rejected");
    expect(next.lines).toContain("Error: bus_send rejected");
  });

  test("normalizes terminal delete/backspace key sequences", () => {
    expect(resolveInternalKeyName("\x7f", {})).toBe("backspace");
    expect(resolveInternalKeyName("\b", {})).toBe("backspace");
    expect(resolveInternalKeyName("\x1b[3~", {})).toBe("delete");
    expect(resolveInternalKeyName("", { backspace: true })).toBe("backspace");
    expect(resolveInternalKeyName("", { delete: true })).toBe("backspace");
    expect(resolveInternalKeyName("", { name: "delete" })).toBe("backspace");
    expect(resolveInternalKeyName("\x1b[3~", { name: "delete", delete: true })).toBe("delete");
  });

  test("matches current internal agent through aliases and refreshed metadata", () => {
    const view = {
      agentId: "codex:7",
      label: "codex-7",
      aliases: ["codex:7", "codex-7"],
    };
    expect(isInternalViewingAgent("codex:7", {}, view, "codex:7")).toBe(true);
    expect(isInternalViewingAgent("codex:xyz", { nickname: "codex-7" }, view, "codex:7")).toBe(true);
    expect(isInternalViewingAgent("codex:8", { nickname: "codex-8" }, view, "codex:7")).toBe(false);
  });

  test("down-arrow bar focus lands on the current agent, not ufoo", () => {
    const agents = ["ufoo-agent", "codex:architect", "codex:builder"];
    expect(resolveInternalAgentBarIndex(agents, {
      viewingAgentId: "codex:architect",
    })).toBe(2);
    expect(resolveInternalAgentBarIndex(agents, {
      viewingAgentId: "codex:builder",
    })).toBe(3);
    expect(resolveInternalAgentBarIndex(agents, {
      viewingAgentId: "",
    })).toBe(0);

    const meta = new Map([
      ["codex:xyz", { nickname: "architect" }],
    ]);
    expect(resolveInternalAgentBarIndex(["ufoo-agent", "codex:xyz"], {
      viewingAgentId: "codex:architect",
      view: { agentId: "codex:architect", aliases: ["architect"] },
      displayAgentMeta: meta,
    })).toBe(2);
  });
});

describe("prompt submit helpers", () => {
  test("plain controller prompt uses daemon text contract", () => {
    expect(buildPromptIpcRequest("hello controller")).toEqual({
      type: "prompt",
      text: "hello controller",
      request_meta: {
        source: "chat-dialog",
        dispatch_default_injection_mode: "immediate",
        allow_relevance_queue: true,
      },
    });
  });
});

describe("chat history scope helpers", () => {
  test("global project scope writes project-local history", () => {
    expect(chatHistoryOptionsForScope({ globalMode: true, globalScope: "project" })).toEqual({
      globalMode: false,
    });
    expect(chatHistoryOptionsForScope({ globalMode: true, globalScope: "controller" })).toEqual({
      globalMode: true,
    });
  });
});

describe("status line components", () => {
  test("factories return render functions for stub React + ink", () => {
    const React = require("react");
    const ink = {
      Box: () => null,
      Text: () => null,
    };
    expect(typeof createChatStatusLine({ React, ink })).toBe("function");
    expect(typeof createInternalStatusLine({ React, ink })).toBe("function");
  });
});

describe("stream delta batching", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("deltas accumulate and flush as a single dispatch per window", () => {
    jest.useFakeTimers();
    const dispatched = [];
    const history = [];
    const streamState = createInkStreamState({
      dispatch: (action) => dispatched.push(action),
      appendHistory: (kind, text) => history.push(text),
      displayNameForPublisher: (value) => value,
      flushIntervalMs: 50,
    });

    const stream = streamState.beginStream("codex:1", "codex-1", "", {});
    expect(dispatched).toEqual([{ type: "stream/begin", publisher: "codex-1" }]);

    streamState.appendStreamDelta(stream, "Hello, ");
    streamState.appendStreamDelta(stream, "world");
    streamState.appendStreamDelta(stream, "!");
    // Batched: nothing dispatched until the flush window elapses.
    expect(dispatched).toHaveLength(1);

    jest.advanceTimersByTime(60);
    expect(dispatched).toHaveLength(2);
    expect(dispatched[1]).toEqual({
      type: "stream/delta",
      publisher: "codex-1",
      delta: "Hello, world!",
    });
    expect(streamState.hasStream("codex:1")).toBe(true);
  });

  test("finalizeStream flushes pending deltas before stream/end", () => {
    jest.useFakeTimers();
    const dispatched = [];
    const history = [];
    const streamState = createInkStreamState({
      dispatch: (action) => dispatched.push(action),
      appendHistory: (kind, text) => history.push(text),
      displayNameForPublisher: (value) => value,
      flushIntervalMs: 50,
    });

    const stream = streamState.beginStream("codex:1", "codex-1", "", {});
    streamState.appendStreamDelta(stream, "partial");
    streamState.finalizeStream("codex:1", {}, "end");

    expect(dispatched.map((action) => action.type)).toEqual([
      "stream/begin",
      "stream/delta",
      "stream/end",
    ]);
    expect(dispatched[1].delta).toBe("partial");
    expect(history).toEqual(["codex-1: partial"]);
    expect(streamState.hasStream("codex:1")).toBe(false);
  });
});

describe("daemon status request throttling", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("first call sends immediately, bursts coalesce into one trailing send", () => {
    jest.useFakeTimers();
    const send = jest.fn();
    const throttled = createThrottledSender(send, 500);

    throttled();
    expect(send).toHaveBeenCalledTimes(1);

    throttled();
    throttled();
    throttled();
    expect(send).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(2);

    // A call right after the trailing send starts a new window.
    throttled();
    expect(send).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(500);
    expect(send).toHaveBeenCalledTimes(3);
  });

  test("calls after a quiet window send immediately again", () => {
    jest.useFakeTimers();
    const send = jest.fn();
    const throttled = createThrottledSender(send, 500);

    throttled();
    jest.advanceTimersByTime(600);
    throttled();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("buildChatLogDisplayLines", () => {
  const { displayCellWidth } = require("../../../src/ui/format");

  test("pre-wraps CJK user rows so each physical line fits the terminal", () => {
    const row = buildChatLogLineModel({
      text: "启动一个cron 每半个小时给architect注入一遍他的使命",
      sourceType: "user",
    });
    const lines = buildChatLogDisplayLines(row, { cols: 24 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith("› ")).toBe(true);
    for (const line of lines) {
      expect(displayCellWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  test("keeps agent speaker on the first physical line only", () => {
    const row = buildChatLogLineModel({
      text: "architect · acknowledged, current D1 registry return regression check continues",
      sourceType: "bus",
    });
    const lines = buildChatLogDisplayLines(row, { cols: 36 });
    expect(lines[0]).toMatch(/^◇\s+architect · /);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/^\s+\S/);
    for (const line of lines) {
      expect(displayCellWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  test("continuation rows indent without a second speaker label", () => {
    const row = buildChatLogLineModel({ text: "  more detail about the change", sourceType: "bus" });
    const lines = buildChatLogDisplayLines(row, { continuation: true, groupKind: "agent", cols: 40 });
    expect(lines[0].startsWith("   ")).toBe(true);
    expect(lines[0]).not.toMatch(/·/);
  });
});

describe("static log decoration", () => {
  test("mirrors buildChatLogGroups grouping with append-only flags", () => {
    const lines = [
      { id: "l-1", text: "ufoo · 已交给 qa" },
      { id: "l-2", text: "  补充上下文" },
      { id: "l-3", text: "✓ Done" },
      { id: "l-4", text: "─── history ───" },
      { id: "l-5", text: "" },
    ];
    const decorated = [];
    for (const entry of lines) {
      decorated.push(decorateStaticLogEntry(decorated[decorated.length - 1] || null, entry));
    }

    // Group start: assistant message.
    expect(decorated[0]).toMatchObject({ continuation: false, groupKind: "assistant", marginBefore: false });
    // Plain line continues the assistant group — no gap inside the group.
    expect(decorated[1]).toMatchObject({ continuation: true, groupKind: "assistant", marginBefore: false });
    // Success starts a new group; previous group contributes the gap.
    expect(decorated[2]).toMatchObject({ continuation: false, groupKind: "success", marginBefore: true });
    // Divider is standalone but still follows a groupable group.
    expect(decorated[3]).toMatchObject({ continuation: false, groupKind: "divider", marginBefore: true });
    // Spacer after a divider: no gap (divider renders its own marginBottom).
    expect(decorated[4]).toMatchObject({ continuation: false, groupKind: "spacer", marginBefore: false });
  });

  test("decoration flags are stable once appended (Static-compatible)", () => {
    const first = decorateStaticLogEntry(null, { id: "l-1", text: "agent-1 · hi" });
    const second = decorateStaticLogEntry(first, { id: "l-2", text: "  more" });
    const secondAgain = decorateStaticLogEntry(first, { id: "l-2", text: "  more" });
    expect(secondAgain).toEqual(second);
  });

  test("static gaps are content rows so live appends keep history spacing", () => {
    const lines = [
      { id: "l-1", text: "reviewer · Final independent review", sourceType: "bus" },
      { id: "l-2", text: "architect · Reviewer wait state", sourceType: "bus" },
      { id: "l-3", text: "› 通知三个人 上报的时候用中文上报", sourceType: "user" },
      { id: "l-4", text: "architect · 已统一团队沟通语言", sourceType: "bus" },
    ];
    const decorated = [];
    for (const entry of lines) {
      decorated.push(decorateStaticLogEntry(decorated[decorated.length - 1] || null, entry));
    }

    expect(decorated.map((item) => item.groupKind)).toEqual([
      "agent",
      "agent",
      "user",
      "agent",
    ]);
    expect(staticChatLogItemGapPlan(decorated[0])).toEqual({ leading: false, trailing: false });
    expect(staticChatLogItemGapPlan(decorated[1])).toEqual({ leading: true, trailing: false });
    expect(staticChatLogItemGapPlan(decorated[2])).toEqual({ leading: true, trailing: true });
    expect(staticChatLogItemGapPlan(decorated[3])).toEqual({ leading: true, trailing: false });
  });
});
