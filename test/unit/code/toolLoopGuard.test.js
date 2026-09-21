const { ToolLoopGuard } = require("../../../src/code/toolLoopGuard");

describe("repeated tool steps", () => {
  test("canonicalizes nested arguments and parallel order, keeping one warning per run", () => {
    const guard = new ToolLoopGuard();
    const a = { name: "read", args: { path: "a", range: { start: 1, end: 2 } } };
    const b = { name: "read", args: { path: "b" } };
    for (let i = 0; i < 4; i += 1) {
      guard.observe(i % 2 ? [b, { ...a, args: { range: { end: 2, start: 1 }, path: "a" } }] : [a, b]);
    }
    expect(guard.nextAction().kind).toBe("warn");
    expect(guard.nextAction()).toBeNull();
    for (let i = 0; i < 4; i += 1) guard.observe([a, b]);
    expect(guard.nextAction().kind).toBe("stop");
    guard.observe([{ ...a, args: { path: "c" } }]);
    expect(guard.count).toBe(1);
    expect(guard.nextAction()).toBeNull();
  });

  test("mixed batches use the looser thresholds and empty steps reset the streak", () => {
    const guard = new ToolLoopGuard();
    const calls = [{ name: "read", args: { path: "a" } }, { name: "bash", args: { command: "ls" } }];
    for (let i = 1; i <= 12; i += 1) {
      guard.observe(calls);
      expect(guard.nextAction()?.kind || null).toBe(i === 8 ? "warn" : i === 12 ? "stop" : null);
    }
    guard.observe([]);
    expect(guard.count).toBe(0);
    expect(guard.nextAction()).toBeNull();
  });
});
