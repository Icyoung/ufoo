"use strict";

const { executeControllerTool } = require("../../../src/agent/controllerToolExecutor");

describe("controllerToolExecutor", () => {
  test("dispatch_message uses shared handler semantics with controller hooks", async () => {
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const markPending = jest.fn();

    const result = await executeControllerTool({
      projectRoot: "/tmp/project",
      subscriber: "ufoo-agent",
      dispatchMessages,
      markPending,
      observer: { emit: jest.fn(), audit: jest.fn() },
    }, {
      id: "tool-1",
      name: "dispatch_message",
      arguments: {
        target: "codex:1",
        message: "handle it",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      result: {
        dispatched: 1,
        target: "codex:1",
        injection_mode: "immediate",
        source: "ufoo-agent",
      },
    }));
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [{
      target: "codex:1",
      message: "handle it",
      injection_mode: "immediate",
      source: "ufoo-agent",
    }]);
    expect(markPending).toHaveBeenCalledWith("codex:1");
  });

  test("dispatch_message returns shared forbidden_source error", async () => {
    const result = await executeControllerTool({
      projectRoot: "/tmp/project",
      subscriber: "ufoo-agent",
      dispatchMessages: jest.fn(),
      observer: { emit: jest.fn(), audit: jest.fn() },
    }, {
      id: "tool-2",
      name: "dispatch_message",
      arguments: {
        target: "codex:1",
        message: "handle it",
        source: "codex:other",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "forbidden_source",
        message: "dispatch_message source must match caller subscriber",
      }),
    }));
  });

  test("dispatch_message returns invalid_target under dispatchMessages hook path", async () => {
    const result = await executeControllerTool({
      projectRoot: "/tmp/project",
      subscriber: "ufoo-agent",
      dispatchMessages: jest.fn().mockResolvedValue(undefined),
      observer: { emit: jest.fn(), audit: jest.fn() },
    }, {
      id: "tool-ghost",
      name: "dispatch_message",
      arguments: {
        target: "ghost-queue",
        message: "hello",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_target",
        message: "dispatch_message target not found: ghost-queue",
      }),
    }));
  });

  test("ack_bus uses shared handler semantics with controller hook", async () => {
    const ackBus = jest.fn().mockResolvedValue(undefined);

    const result = await executeControllerTool({
      projectRoot: "/tmp/project",
      subscriber: "ufoo-agent",
      ackBus,
      observer: { emit: jest.fn(), audit: jest.fn() },
    }, {
      id: "tool-3",
      name: "ack_bus",
      arguments: {},
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      result: {
        acknowledged: true,
        subscriber: "ufoo-agent",
      },
    }));
    expect(ackBus).toHaveBeenCalledWith("/tmp/project", "ufoo-agent");
  });

  test("ack_bus returns shared forbidden_ack error", async () => {
    const result = await executeControllerTool({
      projectRoot: "/tmp/project",
      subscriber: "ufoo-agent",
      ackBus: jest.fn(),
      observer: { emit: jest.fn(), audit: jest.fn() },
    }, {
      id: "tool-4",
      name: "ack_bus",
      arguments: {
        subscriber: "codex:other",
      },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "forbidden_ack",
        message: "ack_bus can only acknowledge the caller subscriber queue",
      }),
    }));
  });
});
