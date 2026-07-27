"use strict";

const { createVirtualTerminal } = require("../../../src/app/chat/multiWindow/virtualTerminal");
const { vtScreenToAnsiLines } = require("../../../src/app/chat/multiWindow/vtFrame");

describe("vtScreenToAnsiLines", () => {
  test("emits one string per row up to maxRows", () => {
    const vt = createVirtualTerminal(20, 5);
    vt.write("hello\r\nworld");
    const lines = vtScreenToAnsiLines(vt, { maxCols: 20, maxRows: 5 });
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("hello");
    expect(lines[1]).toContain("world");
  });

  test("preserves basic SGR foreground colour", () => {
    const vt = createVirtualTerminal(10, 1);
    vt.write("\x1b[31mred");
    const [line] = vtScreenToAnsiLines(vt, { maxCols: 10, maxRows: 1 });
    expect(line).toMatch(/\x1b\[31m/);
    expect(line).toContain("red");
  });

  test("respects maxCols by truncating on the right", () => {
    const vt = createVirtualTerminal(20, 1);
    vt.write("0123456789ABCDEFGHIJ");
    const [line] = vtScreenToAnsiLines(vt, { maxCols: 5, maxRows: 1 });
    // ANSI resets may appear, but visible chars should be capped at 5.
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toBe("01234");
  });
});
