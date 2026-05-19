"use strict";

/**
 * Lightweight, framework-free coverage for ChatApp. Mirrors the UcodeApp
 * test approach: we don't render with ink-testing-library because jest
 * runs in CJS mode and ink is ESM-only — that path would force
 * --experimental-vm-modules on the whole suite. The full render path is
 * exercised by scripts/ucode-app-smoke.js plus real-TTY runs.
 */

const {
  createChatApp,
  bootstrapEnvironment,
  buildInternalLogRows,
  buildDirectBusSendRequest,
  buildPromptIpcRequest,
  chatHistoryOptionsForScope,
  computeInternalStatusText,
  isInternalViewingAgent,
  resolveActiveAgentId,
  resolveAgentEnterRequest,
  resolveInternalKeyName,
  applyInternalAgentTermWrite,
  appendInternalErrorToView,
} = require("../../../src/ui/components/ChatApp");

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

describe("bootstrapEnvironment", () => {
  test("returns canonical project root and globalMode flag", () => {
    const env = bootstrapEnvironment("/tmp/ufoo-test", { globalMode: false });
    expect(env.globalMode).toBe(false);
    expect(typeof env.activeProjectRoot).toBe("string");
    expect(env.runtimePaths).toBeTruthy();
    // We don't assert needsBootstrap (depends on filesystem state) — the
    // important contract is that the helper is pure-of-side-effects and
    // hands back the modules it found.
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
        ["codex:2", { launch_mode: "internal-pty" }],
      ]),
    });

    expect(request).toMatchObject({
      launchMode: "internal-pty",
      useBus: false,
      supportsInternalQueue: true,
      supportsSocket: true,
    });
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
      "# Done",
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
