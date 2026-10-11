"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChatController } = require("../../../src/app/chat/ChatController");

describe("ChatController", () => {
  test("internal dashboard cannot address external or stale agents through @target", async () => {
    const send = jest.fn();
    const published = jest.fn();
    const controller = createChatController({ ports: { send, publish: published } });
    controller.applyStatus({ active: ["codex:child", "claude:external"], active_meta: [
      { id: "codex:child", nickname: "coder", launch_mode: "internal" },
      { id: "claude:external", nickname: "outside", launch_mode: "terminal" },
    ] });
    expect(controller.session.agents).toEqual(["codex:child"]);
    await controller.submitInput("@outside hello");
    await controller.submitInput("@claude:external hello");
    expect(send).not.toHaveBeenCalled();
    published.mockClear();
    controller.patchAgentActivity("claude:external", { activity_state: "working" });
    expect(controller.session.metaMap.has("claude:external")).toBe(false);
    expect(published).not.toHaveBeenCalled();
    controller.session.targetAgent = "claude:external";
    await controller.submitInput("stale target");
    expect(send).not.toHaveBeenCalled();
    await controller.submitInput("@coder hello");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "bus_send", target: "codex:child" }));
    controller.stop();
  });
  test.each([true, false])("project opening preserves the global-mode restriction (%s)", async (globalMode) => {
    const switchProject = jest.fn(async () => ({ ok: true, project_root: "/tmp/ufoo-project" }));
    const logMessage = jest.fn();
    const controller = createChatController({ globalMode, ports: { switchProject, logMessage, appendHistory: () => {} } });
    try {
      await controller.submitInput("/open /tmp/ufoo-project");
      if (globalMode) {
        expect(switchProject).toHaveBeenCalledWith({ target: "/tmp/ufoo-project" });
      } else {
        expect(switchProject).not.toHaveBeenCalled();
        expect(logMessage).toHaveBeenCalledWith("error", expect.stringContaining("only available in global mode"));
      }
    } finally { controller.stop(); }
  });
  test("constructor send port gives runtime commands stable identity and honors a new conversation", async () => {
    const send = jest.fn();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-controller-session-"));
    const controller = createChatController({ projectRoot: root, ports: { send, appendHistory: () => {}, logMessage: () => {} } });
    try {
      await controller.submitInput("/answer question-1 choose the first");
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "resume", interaction_id: "question-1", answer: "choose the first", session_id: "main-default", request_id: expect.any(String) }));
      await controller.submitInput("/session new");
      await controller.submitInput("/task cancel child-1");
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "cancel", task_run_id: "child-1", session_id: expect.stringMatching(/^main-/), request_id: expect.any(String) }));
      expect(send.mock.calls[1][0].session_id).not.toBe("main-default");
      expect(require("../../../src/config").loadConfig(root).agentConversationId).toBe(send.mock.calls[1][0].session_id);
      const reopened = createChatController({ projectRoot: root, ports: { send } });
      try {
        await reopened.submitInput("/task cancel child-2");
        expect(send.mock.calls[2][0].session_id).toBe(send.mock.calls[1][0].session_id);
      } finally { reopened.stop(); }
    } finally {
      controller.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
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
        id: "codex:architect", launch_mode: "internal",
        nickname: "architect",
        display_nickname: "architect",
        activity_state: "working",
      }],
    });
    expect(snapshot.footer).toContain("*architect");
    expect(published.some((item) => item.name === "agents.snapshot")).toBe(true);
    expect(controller.getAgentsFooter()).toContain("architect");
  });

});
