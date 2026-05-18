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

  test("/<cmd> <prefix> returns [] when no commandTree is supplied", () => {
    // Sub-command completion needs the tree; without it the function
    // can't know what children exist, so it falls back to no popup.
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

  test("/<cmd> <prefix> walks into commandTree.children", () => {
    const tree = {
      "/cron": {
        desc: "Cron scheduler operations",
        children: {
          start: { desc: "Create cron task", order: 1 },
          stop: { desc: "Stop cron task", order: 2 },
          list: { desc: "List cron tasks", order: 3 },
        },
      },
    };
    const out = buildCompletions({ text: "/cron s", commandTree: tree });
    expect(out.map((s) => s.label)).toEqual(["/cron start", "/cron stop"]);
    expect(out[0].replace).toBe("/cron start ");
    expect(out[0].description).toBe("Create cron task");
    expect(out[0].kind).toBe("subcommand");
  });

  test("/<cmd> <sub> <prefix> walks one level deeper", () => {
    const tree = {
      "/settings": {
        desc: "Settings",
        children: {
          agent: {
            desc: "Manage main agent",
            children: {
              show: { desc: "Show config", order: 1 },
              set: { desc: "Set config", order: 2 },
            },
          },
        },
      },
    };
    const out = buildCompletions({ text: "/settings agent s", commandTree: tree });
    expect(out.map((s) => s.label)).toEqual(["/settings agent show", "/settings agent set"]);
  });

  test("returns [] when the named command has no children", () => {
    const tree = { "/help": { desc: "Help" } };
    expect(buildCompletions({ text: "/help anything", commandTree: tree })).toEqual([]);
  });
});
