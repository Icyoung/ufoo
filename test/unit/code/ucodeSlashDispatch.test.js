"use strict";

const { dispatchUcodeSlashCommand } = require("../../../src/code/ucodeSlashDispatch");

describe("dispatchUcodeSlashCommand", () => {
  test("handles help and exit", async () => {
    const logs = [];
    let exited = false;
    await dispatchUcodeSlashCommand(
      { kind: "help", output: "commands…" },
      { appendLog: (t, k) => logs.push([k, t]) },
    );
    expect(logs[0][1]).toContain("commands");

    await dispatchUcodeSlashCommand(
      { kind: "exit" },
      { onExit: () => { exited = true; }, appendLog: () => {} },
    );
    expect(exited).toBe(true);
  });

  test("status appends usage lines", async () => {
    const logs = [];
    await dispatchUcodeSlashCommand(
      { kind: "status" },
      {
        state: { sessionId: "s1", workspaceRoot: process.cwd() },
        workspaceRoot: process.cwd(),
        appendLog: (t, k) => logs.push([k, t]),
      },
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0][0]).toBe("system");
  });

  test("queue delegates control to the host and logs its result", async () => {
    const logs = [];
    const result = await dispatchUcodeSlashCommand(
      { kind: "queue", action: "clear" },
      {
        appendLog: (text, kind) => logs.push({ text, kind }),
        onQueueCommand: async (action) => ({
          ok: true,
          output: `handled ${action}`,
        }),
      },
    );
    expect(result.handled).toBe(true);
    expect(result.queue.output).toBe("handled clear");
    expect(logs).toEqual([{ text: "handled clear", kind: "system" }]);
  });

  test("nl_bg delegates to onBackground", async () => {
    const seen = [];
    await dispatchUcodeSlashCommand(
      { kind: "nl_bg", task: "do thing" },
      {
        appendLog: () => {},
        onBackground: async (task) => { seen.push(task); },
      },
    );
    expect(seen).toEqual(["do thing"]);
  });

  test("resume shows conversation rows and preserves tool and thinking data in the session", async () => {
    const messages = [
      { role: "user", content: "Read the file" },
      { role: "assistant", content: null, tool_calls: [
        { id: "read-file", function: { name: "read", arguments: '{"path":"notes.txt"}' } },
      ] },
      { role: "tool", tool_call_id: "read-file", content: "file contents" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "Check the file first" },
        { type: "reasoning_text", text: "Inspect the tool result" },
        { type: "text", text: "I read the file." },
      ] },
    ];
    const state = { nlMessages: [] };
    let entries = [];
    await dispatchUcodeSlashCommand(
      { kind: "resume", sessionId: "s1" },
      {
        state,
        appendLog: () => {},
        bannerLines: ["UCODE", "Version: 3.0.24"],
        resumeSession: () => {
          state.nlMessages = messages;
          return { ok: true, sessionId: "s1", restoredMessages: messages.length };
        },
        replaceTranscript: (next) => { entries = next; },
      },
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["banner", "banner", "spacer", "user", "assistant", "system"]);
    expect(entries[4].text).toBe("I read the file.");
    expect(state.nlMessages).toBe(messages);
    expect(state.nlMessages[1].tool_calls[0].id).toBe("read-file");
    expect(state.nlMessages[2]).toMatchObject({ role: "tool", content: "file contents" });
    expect(state.nlMessages[3].content[1].text).toBe("Inspect the tool result");
  });

  test("unknown without output is not handled", async () => {
    const result = await dispatchUcodeSlashCommand(
      { kind: "mystery" },
      { appendLog: () => {} },
    );
    expect(result.handled).toBe(false);
  });
});
