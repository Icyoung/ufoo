"use strict";

const { buildCompletions } = require("../../../src/ui/format");

describe("buildCompletions", () => {
  test("empty input returns no suggestions", () => {
    expect(buildCompletions({ text: "" })).toEqual([]);
  });

  test("plain text returns no suggestions", () => {
    expect(buildCompletions({ text: "hello world", commands: [{ cmd: "help" }] })).toEqual([]);
  });

  test("/h matches commands starting with h", () => {
    const out = buildCompletions({
      text: "/h",
      commands: [{ cmd: "help" }, { cmd: "history" }, { cmd: "open" }],
    });
    expect(out.map((s) => s.label)).toEqual(["/help", "/history"]);
    expect(out[0].replace).toBe("/help ");
    expect(out[0].kind).toBe("command");
  });

  test("/<full-name with space> stops completing (sub-command not yet supported)", () => {
    const out = buildCompletions({
      text: "/cron sta",
      commands: [{ cmd: "cron" }],
    });
    expect(out).toEqual([]);
  });

  test("@ pulls from the current agents list and matches by label", () => {
    const out = buildCompletions({
      text: "@cl",
      agents: ["claude-code:abc123", "codex-cli:def456"],
      agentLabels: ["claude:abc12", "codex:def45"],
    });
    expect(out.map((s) => s.label)).toEqual(["@claude:abc12"]);
    expect(out[0].replace).toBe("@claude:abc12 ");
    expect(out[0].description).toContain("claude-code:abc123");
    expect(out[0].kind).toBe("agent");
  });

  test("respects the `limit` argument", () => {
    const commands = Array.from({ length: 20 }, (_, i) => ({ cmd: `c${i.toString().padStart(2, "0")}` }));
    const out = buildCompletions({ text: "/c", commands, limit: 5 });
    expect(out.length).toBe(5);
  });
});
