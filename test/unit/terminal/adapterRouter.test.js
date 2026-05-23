const { createTerminalAdapterRouter } = require("../../../src/terminal/adapterRouter");
const { TERMINAL_CAPABILITY_KEYS } = require("../../../src/terminal/adapterContract");

describe("terminal/adapterRouter", () => {

  test("internal adapter capabilities", () => {
    const router = createTerminalAdapterRouter();
    const internal = router.getAdapter({ launchMode: "internal", agentId: "agent:1" });

    expect(internal.capabilities.supportsInternalQueueLoop).toBe(true);
    expect(internal.capabilities.supportsSocketProtocol).toBe(false);
    expect(internal.capabilities.supportsSnapshot).toBe(false);
    expect(internal.capabilities.supportsSubscribeFull).toBe(false);
    expect(internal.capabilities.supportsSubscribeScreen).toBe(false);
  });

  test("terminal and tmux differ only in replay and window-close capability", () => {
    const router = createTerminalAdapterRouter();
    const terminal = router.getAdapter({ launchMode: "terminal", agentId: "agent:1" });
    const tmux = router.getAdapter({ launchMode: "tmux", agentId: "agent:2" });

    for (const key of TERMINAL_CAPABILITY_KEYS) {
      if (key === "supportsReplay" || key === "supportsWindowClose") {
        expect(terminal.capabilities[key]).toBe(true);
        expect(tmux.capabilities[key]).toBe(false);
      } else {
        expect(terminal.capabilities[key]).toBe(tmux.capabilities[key]);
      }
    }
  });

  test("maps launchMode to capability set", () => {
    const router = createTerminalAdapterRouter();

    const terminal = router.getAdapter({ launchMode: "terminal", agentId: "agent:1" });
    expect(Object.keys(terminal.capabilities).sort()).toEqual([...TERMINAL_CAPABILITY_KEYS].sort());
    expect(terminal.capabilities.supportsActivate).toBe(true);
    expect(terminal.capabilities.supportsReplay).toBe(true);
    expect(terminal.capabilities.supportsWindowClose).toBe(true);
    expect(terminal.capabilities.supportsNotifierInjector).toBe(true);
    expect(terminal.capabilities.supportsSessionReuse).toBe(true);
    expect(terminal.capabilities.supportsSocketProtocol).toBe(false);

    const tmux = router.getAdapter({ launchMode: "tmux", agentId: "agent:2" });
    expect(tmux.capabilities.supportsActivate).toBe(true);
    expect(tmux.capabilities.supportsReplay).toBe(false);
    expect(tmux.capabilities.supportsWindowClose).toBe(false);
    expect(tmux.capabilities.supportsNotifierInjector).toBe(true);
    expect(tmux.capabilities.supportsSessionReuse).toBe(true);

    const internal = router.getAdapter({ launchMode: "internal", agentId: "agent:3" });
    expect(internal.capabilities.supportsInternalQueueLoop).toBe(true);
    expect(internal.capabilities.supportsSocketProtocol).toBe(false);
    expect(internal.capabilities.supportsSnapshot).toBe(false);

    const unknown = router.getAdapter({ launchMode: "unknown", agentId: "agent:5" });
    for (const key of TERMINAL_CAPABILITY_KEYS) {
      expect(unknown.capabilities[key]).toBe(false);
    }
  });
  test("router wires terminal and tmux activate handlers separately", () => {
    const activateTerminal = jest.fn();
    const activateTmux = jest.fn();
    const router = createTerminalAdapterRouter({ activateTerminal, activateTmux });

    const terminalAdapter = router.getAdapter({ launchMode: "terminal", agentId: "agent:1" });
    const tmuxAdapter = router.getAdapter({ launchMode: "tmux", agentId: "agent:2" });

    expect(terminalAdapter.activate()).toBe(true);
    expect(tmuxAdapter.activate()).toBe(true);

    expect(activateTerminal).toHaveBeenCalledWith("agent:1");
    expect(activateTmux).toHaveBeenCalledWith("agent:2");
  });

  test("terminal adapter supports activate and delegates to activateAgent", () => {
    const activateAgent = jest.fn();
    const router = createTerminalAdapterRouter({ activateAgent });

    const adapter = router.getAdapter({ launchMode: "terminal", agentId: "agent:1" });
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsSocketProtocol).toBe(false);

    const result = adapter.activate();
    expect(result).toBe(true);
    expect(activateAgent).toHaveBeenCalledWith("agent:1");
    expect(adapter.sendRaw("x")).toBe(false);
  });

  test("internal adapter routes send but not resize/snapshot", () => {
    const sendRaw = jest.fn();
    const sendResize = jest.fn();
    const requestSnapshot = jest.fn(() => true);
    const router = createTerminalAdapterRouter({ sendRaw, sendResize, requestSnapshot });

    const adapter = router.getAdapter({ launchMode: "internal", agentId: "agent:2" });
    expect(adapter.capabilities.supportsInternalQueueLoop).toBe(true);
    expect(adapter.capabilities.supportsSocketProtocol).toBe(false);

    expect(adapter.sendRaw("ping")).toBe(true);
    expect(sendRaw).toHaveBeenCalledWith("ping");

    expect(adapter.resize(80, 24)).toBe(false);
    expect(sendResize).not.toHaveBeenCalled();
  });

  test("internal adapter does not support snapshot or resize", () => {
    const sendRaw = jest.fn();
    const sendResize = jest.fn();
    const requestSnapshot = jest.fn(() => true);
    const router = createTerminalAdapterRouter({ sendRaw, sendResize, requestSnapshot });

    const adapter = router.getAdapter({ launchMode: "internal", agentId: "agent:3" });
    expect(adapter.capabilities.supportsInternalQueueLoop).toBe(true);
    expect(adapter.capabilities.supportsSocketProtocol).toBe(false);

    expect(adapter.sendRaw("ping")).toBe(true);
    expect(sendRaw).toHaveBeenCalledWith("ping");

    expect(adapter.resize(80, 24)).toBe(false);
    expect(sendResize).not.toHaveBeenCalled();

    expect(adapter.snapshot()).toBe(false);
    expect(requestSnapshot).not.toHaveBeenCalled();
  });
});
