"use strict";

const { createChatController } = require("../../../src/app/chat/ChatController");

describe("ChatController", () => {
  test("start/stop owns stream state and status throttle hook", () => {
    const dispatches = [];
    let statusCalls = 0;
    const controller = createChatController({
      projectRoot: process.cwd(),
      ports: {
        dispatch: (action) => dispatches.push(action),
      },
    });
    controller.start({
      sendStatus: () => {
        statusCalls += 1;
      },
      statusIntervalMs: 50,
    });
    expect(controller.getStreamState()).toBeTruthy();
    controller.requestDaemonStatus();
    expect(statusCalls).toBeGreaterThanOrEqual(1);
    controller.getStreamState().beginStream("codex:1", "architect · ");
    controller.getStreamState().appendStreamDelta(
      controller.getStreamState().beginStream("codex:1"),
      "hi",
    );
    controller.getStreamState().flushDeltas();
    expect(dispatches.some((item) => item.type === "stream/begin")).toBe(true);
    expect(dispatches.some((item) => item.type === "stream/delta")).toBe(true);
    controller.stop();
    expect(controller.getStreamState()).toBeTruthy();
  });

  test("applyStatus publishes agents.snapshot with footer", () => {
    const published = [];
    const controller = createChatController({
      projectRoot: process.cwd(),
      ports: {
        publish: (name, payload) => published.push({ name, payload }),
      },
    });
    const snapshot = controller.applyStatus({
      active: ["codex:architect"],
      active_meta: [{
        id: "codex:architect",
        nickname: "architect",
        display_nickname: "architect",
        activity_state: "working",
      }],
    });
    expect(snapshot.footer).toContain("*architect");
    expect(published.some((item) => item.name === "agents.snapshot")).toBe(true);
    expect(controller.getAgentsFooter()).toContain("architect");
  });

  test("mapAgentsForDispatch can reshape agents for Ink", () => {
    const { toInkAgentsDispatchList } = require("../../../src/app/chat/agentDirectory");
    const dispatches = [];
    const controller = createChatController({
      projectRoot: process.cwd(),
      ports: {
        dispatch: (action) => dispatches.push(action),
        mapAgentsForDispatch: toInkAgentsDispatchList,
      },
    });
    controller.applyStatus({
      active: ["codex:architect"],
      active_meta: [{
        id: "codex:architect",
        nickname: "architect",
        display_nickname: "architect",
      }],
    });
    const set = dispatches.find((item) => item.type === "agents/set");
    expect(set.list[0].fullId).toBe("codex:architect");
    expect(set.list[0].nickname).toBe("architect");
    expect(set.list[0].label).toBe("architect");
  });
});
