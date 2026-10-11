"use strict";

const path = require("path");
const {
  historyToEntries,
  loadDynamicCompletionSources,
  loadResumeCompletionSources,
  parseWindowModeArgs,
  resolveSubmittedInputTarget,
} = require("../../../src/ui/rustChatHost");
const { buildCompletions } = require("../../../src/ui/format");
const { COMMAND_TREE, COMMAND_REGISTRY } = require("../../../src/app/chat/commands");

describe("rustChatHost helpers", () => {
  test("submission identity wins over stale footer selection and invalid targets never fall back to main", () => {
    const internal = (id) => ["child-a", "child-b"].includes(id);
    expect(resolveSubmittedInputTarget({ target_agent: "child-b", has_target: true }, "child-a", internal))
      .toEqual({ ok: true, target: "child-b" });
    expect(resolveSubmittedInputTarget({ input_target: "main" }, "child-a", internal))
      .toEqual({ ok: true, target: null });
    for (const payload of [{ has_target: true }, { target_agent: "missing" }, { target_agent: "wrapper" }]) {
      expect(resolveSubmittedInputTarget(payload, null, internal).ok).toBe(false);
    }
  });
  test("resume offers standalone agents and whole groups instead of a list subcommand", async () => {
    const request = jest.fn(async () => ({ recoverable: { recoverable: [
      { id: "ucode:solo", nickname: "solo", agent: "ucode", sessionId: "native-session", lastSeen: "2026-10-09" },
      { id: "codex:member", nickname: "reviewer", agent: "codex", group_id: "team" },
    ], groups: [{ group_id: "team", template_alias: "dev-basic", members: [{ id: "codex:member" }] }] } }));
    const targets = await loadResumeCompletionSources("/tmp/project", request);
    expect(request).toHaveBeenCalledWith("/tmp/project", { type: "list_recoverable_agents", internal_only: true }, expect.any(Object));
    const items = buildCompletions({ text: "/resume ", commands: COMMAND_REGISTRY, commandTree: COMMAND_TREE,
      argumentLists: { "/resume": targets }, limit: 20 });
    expect(items.map((item) => item.label)).toEqual(["/resume solo", "/resume group:team"]);
    expect(items[0].replace).toBe("/resume ucode:solo ");
    expect(items[1].replace).toBe("/resume group:team ");
    expect(items[1].description).toContain("1 recoverable agents");
    expect(items.every((item) => !item.hasChildren)).toBe(true);
    expect(buildCompletions({ text: "/resume so", commands: COMMAND_REGISTRY, commandTree: COMMAND_TREE,
      argumentLists: { "/resume": targets } }).map((item) => item.label)).toEqual(["/resume solo"]);
    expect(COMMAND_TREE["/resume"].children).toBeUndefined();
    expect(COMMAND_TREE["/resume"].hasArguments).toBe(true);
  });
  test.each([
    [["main"], "main"],
    [["side"], "side"],
    [["multi"], "multi"],
    [["MULTI"], "multi"],
    [[], ""], [["on"], ""], [["off"], ""], [["@coder"], ""],
    [["main", "extra"], ""], [["main+one", "agent"], ""],
  ])("parses window arguments %j as %s", (args, mode) => {
    expect(parseWindowModeArgs(args)).toBe(mode);
  });
  test("historyToEntries maps string and object rows", () => {
    const entries = historyToEntries([
      "plain",
      { text: "› hi", sourceType: "user" },
      { text: "ok", sourceType: "assistant", speaker: "codex" },
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: "system", text: "plain" });
    expect(entries[1]).toMatchObject({ kind: "user", text: "› hi" });
    expect(entries[2]).toMatchObject({ kind: "assistant", speaker: "codex" });
  });

  test("completion.request sources include group templates for /group run", () => {
    const root = path.resolve(__dirname, "../../..");
    const dynamic = loadDynamicCompletionSources(root);
    expect(Array.isArray(dynamic.groupTemplates)).toBe(true);
    expect(dynamic.groupTemplates.length).toBeGreaterThan(0);
    const items = buildCompletions({
      text: "/group run ",
      commands: COMMAND_REGISTRY,
      commandTree: COMMAND_TREE,
      groupTemplates: dynamic.groupTemplates,
      soloProfiles: dynamic.soloProfiles,
      limit: 20,
    });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].label).toMatch(/^\/group run /);
  });
});
