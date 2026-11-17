"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { swiftHelperSourcePath } = require("../../src/runtime/mac/paths");
const { ensureHelperCompiled } = require("../../src/runtime/mac/helperCompiler");

const pointerTest = process.platform === "darwin" && process.env.UFOO_TEST_MAC_POINTER === "1" ? test : test.skip;
pointerTest("cross-process mouse input reaches a disposable window without moving the user's cursor or foreground", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-pointer-test-"));
  try {
    const helper = fs.readFileSync(swiftHelperSourcePath(), "utf8")
      .replace("@main\nstruct UfooMacHelperMain", "struct UfooMacHelperMain");
    const fixture = fs.readFileSync(path.join(__dirname, "../fixtures/mac/independentPointer.swift"), "utf8");
    const sourcePath = path.join(root, "pointer.swift");
    fs.writeFileSync(sourcePath, helper + "\n" + fixture);
    const compiled = await ensureHelperCompiled({ sourcePath, env: { ...process.env, UFOO_MAC_HOME: root } });
    const run = spawnSync(compiled.binaryPath, [], { encoding: "utf8", timeout: 20000 });
    expect({ exit: run.status, stderr: run.stderr }).toEqual({ exit: 0, stderr: "" });
    const result = JSON.parse(run.stdout.trim());
    expect(result.childExit).toBe(0);
    // The user may keep using their mouse during this test. A passive global
    // event tap independently proves our tagged events never reach that stream.
    expect(result.injectedGlobalEvents).toBe(0);
    if (result.userMotionEvents === 0) expect(result.physicalCursorDelta).toBe(0);
    expect(result.targetActivated).toBe(false);
    if (result.userInputEvents === 0) expect(result.foregroundUnchanged).toBe(true);
    const types = result.events.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining([1, 2, 3, 4, 6, 22]));
    // AppKit dispatches mouseMoved to tracking areas, which this fixture view
    // intentionally does not install; verify delivery at the application boundary.
    expect(result.received.some((event) => event.type === 5 && event.x === 70 && event.y === 70)).toBe(true);
    const click = result.events.find((event) => event.type === 1);
    expect(click.x).toBeCloseTo(70);
    expect(click.y).toBeCloseTo(70);
    const scroll = result.events.filter((event) => event.type === 22);
    expect(scroll.reduce((sum, event) => sum + event.dy, 0)).toBe(-120);
    console.log(JSON.stringify({ cursorDelta: result.physicalCursorDelta, userMotionEvents: result.userMotionEvents,
      injectedGlobalEvents: result.injectedGlobalEvents, targetActivated: result.targetActivated,
      foregroundUnchanged: result.foregroundUnchanged, eventTypes: [...new Set(types)] }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
