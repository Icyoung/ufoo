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

  test("transient daemon disconnect/reconnect chatter is neither persisted nor replayed", () => {
    const file = path.join(root, ".ufoo", "chat", "history.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Seed legacy polluted history lines on disk
    fs.writeFileSync(file, [
      JSON.stringify({ ts: "2026-07-31T15:06:05.857Z", type: "error", text: "✗ Failed to reconnect to daemon", meta: {} }),
      JSON.stringify({ ts: "2026-07-31T15:06:23.863Z", type: "system", text: "{gray-fg}✓{/gray-fg} Daemon reconnected", meta: {} }),
      JSON.stringify({ ts: "2026-07-31T15:16:05.486Z", type: "user", text: "› hello", meta: {} }),
    ].join("\n") + "\n", "utf8");

    // Attempting to append new disconnect/reconnect chatter must be ignored
    appendChatHistory(root, "error", "✗ Failed to reconnect to daemon");
    appendChatHistory(root, "system", "Switching daemon connection");
    appendChatHistory(root, "error", "Custom ephemeral warning", { transient: true });
    // Real user / assistant / provider error messages are preserved
    appendChatHistory(root, "error", "provider request failed (401)");

    const loaded = loadChatHistory(root);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe("› hello");
    expect(loaded[1].text).toBe("provider request failed (401)");
  });

  test("UI operational echoes and agent launch/close lifecycle chatter are excluded from chat history", () => {
    const file = path.join(root, ".ufoo", "chat", "history.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ ts: "2026-08-17T04:10:18.135Z", type: "user", text: "› Toggling multi-pane view", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:10:18.137Z", type: "system", text: "Entered multi-window (Ctrl+W focus · Ctrl+Q exit).", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:10:36.285Z", type: "system", text: "{white-fg}ufoo{/white-fg} {gray-fg}·{/gray-fg} Closed codex:3f689ff6", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:10:38.221Z", type: "user", text: "› Launching a claude agent", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:10:39.067Z", type: "reply", text: "{white-fg}ufoo{/white-fg} {gray-fg}·{/gray-fg} Launched claude:abc123", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:10:54.022Z", type: "user", text: "› Showing settings", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:10:54.025Z", type: "system", text: "✓ Message delivered", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:11:00.000Z", type: "user", text: "› Please fix the login bug", meta: {} }),
      JSON.stringify({ ts: "2026-08-17T04:11:05.000Z", type: "assistant", text: "Fixed token refresh in auth.js", meta: { speaker: "ufoo" } }),
    ].join("\n") + "\n", "utf8");

    appendChatHistory(root, "reply", "ufoo · Closed codex:9999");
    appendChatHistory(root, "system", "Entering agent architect…");
    appendChatHistory(root, "system", "Returned from agent (activate).");
    appendChatHistory(root, "user", "› Setting agent provider to codex");

    const loaded = loadChatHistory(root);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe("› Please fix the login bug");
    expect(loaded[1].text).toBe("Fixed token refresh in auth.js");
  });

  test("gear/status lifecycle noise (resuming, launching, closing, switching, daemon, config) is excluded while real messages remain", () => {
    const file = path.join(root, ".ufoo", "chat", "history.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ ts: "2026-11-27T10:00:00.000Z", type: "system", text: "{white-fg}⚙{/white-fg} Resuming agents (ucode:ab85fb82)...", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:01.000Z", type: "system", text: "{white-fg}⚙{/white-fg} Launching claude...", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:02.000Z", type: "status", text: "{white-fg}⚙{/white-fg} Closing claude-1...", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:03.000Z", type: "status", text: "{white-fg}✓{/white-fg} {escape}delivered to codex-2{/escape}", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:04.000Z", type: "status", text: "{white-fg}✓{/white-fg} {escape}codex-2 done{/escape}", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:05.000Z", type: "system", text: "{white-fg}⚙{/white-fg} Switching project: /Users/icy/Code/Neptune", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:06.000Z", type: "system", text: "{white-fg}✓{/white-fg} Switched project: /Users/icy/Code/Neptune", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:07.000Z", type: "system", text: "{white-fg}⚙{/white-fg} Opening project: /Users/icy/Code/ufoo", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:08.000Z", type: "system", text: "{white-fg}✓{/white-fg} Handed off to Ufoo Desktop (ufoo://open)", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:09.000Z", type: "system", text: "{white-fg}✓{/white-fg} ufoo-agent config updated", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:10.000Z", type: "system", text: "{white-fg}ufoo{/white-fg} {gray-fg}·{/gray-fg} Task queued for: ucode-3", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:11.000Z", type: "user", text: "{white-fg}→{/white-fg} {escape}/daemon restart{/escape}", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:00:12.000Z", type: "bus", text: "{gray-fg}↔{/gray-fg} {gray-fg}{escape}ufoo-agent{/escape}{/gray-fg}: ", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:01:00.000Z", type: "user", text: "› Run the simulator smoke test", meta: {} }),
      JSON.stringify({ ts: "2026-11-27T10:01:05.000Z", type: "assistant", text: "Starting the simulator now and verifying all flows.", meta: { speaker: "ufoo" } }),
    ].join("\n") + "\n", "utf8");

    appendChatHistory(root, "system", "{white-fg}⚙{/white-fg} Resuming agents (ucode:ab85fb82)...");
    appendChatHistory(root, "status", "{gray-fg}⚙{/gray-fg} Restarting daemon...");
    appendChatHistory(root, "system", "{white-fg}✓{/white-fg} Message sent to ucode-3");

    const loaded = loadChatHistory(root);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].text).toBe("› Run the simulator smoke test");
    expect(loaded[1].text).toBe("Starting the simulator now and verifying all flows.");
  });
});
