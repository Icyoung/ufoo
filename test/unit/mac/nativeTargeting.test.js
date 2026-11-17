"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { swiftHelperSourcePath } = require("../../../src/runtime/mac/paths");
const { detectSwiftCompiler, ensureHelperCompiled } = require("../../../src/runtime/mac/helperCompiler");

const nativeTest = process.platform === "darwin" && detectSwiftCompiler().available ? test : test.skip;

nativeTest("native targeting rejects missing apps, closed windows and clicks with failed focus", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mac-target-"));
  try {
    // Compile the actual helper with a test entrypoint. No windows, TCC prompts,
    // mouse or keyboard events are created by these failure-path checks.
    const source = fs.readFileSync(swiftHelperSourcePath(), "utf8")
      .replace("@main\nstruct UfooMacHelperMain", "struct UfooMacHelperMain");
    const sourcePath = path.join(root, "targeting.swift");
    fs.writeFileSync(sourcePath, source + `
extension TakeoverMonitor {
  func verifyIndependentPointerTakeover() {
    _ = beginAgentInput(at: nil)
    for x in stride(from: 0, through: 300, by: 20) {
      let event = NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: x, y: 100),
        modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
        eventNumber: 0, clickCount: 0, pressure: 0)!
      handleGlobalMouseEvent(event)
    }
    precondition(currentTakeover() == nil, "Normal physical movement must not stop the independent cursor")
    for x in [0, 80, 0, 80, 0] {
      let event = NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: x, y: 100),
        modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
        eventNumber: 0, clickCount: 0, pressure: 0)!
      handleGlobalMouseEvent(event)
    }
    precondition(currentTakeover()?["reason"] as? String == "user_mouse_shake")
    clear()
    let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
      windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "",
      isARepeat: false, keyCode: 53)!
    handleGlobalKeyEvent(escape)
    precondition(currentTakeover()?["reason"] as? String == "user_pressed_escape")
  }
}
@main
struct TargetingRegression {
  static func main() throws {
    TakeoverMonitor().verifyIndependentPointerTakeover()
    let engine = MacAutomationEngine()
    let absent = "ufoo-nonexistent-application-6b5f1c"
    precondition(engine.resolveTargetApp(appName: absent) == nil)
    precondition(engine.resolveTargetApp(bundleId: "invalid." + absent) == nil)
    precondition(engine.resolveTargetApp(windowId: Int(UInt32.max)) == nil)
    // An explicit bundle/window selector must not fall through to a supplied name.
    if let front = NSWorkspace.shared.frontmostApplication?.localizedName {
      precondition(engine.resolveTargetApp(appName: front, bundleId: "invalid." + absent) == nil)
      precondition(engine.resolveTargetApp(appName: front, windowId: Int(UInt32.max)) == nil)
    }
    precondition(snapshotWindow([202, 303], windowId: 101, rootIndex: 0, id: { $0 }) == nil)
    precondition(snapshotWindow([202, 101], windowId: 101, rootIndex: 0, id: { $0 }) == 101)
    precondition(snapshotWindow([202, 303], windowId: 0, rootIndex: 1, id: { $0 }) == 303)
    precondition(snapshotWindow([202], windowId: 0, rootIndex: 1, id: { $0 }) == nil)
    do {
      _ = try engine.dispatch(method: "mouse_click", params: [
        "x": 0, "y": 0, "focusFirst": true, "app": absent,
      ])
      fatalError("Click should have stopped at target lookup")
    } catch let error as NSError {
      precondition(error.domain == "ufoo.mac" && error.code == 404)
    }
    do {
      _ = try engine.dispatch(method: "key_type", params: ["text": "must not reach the foreground"])
      fatalError("Keyboard input without a target must not fall back to the foreground")
    } catch let error as NSError {
      precondition(error.domain == "ufoo.mac" && error.code == 404)
    }
    print("targeting regressions passed")
  }
}
`);
    const compiled = await ensureHelperCompiled({ env: { ...process.env, UFOO_MAC_HOME: root }, sourcePath });
    const result = spawnSync(compiled.binaryPath, [], { encoding: "utf8", timeout: 10000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("targeting regressions passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
