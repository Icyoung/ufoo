"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendChatHistory, loadChatHistory } = require("../../../src/app/chat/historyStore");
const { historyToEntries } = require("../../../src/ui/rustChatHost");

describe("chat history replay", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-history-layout-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test("reloading a streamed reply preserves one block, its speaker and code/table layout", () => {
    const body = 'First paragraph\n\nSecond paragraph\n```js\n  const item = { value: 1 };\n```\n| File | Result |\n| --- | --- |\n| a.js | OK |';
    appendChatHistory(root, "user", "› first line\nsecond line");
    appendChatHistory(root, "bus", `ufoo: ${body}`, { stream_done: true, sessionId: "main", taskRunId: "task-1" });

    const entries = historyToEntries(loadChatHistory(root));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "user", text: "› first line\nsecond line" });
    expect(entries[1]).toMatchObject({ kind: "assistant", speaker: "ufoo", text: body });
    expect(historyToEntries(loadChatHistory(root))).toEqual(entries);
  });

  test("history limits count complete blocks and preserve foldable tool/thinking details", () => {
    appendChatHistory(root, "system", "older message");
    const thinking = Array.from({ length: 250 }, (_, index) => `thinking ${index}`).join("\n");
    const detail = "Read a.js\nBash pwd\nEdit b.js\nWrite c.js\nRead d.js";
    appendChatHistory(root, "thinking", thinking);
    appendChatHistory(root, "tool", "• Read a.js · +4 calls (Ctrl+O expand)", { detail, expanded: true });

    const entries = historyToEntries(loadChatHistory(root, 2));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "thinking", text: thinking, expanded: false });
    expect(entries[1]).toMatchObject({ kind: "tool", detail, expanded: false });
  });

  test("metadata speakers and paragraph boundaries survive non-streamed history", () => {
    appendChatHistory(root, "assistant", "Hello\n\nNext paragraph", { speaker: "ufoo" });
    const entries = historyToEntries(loadChatHistory(root));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", speaker: "ufoo", text: "Hello\n\nNext paragraph" });
  });

  test("presentation tags are stripped without deleting code or turning spacers into empty messages", () => {
    appendChatHistory(root, "spacer", "");
    appendChatHistory(root, "system", '{gray-fg}Model{/gray-fg}: { "value": 1 }');
    appendChatHistory(root, "spacer", "");
    appendChatHistory(root, "spacer", "");
    appendChatHistory(root, "user", "› hello");
    appendChatHistory(root, "spacer", "");
    expect(historyToEntries(loadChatHistory(root))).toEqual([
      expect.objectContaining({ kind: "system", text: 'Model: { "value": 1 }' }),
      expect.objectContaining({ kind: "spacer", text: "" }),
      expect.objectContaining({ kind: "user", text: "› hello" }),
    ]);
  });
});
