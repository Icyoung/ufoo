const fs = require("fs");
const os = require("os");
const path = require("path");

const { saveConfig } = require("../../../src/config");
const {
  CONTROLLER_MODES,
  applyControllerModeForMessage,
  getAppliedControllerMode,
  getControllerModeHistoryForTests,
  readProcessControllerMode,
  resetAppliedControllerModesForTests,
  resolveControllerMode,
  rollbackControllerModeForMessage,
} = require("../../../src/controller/flags");

describe("controller flags", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-controller-flags-"));
    resetAppliedControllerModesForTests();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("exports the supported controller modes", () => {
    expect(CONTROLLER_MODES).toEqual({
      LEGACY: "legacy",
      SHADOW: "shadow",
      MAIN: "main",
      LOOP: "loop",
    });
  });

  test("reads process-scoped controller mode", () => {
    expect(readProcessControllerMode({ UFOO_CONTROLLER_MODE: "shadow" })).toBe("shadow");
    expect(readProcessControllerMode({ UFOO_CONTROLLER_MODE: "invalid" })).toBe("main");
  });

  test("resolveControllerMode defaults to main", () => {
    expect(resolveControllerMode({ env: {} })).toBe("main");
  });

  test("resolveControllerMode prefers user override over project and process", () => {
    saveConfig(projectRoot, { controllerMode: "shadow" });

    const mode = resolveControllerMode({
      projectRoot,
      requestedMode: "loop",
      env: { UFOO_CONTROLLER_MODE: "main" },
    });

    expect(mode).toBe("loop");
  });

  test("resolveControllerMode falls back to project config before process env", () => {
    saveConfig(projectRoot, { controllerMode: "main" });

    const mode = resolveControllerMode({
      projectRoot,
      env: { UFOO_CONTROLLER_MODE: "shadow" },
    });

    expect(mode).toBe("main");
  });

  test("resolveControllerMode uses process env when no narrower override exists", () => {
    const mode = resolveControllerMode({
      projectRoot,
      env: { UFOO_CONTROLLER_MODE: "shadow" },
    });

    expect(mode).toBe("shadow");
  });

  test("applyControllerModeForMessage only emits transitions when mode changes on a later message", () => {
    expect(applyControllerModeForMessage({
      projectRoot,
      nextMode: CONTROLLER_MODES.MAIN,
      messageId: "msg-1",
    })).toEqual({
      mode: CONTROLLER_MODES.MAIN,
      transition: null,
    });

    expect(applyControllerModeForMessage({
      projectRoot,
      nextMode: CONTROLLER_MODES.SHADOW,
      messageId: "msg-2",
    })).toEqual({
      mode: CONTROLLER_MODES.SHADOW,
      transition: {
        from_mode: CONTROLLER_MODES.MAIN,
        to_mode: CONTROLLER_MODES.SHADOW,
        applied_from_msg_id: "msg-2",
      },
    });

    expect(applyControllerModeForMessage({
      projectRoot,
      nextMode: CONTROLLER_MODES.SHADOW,
      messageId: "msg-3",
    })).toEqual({
      mode: CONTROLLER_MODES.SHADOW,
      transition: null,
    });
  });

  test("rollbackControllerModeForMessage reverts to the previous applied tier", () => {
    applyControllerModeForMessage({
      projectRoot,
      nextMode: CONTROLLER_MODES.MAIN,
      messageId: "msg-a",
    });
    applyControllerModeForMessage({
      projectRoot,
      nextMode: CONTROLLER_MODES.SHADOW,
      messageId: "msg-b",
    });
    applyControllerModeForMessage({
      projectRoot,
      nextMode: CONTROLLER_MODES.LOOP,
      messageId: "msg-c",
    });

    const history = getControllerModeHistoryForTests(projectRoot);
    expect(history).toEqual([
      { from_mode: CONTROLLER_MODES.MAIN, to_mode: CONTROLLER_MODES.SHADOW, applied_from_msg_id: "msg-b" },
      { from_mode: CONTROLLER_MODES.SHADOW, to_mode: CONTROLLER_MODES.LOOP, applied_from_msg_id: "msg-c" },
    ]);

    expect(getAppliedControllerMode(projectRoot)).toBe(CONTROLLER_MODES.LOOP);

    const firstRollback = rollbackControllerModeForMessage({ projectRoot, messageId: "msg-d" });
    expect(firstRollback).toEqual({
      mode: CONTROLLER_MODES.SHADOW,
      rolled_back: true,
      transition: {
        from_mode: CONTROLLER_MODES.LOOP,
        to_mode: CONTROLLER_MODES.SHADOW,
        applied_from_msg_id: "msg-d",
        rolled_back: true,
        restored_from_msg_id: "msg-c",
      },
    });
    expect(getAppliedControllerMode(projectRoot)).toBe(CONTROLLER_MODES.SHADOW);

    const secondRollback = rollbackControllerModeForMessage({ projectRoot, messageId: "msg-e" });
    expect(secondRollback).toEqual({
      mode: CONTROLLER_MODES.MAIN,
      rolled_back: true,
      transition: {
        from_mode: CONTROLLER_MODES.SHADOW,
        to_mode: CONTROLLER_MODES.MAIN,
        applied_from_msg_id: "msg-e",
        rolled_back: true,
        restored_from_msg_id: "msg-b",
      },
    });

    const noMoreHistory = rollbackControllerModeForMessage({ projectRoot, messageId: "msg-f" });
    expect(noMoreHistory).toEqual({
      mode: CONTROLLER_MODES.MAIN,
      rolled_back: false,
      transition: null,
    });
  });
});
