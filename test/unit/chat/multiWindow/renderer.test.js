"use strict";

const { createRenderer } = require("../../../../src/app/chat/multiWindow/renderer");
const { createVirtualTerminal } = require("../../../../src/app/chat/multiWindow/virtualTerminal");

function stripAnsi(text = "") {
  return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

describe("multiWindow renderer chat log", () => {
  test("renders subscriber speaker rows and continuations without a left gutter", () => {
    let written = "";
    const renderer = createRenderer({
      write: (chunk) => {
        written += chunk;
      },
    });

    renderer.renderChatLog(
      { top: 0, left: 0, width: 72, height: 2 },
      [
        "claude-code:221e94 · Handoff from Codex docs review/fix pass",
        "                    Current state:",
      ],
    );

    const visible = stripAnsi(written);
    expect(visible).toContain("● claude-code:221e94 · Handoff from Codex docs review/fix pass");
    expect(visible).toContain("  Current state:");
    expect(visible).not.toContain("│ claude-code:221e94");
    expect(visible).not.toContain("│ Current state:");
  });
});

describe("multiWindow renderer diffing", () => {
  const pane = { top: 0, left: 0, width: 20, height: 5 };

  function makeRenderer() {
    let written = "";
    const renderer = createRenderer({
      write: (chunk) => {
        written += chunk;
      },
    });
    return {
      renderer,
      read: () => written,
      reset: () => {
        written = "";
      },
    };
  }

  test("skips repainting a clean pane and repaints once it turns dirty", () => {
    const { renderer, read, reset } = makeRenderer();
    const vt = createVirtualTerminal(18, 3);
    vt.write("hello");

    renderer.renderPane(vt, pane, false, "agent");
    expect(read()).toContain("hello");

    reset();
    renderer.renderPane(vt, pane, false, "agent");
    expect(read()).toBe("");

    vt.write("world");
    renderer.renderPane(vt, pane, false, "agent");
    expect(read()).toContain("world");
  });

  test("repaints a clean pane when focus or layout changes", () => {
    const { renderer, read, reset } = makeRenderer();
    const vt = createVirtualTerminal(18, 3);
    vt.write("hello");

    renderer.renderPane(vt, pane, false, "agent");
    reset();
    renderer.renderPane(vt, pane, true, "agent");
    expect(read()).not.toBe("");

    reset();
    renderer.renderPane(vt, { ...pane, left: 4 }, true, "agent");
    expect(read()).not.toBe("");
  });

  test("force option repaints even when the pane is clean", () => {
    const { renderer, read, reset } = makeRenderer();
    const vt = createVirtualTerminal(18, 3);
    vt.write("hello");

    renderer.renderPane(vt, pane, false, "agent");
    reset();
    renderer.renderPane(vt, pane, false, "agent", { force: true });
    expect(read()).toContain("hello");
  });

  test("rewrites status and input lines only when their content changes", () => {
    const { renderer, read, reset } = makeRenderer();

    renderer.renderStatusLine({ top: 5, left: 0, width: 20 }, "ready");
    expect(read()).toContain("ready");
    reset();
    renderer.renderStatusLine({ top: 5, left: 0, width: 20 }, "ready");
    expect(read()).toBe("");
    renderer.renderStatusLine({ top: 5, left: 0, width: 20 }, "busy");
    expect(read()).toContain("busy");

    reset();
    renderer.renderInputPrompt({ top: 6, left: 0, width: 20 }, "› ", "draft", 5);
    expect(read()).toContain("draft");
    reset();
    renderer.renderInputPrompt({ top: 6, left: 0, width: 20 }, "› ", "draft", 5);
    expect(read()).toBe("");
    renderer.renderInputPrompt({ top: 6, left: 0, width: 20 }, "› ", "draft!", 6);
    expect(read()).toContain("draft!");
  });

  test("clear and clearRows invalidate cached output so it repaints", () => {
    const { renderer, read, reset } = makeRenderer();
    const vt = createVirtualTerminal(18, 3);
    vt.write("hello");

    renderer.renderStatusLine({ top: 5, left: 0, width: 20 }, "ready");
    renderer.renderPane(vt, pane, false, "agent");
    reset();

    renderer.clearRows(5, 1, 20, 0);
    reset();
    renderer.renderStatusLine({ top: 5, left: 0, width: 20 }, "ready");
    expect(read()).toContain("ready");

    reset();
    renderer.clearRows(0, 5, 20, 0);
    reset();
    renderer.renderPane(vt, pane, false, "agent");
    expect(read()).toContain("hello");

    reset();
    renderer.clear();
    reset();
    renderer.renderStatusLine({ top: 5, left: 0, width: 20 }, "ready");
    expect(read()).toContain("ready");
  });
});
