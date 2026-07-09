"use strict";

const { createRenderer } = require("../../../../src/app/chat/multiWindow/renderer");

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
