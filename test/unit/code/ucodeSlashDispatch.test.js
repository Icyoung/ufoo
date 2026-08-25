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

  test("resume restores the banner with its dedicated unformatted entry kind", async () => {
    let entries = [];
    await dispatchUcodeSlashCommand(
      { kind: "resume", sessionId: "s1" },
      {
        state: { nlMessages: [] },
        appendLog: () => {},
        bannerLines: ["UCODE", "Version: 3.0.24"],
        resumeSession: () => ({ ok: true, sessionId: "s1", restoredMessages: 0 }),
        replaceTranscript: (next) => { entries = next; },
      },
    );

    expect(entries.slice(0, 2).map((entry) => entry.kind)).toEqual(["banner", "banner"]);
    expect(entries[2].kind).toBe("spacer");
  });

  test("unknown without output is not handled", async () => {
    const result = await dispatchUcodeSlashCommand(
      { kind: "mystery" },
      { appendLog: () => {} },
    );
    expect(result.handled).toBe(false);
  });
});
