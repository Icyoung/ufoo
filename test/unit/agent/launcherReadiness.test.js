"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/agents/launch/ptyWrapper");
jest.mock("../../../src/agents/launch/notifier");
jest.mock("net", () => ({
  createConnection: jest.fn((_path, connected) => {
    const socket = new (require("events"))();
    socket.write = jest.fn();
    socket.end = jest.fn();
    Promise.resolve().then(connected);
    return socket;
  }),
  createServer: jest.fn(() => {
    const server = new (require("events"))();
    server.listen = jest.fn();
    server.close = jest.fn();
    return server;
  }),
}));

const AgentLauncher = require("../../../src/agents/launch/launcher");
const PtyWrapper = require("../../../src/agents/launch/ptyWrapper");
const AgentNotifier = require("../../../src/agents/launch/notifier");
const { setLauncherReady, isLauncherReady } = require("../../../src/agents/launch/launcherReadiness");
const net = require("net");

describe("native ucode wrapper readiness", () => {
  let root, file, wrapper, launcher, env, signalListeners;
  const subscriber = "ucode:ready-test";

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    env = { ...process.env };
    signalListeners = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, process.listeners(signal)]));
    process.env.UFOO_FORCE_PTY = "1";
    delete process.env.UFOO_DEBUG;
    process.env.UFOO_STARTUP_BOOTSTRAP_TEXT = "Session bootstrap for Codex (inherited from the parent).";
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ready-"));
    file = path.join(root, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A resumed registration may still have a previous launch's ready bit.
    fs.writeFileSync(file, JSON.stringify({ agents: {
      [subscriber]: { agent_type: "ucode", status: "active", launcher_ready: true },
      "codex:other": { agent_type: "codex", status: "active", launcher_ready: true },
    } }));
    wrapper = {
      pty: { pid: 12345 },
      enableLogging: jest.fn(), writeLogEntry: jest.fn(), spawn: jest.fn(),
      attachStreams: jest.fn(), write: jest.fn(), cleanup: jest.fn(),
      enableMonitoring: jest.fn(callback => { wrapper.monitor = { onOutput: callback }; }),
    };
    PtyWrapper.mockImplementation(() => wrapper);
    launcher = new AgentLauncher("ucode", "/some/node");
    launcher.cwd = root;
    launcher.ensureInit = jest.fn();
    launcher.ensureDaemon = jest.fn().mockResolvedValue("running");
    launcher.getPreRegistered = jest.fn().mockResolvedValue({ subscriberId: subscriber });
    launcher._spawnDirect = jest.fn();
    await launcher.launch([]);
    expect(launcher._spawnDirect).not.toHaveBeenCalled();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    for (const [signal, existing] of signalListeners) {
      for (const listener of process.listeners(signal)) {
        if (!existing.includes(listener)) process.removeListener(signal, listener);
      }
    }
    process.env = env;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("uses native host confirmation without injecting the parent's bootstrap", async () => {
    expect(isLauncherReady(root, subscriber)).toBe(false);
    expect(isLauncherReady(root, "codex:other")).toBe(true);
    expect(AgentNotifier).not.toHaveBeenCalled();
    wrapper.monitor.onOutput("┌─ ucode ───────┐\n│ loading     │\n└─────────────┘");
    await jest.advanceTimersByTimeAsync(2000);
    expect(net.createConnection).not.toHaveBeenCalled();
    expect(setLauncherReady(root, subscriber, true)).toBe(true);
    await jest.advanceTimersByTimeAsync(2000);
    expect(net.createConnection).toHaveBeenCalledTimes(1);
    const socket = net.createConnection.mock.results[0].value;
    expect(JSON.parse(socket.write.mock.calls[0][0])).toMatchObject({
      type: "agent_ready", subscriberId: subscriber, agentPid: 12345,
    });
    await jest.advanceTimersByTimeAsync(600000);
    expect(net.createConnection).toHaveBeenCalledTimes(1);
    expect(wrapper.writeLogEntry).not.toHaveBeenCalled();
    expect(wrapper.write).not.toHaveBeenCalled();
  });

  test("waits ten minutes before logging slow startup, without writing or injecting into the TUI", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await jest.advanceTimersByTimeAsync(10000);
      expect(error).not.toHaveBeenCalled();
      expect(wrapper.writeLogEntry).not.toHaveBeenCalled();
      expect(net.createConnection).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(589999);
      expect(wrapper.writeLogEntry).not.toHaveBeenCalled();
      expect(isLauncherReady(root, subscriber)).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(error).not.toHaveBeenCalled();
      expect(wrapper.writeLogEntry).toHaveBeenCalledWith(expect.objectContaining({
        dir: "diagnostic", event: "startup.waiting", agent_type: "ucode",
        text: "Waiting for ucode to become ready; queued work is retained.",
      }));
      expect(isLauncherReady(root, subscriber)).toBe(false);
      expect(net.createConnection).not.toHaveBeenCalled();
      expect(wrapper.write).not.toHaveBeenCalled();
      setLauncherReady(root, subscriber, true);
      await jest.advanceTimersByTimeAsync(2000);
      expect(net.createConnection).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});
