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

  test("unknown without output is not handled", async () => {
    const result = await dispatchUcodeSlashCommand(
      { kind: "mystery" },
      { appendLog: () => {} },
    );
    expect(result.handled).toBe(false);
  });
});
