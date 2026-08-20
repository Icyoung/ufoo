"use strict";

const { createToolMergePublisher, EXIT_SUSPEND } = require("../../../src/ui/toolMergeBridge");

describe("toolMergeBridge", () => {
  test("publishes collapsed tool.group on flush", () => {
    const events = [];
    const tools = createToolMergePublisher((name, payload) => events.push({ name, payload }));
    tools.beginScope();
    tools.pushTool({ tool: "read", detail: "a.js" });
    tools.pushTool({ tool: "bash", detail: "ls" });
    tools.flush();
    expect(EXIT_SUSPEND).toBe(75);
    expect(events.some((e) => e.name === "tool.start")).toBe(true);
    const live = events.filter((e) => e.name === "tool.start").at(-1);
    expect(live.payload.count).toBe(2);
    expect(live.payload.detail).toBe("Read a.js\nBash ls");
    const group = events.find((e) => e.name === "tool.group");
    expect(group).toBeTruthy();
    expect(group.payload.summary).toMatch(/^• /);
    expect(group.payload.detail).toContain("Read");
    expect(group.payload.detail).toContain("Bash");
  });
});
