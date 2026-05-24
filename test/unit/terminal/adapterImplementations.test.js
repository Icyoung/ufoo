const { createTerminalAdapter } = require("../../../src/runtime/terminal/adapters/terminalAdapter");
const { createTmuxAdapter } = require("../../../src/runtime/terminal/adapters/tmuxAdapter");
const { createInternalQueueAdapter } = require("../../../src/runtime/terminal/adapters/internalQueueAdapter");

function createAdapter({ capabilities, handlers = {} }) {
  return {
    capabilities,
    connect: handlers.connect || (async () => false),
    disconnect: handlers.disconnect || (async () => false),
    send: handlers.send || (() => false),
    sendRaw: handlers.sendRaw || (() => false),
    resize: handlers.resize || (() => false),
    snapshot: handlers.snapshot || (() => false),
    subscribe: handlers.subscribe || (() => false),
    activate: handlers.activate || (() => false),
    getState: handlers.getState || (() => ({})),
  };
}

describe("terminal adapters", () => {
  test("terminalAdapter exposes activate and replay capabilities", () => {
    const activateAgent = jest.fn();
    const adapter = createTerminalAdapter({
      agentId: "agent:1",
      activateAgent,
      createAdapter,
    });

    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsReplay).toBe(true);
    expect(adapter.capabilities.supportsWindowClose).toBe(true);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);
    expect(adapter.capabilities.supportsSessionReuse).toBe(true);
    expect(adapter.capabilities.supportsSocketProtocol).toBe(false);

    expect(adapter.activate()).toBe(true);
    expect(activateAgent).toHaveBeenCalledWith("agent:1");
    expect(adapter.sendRaw("x")).toBe(false);
    expect(adapter.resize(80, 24)).toBe(false);
  });

  test("tmuxAdapter exposes activate without replay capability", () => {
    const activateAgent = jest.fn();
    const adapter = createTmuxAdapter({
      agentId: "agent:2",
      activateAgent,
      createAdapter,
    });

    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsReplay).toBe(false);
    expect(adapter.capabilities.supportsWindowClose).toBe(false);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);
    expect(adapter.capabilities.supportsSessionReuse).toBe(true);

    expect(adapter.activate()).toBe(true);
    expect(activateAgent).toHaveBeenCalledWith("agent:2");
    expect(adapter.sendRaw("x")).toBe(false);
  });

  test("internalQueueAdapter only supports send", () => {
    const sendRaw = jest.fn();
    const sendResize = jest.fn();
    const requestSnapshot = jest.fn(() => true);
    const adapter = createInternalQueueAdapter({
      sendRaw,
      sendResize,
      requestSnapshot,
      createAdapter,
    });

    expect(adapter.capabilities.supportsSocketProtocol).toBe(false);
    expect(adapter.capabilities.supportsSnapshot).toBe(false);

    expect(adapter.send("ping")).toBe(true);
    expect(adapter.sendRaw("pong")).toBe(true);
    expect(sendRaw).toHaveBeenCalledWith("ping");
    expect(sendRaw).toHaveBeenCalledWith("pong");

    expect(adapter.resize(100, 30)).toBe(false);
    expect(adapter.snapshot()).toBe(false);
    expect(adapter.subscribe()).toBe(false);
    expect(sendResize).not.toHaveBeenCalled();
    expect(requestSnapshot).not.toHaveBeenCalled();
  });
});
