"use strict";

const { buildToolMergeRowText } = require("../../../src/ui/format");

describe("buildToolMergeRowText", () => {
  test("empty list reads as 'tool' (defensive)", () => {
    expect(buildToolMergeRowText([])).toBe("· Ran tool");
  });

  test("single entry shows the summary without the expand hint", () => {
    expect(buildToolMergeRowText([{ tool: "read", detail: "AGENTS.md" }]))
      .toBe("· Ran read · AGENTS.md");
  });

  test("two+ entries append the (Ctrl+O expand) hint", () => {
    const text = buildToolMergeRowText([
      { tool: "read", detail: "a.md" },
      { tool: "bash", detail: "ls" },
    ]);
    expect(text).toMatch(/^· Ran/);
    expect(text).toMatch(/\+1 calls/);
    expect(text).toMatch(/\(Ctrl\+O expand\)$/);
  });

  test("error count is reflected in the summary", () => {
    const text = buildToolMergeRowText([
      { tool: "read", detail: "a.md" },
      { tool: "bash", detail: "ls", isError: true, errorText: "exit 1" },
      { tool: "edit", detail: "b.md", isError: true, errorText: "boom" },
    ]);
    expect(text).toMatch(/2 errors/);
    expect(text).toMatch(/\(Ctrl\+O expand\)$/);
  });
});
