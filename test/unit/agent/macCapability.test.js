"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMacSessions } = require("../../../src/runtime/mac/macSession");
const { createMacCapability } = require("../../../src/agents/capabilities/mac");
const { createToolRegistry } = require("../../../src/agents/runtime/tools/registry");
const {
  createOpenAiChatTransport,
  createOpenAiResponsesTransport,
  createAnthropicMessagesTransport,
} = require("../../../src/agents/providers/transports");

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("shared macOS app & Agent Mouse capability", () => {
  let root;
  let context;
  let rpcMock;
  let pingMock;
  let checkMock;
  let leaseMock;
  let releaseFn;
  let macConfig;
  let sessions;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mac-cap-"));
    context = {
      workspaceRoot: root,
      sessionId: "sess-1",
      artifactNamespace: "ucode",
      requestId: "req-turn-1",
    };
    macConfig = { enabled: true, hud: true, takeoverGuard: true, schemaVersion: 1 };
    releaseFn = jest.fn(async () => {});
    leaseMock = jest.fn(async () => releaseFn);
    pingMock = jest.fn(async () => ({
      helperVersion: "1.0.0",
      pid: 4242,
      permissions: { accessibility: true, screenRecording: true },
      displays: [{ index: 1, main: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2 }],
    }));
    checkMock = jest.fn(async () => ({
      helperVersion: "1.0.0",
      permissions: { accessibility: true, screenRecording: true },
      displays: [],
    }));
    rpcMock = jest.fn(async (method, params) => {
      if (method === "snapshot") {
        return {
          ok: true,
          result: {
            app: params.app || "Calculator",
            bundleId: "com.apple.calculator",
            pid: 777,
            truncated: false,
            elements: [
              {
                role: "AXWindow",
                depth: 0,
                rootKind: "window",
                rootIndex: 0,
                windowId: 301,
                axPath: [],
                title: "Calculator",
                enabled: true,
                focused: false,
                frame: { x: 200, y: 120, width: 260, height: 380 },
                center: { x: 330, y: 310 },
                actions: ["AXRaise"],
              },
              {
                role: "AXButton",
                depth: 1,
                rootKind: "window",
                rootIndex: 0,
                windowId: 301,
                axPath: [4],
                title: "7",
                label: "Seven",
                enabled: true,
                focused: false,
                frame: { x: 230, y: 280, width: 48, height: 48 },
                center: { x: 254, y: 304 },
                actions: ["AXPress"],
              },
            ],
          },
        };
      }
      if (method === "ax_action") {
        return {
          ok: true,
          result: { axAction: params.axAction, role: "AXButton", title: "7" },
        };
      }
      if (method === "screenshot") {
        fs.writeFileSync(params.outputPath, TINY_PNG);
        return {
          ok: true,
          result: {
            captureKind: "window",
            coordinateSpace: "window",
            bounds: { x: 200, y: 120, width: 260, height: 380 },
            imageWidth: 260,
            imageHeight: 380,
            scaleX: 1,
            scaleY: 1,
            windowId: 301,
            pid: 777,
            app: "Calculator",
            title: "Calculator",
            path: params.outputPath,
            mediaType: "image/png",
          },
        };
      }
      if (method === "list_windows") {
        return {
          ok: true,
          result: {
            windows: [{
              windowId: 301,
              app: "Calculator",
              pid: 777,
              title: "Calculator",
              bounds: { x: 210, y: 130, width: 260, height: 380 },
              frontmost: true,
            }],
          },
        };
      }
      if (method === "mouse_click") {
        return {
          ok: true,
          result: { x: params.x, y: params.y, button: params.button, clickCount: params.clickCount },
        };
      }
      if (method === "mouse_drag") {
        return {
          ok: true,
          result: { from: { x: params.fromX, y: params.fromY }, to: { x: params.toX, y: params.toY } },
        };
      }
      if (method === "key_type") {
        return {
          ok: true,
          result: { typedLength: params.text.length, submitted: Boolean(params.submit) },
        };
      }
      if (method === "key_press") {
        return {
          ok: true,
          result: { key: params.key, modifiers: params.modifiers || [], repeat: params.repeat || 1 },
        };
      }
      if (method === "hide_hud" || method === "clear_takeover") {
        return { ok: true, result: { hidden: true } };
      }
      return { ok: true, result: {} };
    });

    sessions = createMacSessions({
      env: {},
      platform: "darwin",
      loadMacConfig: () => macConfig,
      rpcCall: rpcMock,
      pingDaemon: pingMock,
      checkHelper: checkMock,
      acquireLease: leaseMock,
    });
  });

  afterEach(async () => {
    await sessions.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test("degrades cleanly on non-darwin platforms without invoking helper", async () => {
    const linuxSessions = createMacSessions({
      env: {},
      platform: "linux",
      loadMacConfig: () => macConfig,
      rpcCall: rpcMock,
      pingDaemon: pingMock,
    });
    expect(await linuxSessions.execute({ operation: "status" }, context)).toMatchObject({
      ok: true,
      supported: false,
      platform: "linux",
      state: "unsupported_platform",
    });
    expect(await linuxSessions.execute({ operation: "list_apps" }, context)).toMatchObject({
      ok: false,
      code: "unsupported_platform",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  test("respects disabled configuration and UFOO_MAC_ENABLED=0 override", async () => {
    macConfig = { ...macConfig, enabled: false };
    expect(await sessions.execute({ operation: "status" }, context)).toMatchObject({
      ok: true,
      enabled: false,
      state: "disabled",
    });
    expect(await sessions.execute({ operation: "click", x: 100, y: 100 }, context)).toMatchObject({
      ok: false,
      code: "mac_disabled",
    });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  test("assigns @eN refs on snapshot, truncates huge UI trees to outputPath, and executes ax_action", async () => {
    const snap = await sessions.execute({ operation: "snapshot", app: "Calculator" }, context);
    expect(snap).toMatchObject({
      ok: true,
      app: "Calculator",
      pid: 777,
      elementCount: 2,
    });
    expect(snap.text).toContain("@e2 [AXButton] \"7\"");

    const axRes = await sessions.execute({ operation: "ax_action", ref: "@e2", axAction: "press" }, context);
    expect(axRes).toMatchObject({ ok: true, ref: "@e2", axAction: "press", role: "AXButton" });
    expect(rpcMock).toHaveBeenCalledWith(
      "ax_action",
      expect.objectContaining({ pid: 777, axPath: [4], expectedRole: "AXButton", axAction: "press" }),
      expect.any(Object),
    );

    expect(await sessions.execute({ operation: "ax_action", ref: "@e99" }, context)).toMatchObject({
      ok: false,
      code: "unknown_element_ref",
    });

    // Large UI tree writes full snapshot to outputPath
    const manyElements = Array.from({ length: 180 }, (_, idx) => ({
      role: "AXButton",
      depth: 2,
      rootKind: "window",
      rootIndex: 0,
      windowId: 301,
      axPath: [idx],
      title: `Action Button Number ${idx} with long descriptive title`,
      enabled: true,
      focused: false,
      frame: { x: 10, y: idx * 20, width: 200, height: 24 },
      center: { x: 110, y: idx * 20 + 12 },
      actions: ["AXPress"],
    }));
    rpcMock.mockResolvedValueOnce({
      ok: true,
      result: { app: "Xcode", bundleId: "com.apple.dt.Xcode", pid: 900, truncated: true, elements: manyElements },
    });
    const bigSnap = await sessions.execute({ operation: "snapshot", app: "Xcode" }, context);
    expect(bigSnap).toMatchObject({ ok: true, textTruncated: true });
    expect(fs.existsSync(bigSnap.outputPath)).toBe(true);
    expect(fs.readFileSync(bigSnap.outputPath, "utf8")).toContain("@e180 [AXButton]");
  });

  test("attaches screenshots through shared vision blocks and maps screenshotId coordinates to live window bounds", async () => {
    const shot = await sessions.execute({ operation: "screenshot", app: "Calculator" }, context);
    expect(shot).toMatchObject({
      ok: true,
      kind: "image",
      screenshotId: "s1",
      coordinateSpace: "window",
      mediaType: "image/png",
      base64: TINY_PNG.toString("base64"),
    });
    expect(fs.existsSync(shot.path)).toBe(true);

    for (const factory of [createOpenAiChatTransport, createOpenAiResponsesTransport, createAnthropicMessagesTransport]) {
      const transport = factory({
        resolveUrl: () => "test://mac",
        runTurn: async () => ({}),
        toJsonString: JSON.stringify,
        clipText: (value) => value,
      });
      const messages = [];
      const collected = [];
      transport.appendToolResult({
        messages,
        collected,
        call: { id: "mac-shot", name: "mac_app", source: { id: "mac-shot" } },
        toolResult: shot,
      });
      expect(JSON.stringify([...messages, ...collected])).toContain(TINY_PNG.toString("base64"));
    }

    // Window moved from (200, 120) at capture time to (210, 130) in live list_windows;
    // clicking image (50, 60) with screenshotId="s1" lands on (260, 190)!
    const clicked = await sessions.execute({
      operation: "click",
      screenshotId: "s1",
      x: 50,
      y: 60,
    }, context);
    expect(clicked).toMatchObject({
      ok: true,
      x: 260,
      y: 190,
      button: "left",
      clickCount: 1,
      resolvedFrom: "screenshot:s1",
    });
    expect(leaseMock).toHaveBeenCalledTimes(1);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  test("resolves @eN ref coordinates for Agent Mouse clicks and drags", async () => {
    await sessions.execute({ operation: "snapshot", app: "Calculator" }, context);
    const clicked = await sessions.execute({ operation: "double_click", ref: "@e2" }, context);
    expect(clicked).toMatchObject({
      ok: true,
      x: 254,
      y: 304,
      clickCount: 2,
      resolvedFrom: "@e2",
    });
    const dragged = await sessions.execute({
      operation: "drag",
      fromRef: "@e2",
      toX: 400,
      toY: 420,
    }, context);
    expect(dragged).toMatchObject({
      ok: true,
      from: { x: 254, y: 304 },
      to: { x: 400, y: 420 },
    });
  });

  test("independent mouse operations preserve the referenced target without activating it", async () => {
    await sessions.execute({ operation: "snapshot", app: "Calculator" }, context);
    rpcMock.mockClear();
    for (const operation of ["move", "click", "scroll"]) {
      await sessions.execute({ operation, ref: "@e2" }, context);
      const [method, params] = rpcMock.mock.calls.at(-1);
      expect(method).toBe(`mouse_${operation}`);
      expect(params).toMatchObject({ pid: 777, windowId: 301, x: 254, y: 304 });
      expect(params.sessionId).toEqual(expect.any(String));
      if (operation === "click") expect(params.focusFirst).toBe(false);
    }
    await sessions.execute({ operation: "drag", fromRef: "@e2", toX: 300, toY: 330 }, context);
    expect(rpcMock.mock.calls.at(-1)).toEqual([
      "mouse_drag", expect.objectContaining({ pid: 777, windowId: 301 }), expect.any(Object),
    ]);
    expect(rpcMock.mock.calls.some(([method]) => method === "focus_app")).toBe(false);
  });

  test("keyboard input reuses this session's target and only focuses when explicitly requested", async () => {
    await sessions.execute({ operation: "snapshot", app: "Calculator" }, context);
    rpcMock.mockClear();
    await sessions.execute({ operation: "type", text: "hello" }, context);
    expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(["key_type"]);
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ pid: 777, windowId: 301 });
    rpcMock.mockClear();
    await sessions.execute({ operation: "press_key", key: "return", app: "Notes" }, context);
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ app: "Notes", pid: 0, windowId: 0 });
    rpcMock.mockClear();
    await sessions.execute({ operation: "type", text: "hello" }, { ...context, sessionId: "another-session" });
    expect(rpcMock.mock.calls[0][1].pid).toBeUndefined();
    expect(rpcMock.mock.calls[0][1].windowId).toBeUndefined();
  });

  test("explicit focus keeps its window for subsequent input, and release clears it", async () => {
    rpcMock.mockResolvedValueOnce({ ok: true, result: { pid: 777, name: "Calculator", windows: [{ windowId: 301 }] } });
    await sessions.execute({ operation: "focus_app", pid: 777, windowId: 302 }, context);
    rpcMock.mockClear();
    await sessions.execute({ operation: "press_key", key: "return" }, context);
    expect(rpcMock.mock.calls[0][1]).toMatchObject({ pid: 777, windowId: 302 });
    await sessions.execute({ operation: "release" }, context);
    rpcMock.mockClear();
    await sessions.execute({ operation: "type", text: "hello" }, context);
    expect(rpcMock.mock.calls[0][1].pid).toBeUndefined();
    expect(rpcMock.mock.calls[0][1].windowId).toBeUndefined();
  });

  test("surfaces human mouse/Esc takeover and uncertain transport errors without replaying actions", async () => {
    rpcMock.mockResolvedValueOnce({
      ok: false,
      code: "user_takeover",
      reason: "user_mouse_moved",
      error: "Agent yielded control (user_mouse_moved): User moved physical mouse (82pt).",
    });
    const yielded = await sessions.execute({ operation: "click", x: 300, y: 300 }, context);
    expect(yielded).toMatchObject({
      ok: false,
      code: "user_takeover",
      reason: "user_mouse_moved",
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][1].turnScope).toBe("req-turn-1");

    const resumed = await sessions.execute({ operation: "resume_control" }, context);
    expect(resumed).toMatchObject({ ok: true });

    rpcMock.mockRejectedValueOnce(Object.assign(new Error("socket dropped mid-click"), { code: "mac_action_uncertain" }));
    const uncertain = await sessions.execute({ operation: "click", x: 300, y: 300 }, context);
    expect(uncertain).toMatchObject({ ok: false, code: "mac_action_uncertain" });
  });

  test.each(["type", "press_key"])("%s stops when target focus fails and releases the input lease", async (operation) => {
    rpcMock.mockResolvedValueOnce({ ok: false, code: "stale_element_ref", error: "Target window closed" });
    const result = await sessions.execute({ operation, focusApp: true, pid: 777, windowId: 301, text: "hello", key: "cmd+s" }, context);
    expect(result).toMatchObject({ ok: false, code: "stale_element_ref" });
    expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(["focus_app"]);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  test.each(["type", "press_key"])("%s does not send input after an uncertain focus outcome", async (operation) => {
    rpcMock.mockRejectedValueOnce(Object.assign(new Error("Connection lost during focus"), { code: "mac_action_uncertain" }));
    const result = await sessions.execute({ operation, focusApp: true, app: "Calculator", text: "hello", key: "cmd+s" }, context);
    expect(result).toMatchObject({ ok: false, code: "mac_action_uncertain" });
    expect(rpcMock.mock.calls.map(([method]) => method)).toEqual(["focus_app"]);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  test.each([["type", "key_type"], ["press_key", "key_press"]])("%s sends input after successful focus", async (operation, method) => {
    const result = await sessions.execute({ operation, focusApp: true, app: "Calculator", text: "hello", key: "cmd+s" }, context);
    expect(result.ok).toBe(true);
    expect(rpcMock.mock.calls.map(([name]) => name)).toEqual(["focus_app", method]);
  });

  test("plan mode permits inspection and blocks state-mutating Mac actions", async () => {
    const planContext = { ...context, executionState: { planMode: true } };
    expect(await sessions.execute({ operation: "click", x: 100, y: 100 }, planContext)).toMatchObject({
      ok: false,
      code: "plan_mode",
    });
    expect(await sessions.execute({ operation: "type", text: "hello" }, planContext)).toMatchObject({
      ok: false,
      code: "plan_mode",
    });
    expect(await sessions.execute({ operation: "launch_app", app: "Notes" }, planContext)).toMatchObject({
      ok: false,
      code: "plan_mode",
    });
    expect(rpcMock).not.toHaveBeenCalled();

    expect(await sessions.execute({ operation: "snapshot", app: "Calculator" }, planContext)).toMatchObject({
      ok: true,
    });
    expect(await sessions.execute({ operation: "screenshot", app: "Calculator" }, planContext)).toMatchObject({
      ok: true,
      kind: "image",
    });
  });

  test("gates capability with mac.control, strips base64 from UI events, and hides HUD on dispose", async () => {
    const capability = createMacCapability({ sessions });
    expect(() => createToolRegistry({ tools: capability.tools, grantedPermissions: [] })).toThrow("mac.control");
    const registry = createToolRegistry({ tools: capability.tools, grantedPermissions: ["mac.control"] });

    const events = [];
    const res = await registry.execute(
      "mac_app",
      { operation: "screenshot", app: "Calculator" },
      { ...context, onToolEvent: (ev) => events.push(ev) },
    );
    expect(res.ok).toBe(true);
    expect(res.base64).toBe(TINY_PNG.toString("base64"));
    expect(events.map((e) => e.phase)).toEqual(["start", "end"]);
    expect(events[1].result.base64).toBeUndefined();

    await capability.dispose();
    expect(rpcMock).toHaveBeenCalledWith("hide_hud", expect.any(Object), expect.any(Object));
  });
});
