"use strict";

const { startBusBridge } = require("../../../src/runtime/daemon");

describe("daemon bus bridge", () => {
  test("contains subscriber join failures even when diagnostics also fail", async () => {
    const joinError = Object.assign(new Error("project directory disappeared"), {
      code: "ENOENT",
    });
    const eventBus = {
      join: jest.fn(async () => {
        throw joinError;
      }),
    };
    const onJoinError = jest.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const bridge = startBusBridge(
      "/tmp/ufoo-deleted-project",
      "codex-cli",
      () => {},
      () => {},
      () => false,
      null,
      { eventBus, onJoinError }
    );

    try {
      await expect(bridge.refresh()).resolves.toBeUndefined();
      await expect(bridge.refresh()).resolves.toBeUndefined();
      expect(eventBus.join).toHaveBeenCalledTimes(2);
      expect(onJoinError).toHaveBeenCalledTimes(1);
      expect(bridge.getSubscriber()).toBeNull();
    } finally {
      bridge.stop();
    }
  });
});
