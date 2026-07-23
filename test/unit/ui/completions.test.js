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

  test("priority order stamps put launch then group ahead of A–Z", () => {
    const { COMMAND_REGISTRY, COMMAND_TREE } = require("../../../src/app/chat/commands");
    const out = buildCompletions({
      text: "/",
      commands: COMMAND_REGISTRY,
      commandTree: COMMAND_TREE,
      limit: 8,
    });
    expect(out.map((s) => s.label).slice(0, 4)).toEqual([
      "/launch",
      "/group",
      "/bus",
      "/ctx",
    ]);
  });

  test("exact top-level command returns no popup so Enter can submit", () => {
    expect(buildCompletions({
      text: "/status",
      commands: [{ cmd: "status" }],
    })).toEqual([]);
  });

  test("exact top-level command with children keeps popup available", () => {
    const tree = {
      "/group": {
        children: {
          run: { desc: "Launch a group template" },
        },
      },
    };
    const out = buildCompletions({
      text: "/group",
      commands: [{ cmd: "group" }],
      commandTree: tree,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      label: "/group",
      replace: "/group ",
      hasChildren: true,
    });
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

  test("exact subcommand returns no popup so Enter can submit", () => {
    const tree = {
      "/daemon": {
        children: {
          restart: { desc: "Restart daemon" },
        },
      },
    };
    expect(buildCompletions({ text: "/daemon restart", commandTree: tree })).toEqual([]);
  });

  test("group run subcommand keeps popup available for template arguments", () => {
    const tree = {
      "/group": {
        children: {
          run: { desc: "Launch a group template" },
        },
      },
    };
    const out = buildCompletions({ text: "/group run", commandTree: tree });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      label: "/group run",
      replace: "/group run ",
      hasChildren: true,
    });
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

  test("exact dynamic group template returns no popup so Enter can submit", () => {
    expect(buildCompletions({
      text: "/group run build-lane",
      groupTemplates: [{ alias: "build-lane", desc: "Build lane" }],
    })).toEqual([]);
  });

  test("exact dynamic group template with trailing space still returns no popup", () => {
    expect(buildCompletions({
      text: "/group run build-lane ",
      groupTemplates: [{ alias: "build-lane", desc: "Build lane" }],
    })).toEqual([]);
  });

  test("ucode /resume argumentLists offers session ids", () => {
    const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../../../src/code/commands");
    const out = buildCompletions({
      text: "/resume ",
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: {
        "/resume": [
          { id: "ucode-abc", desc: "2026-07-21 · gpt" },
          { id: "ucode-def", desc: "older" },
        ],
      },
    });
    expect(out.map((s) => s.label)).toEqual([
      "/resume ucode-abc",
      "/resume ucode-def",
    ]);
    expect(out[0].replace).toBe("/resume ucode-abc ");
  });

  test("ucode slash top-level lists registry commands", () => {
    const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../../../src/code/commands");
    const out = buildCompletions({
      text: "/",
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: { "/resume": [{ id: "sess-1" }] },
      limit: 20,
    });
    expect(out.map((s) => s.label)).toEqual([
      "/help",
      "/status",
      "/model",
      "/plan",
      "/ubus",
      "/resume",
      "/skills",
      "/bg",
      "/exit",
    ]);
    expect(out.find((s) => s.label === "/resume").hasChildren).toBe(true);
    expect(out.find((s) => s.label === "/model").hasChildren).toBe(true);
    expect(out.find((s) => s.label === "/model").optionalArguments).toBe(true);
  });

  test("exact /model closes popup so Enter can show current model", () => {
    const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../../../src/code/commands");
    expect(buildCompletions({
      text: "/model",
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: { "/model": [{ id: "gpt-5.4" }] },
    })).toEqual([]);
  });

  test("ucode /model argumentLists offers model ids", () => {
    const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../../../src/code/commands");
    const out = buildCompletions({
      text: "/model ",
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: {
        "/model": [
          { id: "gpt-5.4", desc: "current" },
          { id: "o3", desc: "" },
        ],
      },
    });
    expect(out.map((s) => s.label)).toEqual([
      "/model gpt-5.4",
      "/model o3",
    ]);
    expect(out[0].hasChildren).toBe(false);
  });

  test("ucode /model opens thinking intensity as a secondary menu", () => {
    const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../../../src/code/commands");
    const models = buildCompletions({
      text: "/model ",
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: {
        "/model": [
          { id: "gpt-5.4", desc: "current", hasChildren: true },
          { id: "o3", hasChildren: true },
        ],
        "/model/thinking": [
          { id: "off", desc: "disable" },
          { id: "medium", desc: "default · current" },
          { id: "high", desc: "deeper" },
        ],
      },
    });
    expect(models[0]).toMatchObject({
      label: "/model gpt-5.4",
      replace: "/model gpt-5.4 ",
      hasChildren: true,
    });

    const thinking = buildCompletions({
      text: "/model gpt-5.4 ",
      commands: UCODE_COMMAND_REGISTRY,
      commandTree: UCODE_COMMAND_TREE,
      argumentLists: {
        "/model": [{ id: "gpt-5.4", hasChildren: true }],
        "/model/thinking": [
          { id: "off", desc: "disable" },
          { id: "medium", desc: "default · current" },
          { id: "high", desc: "deeper" },
        ],
      },
    });
    expect(thinking.map((s) => s.label)).toEqual([
      "/model gpt-5.4 off",
      "/model gpt-5.4 medium",
      "/model gpt-5.4 high",
    ]);
    expect(thinking[0].hasChildren).toBe(false);
  });
});

describe("buildUcodeSessionLogEntries", () => {
  const { buildUcodeSessionLogEntries } = require("../../../src/ui/format");

  test("maps user/assistant/tool messages into log rows", () => {
    const { entries } = buildUcodeSessionLogEntries([
      { role: "user", content: "fix resume" },
      { role: "assistant", content: "ok **ready**" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      {
        role: "tool",
        tool_call_id: "c1",
        content: JSON.stringify({ artifactId: "artifact_1", preview: "file contents" }),
      },
    ]);
    expect(entries.some((row) => row.kind === "user" && row.text.includes("fix resume"))).toBe(true);
    expect(entries.some((row) => row.kind === "assistant" && row.text.includes("ready"))).toBe(true);
    expect(entries.some((row) => row.kind === "system" && /read/.test(row.text))).toBe(true);
    expect(entries.some((row) => row.kind === "toolDetail" && row.text.includes("file contents"))).toBe(true);
  });
});
