"use strict";

const { restoreStdinAfterHandoff } = require("../../../src/ui/ptyHandoff");

describe("ptyHandoff", () => {
  test("restoreStdinAfterHandoff clears raw mode when possible", () => {
    let raw = true;
    const stdin = {
      isTTY: true,
      setRawMode(next) {
        raw = next;
      },
      resume() {},
    };
    restoreStdinAfterHandoff(stdin);
    expect(raw).toBe(false);
  });

  test("runAgentPtyHandoff is removed", () => {
    const pty = require("../../../src/ui/ptyHandoff");
    expect(pty.runAgentPtyHandoff).toBeUndefined();
  });
});
