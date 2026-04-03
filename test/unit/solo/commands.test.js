"use strict";

const {
  resolveSoloAgentType,
  buildPromptProfileCandidates,
} = require("../../../src/solo/commands");

describe("solo commands helpers", () => {
  test("resolveSoloAgentType respects explicit aliases", () => {
    expect(resolveSoloAgentType({}, "uclaude")).toBe("claude");
    expect(resolveSoloAgentType({}, "openai")).toBe("codex");
    expect(resolveSoloAgentType({}, "ufoo")).toBe("ucode");
  });

  test("resolveSoloAgentType falls back to configured provider", () => {
    expect(resolveSoloAgentType({ agentProvider: "claude-cli" }, "")).toBe("claude");
    expect(resolveSoloAgentType({ agentProvider: "ucode" }, "")).toBe("ucode");
    expect(resolveSoloAgentType({ agentProvider: "codex-cli" }, "")).toBe("codex");
  });

  test("buildPromptProfileCandidates includes id and summary", () => {
    const rows = buildPromptProfileCandidates({
      profiles: [
        { id: "design-critic", summary: "Audit the interface", source: "builtin" },
      ],
    });
    expect(rows).toEqual([
      { cmd: "design-critic", desc: "Audit the interface · builtin", source: "builtin" },
    ]);
  });
});
