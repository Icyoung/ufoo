"use strict";

const path = require("path");
const {
  historyToEntries,
  loadDynamicCompletionSources,
} = require("../../../src/ui/rustChatHost");
const { buildCompletions } = require("../../../src/ui/format");
const { COMMAND_TREE, COMMAND_REGISTRY } = require("../../../src/app/chat/commands");

describe("rustChatHost helpers", () => {
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
