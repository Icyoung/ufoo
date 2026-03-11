const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  createHostAdapter,
  createSession,
  COMMAND_TO_CAPABILITY,
  applyHostCapabilities,
  normalizeHostCapabilities,
} = require("../../../src/terminal/adapters/hostAdapter");
const { createTerminalAdapterRouter } = require("../../../src/terminal/adapterRouter");
const {
  TERMINAL_CAPABILITY_KEYS,
  createTerminalCapabilities,
} = require("../../../src/terminal/adapterContract");

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

/**
 * Create a mock Unix socket server that implements the Terminal Host Protocol.
 * Returns { server, sockPath, requests, close }.
 */
function createMockHostSocket(handler) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-host-test-"));
  const sockPath = path.join(tmpDir, "test.sock");
  const requests = [];

  const server = net.createServer((client) => {
    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const req = JSON.parse(line);
          requests.push(req);
          const resp = handler(req);
          client.write(JSON.stringify(resp) + "\n");
        } catch (err) {
          client.write(JSON.stringify({
            v: 1, request_id: "", ok: false,
            error_code: "internal_error", error: err.message,
          }) + "\n");
        }
      }
    });
  });

  server.listen(sockPath);

  return {
    server,
    sockPath,
    requests,
    close: () => {
      return new Promise((resolve) => {
        server.close(() => {
          try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
          try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
          resolve();
        });
      });
    },
  };
}

// --- Unit tests for applyHostCapabilities ---

describe("applyHostCapabilities", () => {
  test("maps known commands to capability flags", () => {
    const caps = createTerminalCapabilities();
    applyHostCapabilities(caps, ["activate", "snapshot", "close_session", "notify"]);

    expect(caps.supportsActivate).toBe(true);
    expect(caps.supportsSnapshot).toBe(true);
    expect(caps.supportsWindowClose).toBe(true);
    expect(caps.supportsNotifierInjector).toBe(true);
    // Unmapped flags remain false
    expect(caps.supportsReplay).toBe(false);
    expect(caps.supportsSubscribeFull).toBe(false);
  });

  test("maps subscribe and subscribe_screen", () => {
    const caps = createTerminalCapabilities();
    applyHostCapabilities(caps, ["subscribe", "subscribe_screen"]);

    expect(caps.supportsSubscribeFull).toBe(true);
    expect(caps.supportsSubscribeScreen).toBe(true);
  });

  test("maps replay", () => {
    const caps = createTerminalCapabilities();
    applyHostCapabilities(caps, ["replay"]);
    expect(caps.supportsReplay).toBe(true);
  });

  test("ignores unknown commands", () => {
    const caps = createTerminalCapabilities();
    applyHostCapabilities(caps, ["inject", "raw", "resize", "unknown_cmd"]);

    // None of the mapped flags should change
    for (const flag of Object.values(COMMAND_TO_CAPABILITY)) {
      expect(caps[flag]).toBe(false);
    }
  });

  test("handles non-array gracefully", () => {
    const caps = createTerminalCapabilities();
    applyHostCapabilities(caps, null);
    applyHostCapabilities(caps, undefined);
    applyHostCapabilities(caps, "activate");
    // Should not throw, flags stay false
    expect(caps.supportsActivate).toBe(false);
  });

  test("all COMMAND_TO_CAPABILITY values are valid capability keys", () => {
    for (const flag of Object.values(COMMAND_TO_CAPABILITY)) {
      expect(TERMINAL_CAPABILITY_KEYS).toContain(flag);
    }
  });
});

describe("normalizeHostCapabilities", () => {
  test("falls back to session_commands when commands are not present", () => {
    const normalized = normalizeHostCapabilities({
      host: "daemon-host",
      session_commands: ["snapshot", "activate"],
    });

    expect(normalized.commands).toEqual(["snapshot", "activate"]);
  });
});

describe("host daemon helpers", () => {
  test("createSession forwards source_session_id when provided", async () => {
    const mock = createMockHostSocket((req) => ({
      v: 1,
      ok: true,
      result: {
        session_id: "NEW123",
        inject_sock: "/tmp/new.sock",
      },
    }));

    try {
      const result = await createSession(mock.sockPath, {
        source_session_id: "SRC456",
      });

      expect(result).toMatchObject({
        session_id: "NEW123",
        inject_sock: "/tmp/new.sock",
      });
      expect(mock.requests[0]).toMatchObject({
        type: "create_session",
        source_session_id: "SRC456",
      });
    } finally {
      await mock.close();
    }
  });
});

// --- Adapter construction tests ---

describe("hostAdapter", () => {
  test("exposes correct base capabilities", () => {
    const adapter = createHostAdapter({ createAdapter });

    expect(adapter.capabilities.supportsSocketProtocol).toBe(true);
    expect(adapter.capabilities.supportsSessionReuse).toBe(true);
    // Dynamic capabilities start false before connect
    expect(adapter.capabilities.supportsActivate).toBe(false);
    expect(adapter.capabilities.supportsSnapshot).toBe(false);
    expect(adapter.capabilities.supportsReplay).toBe(false);
    expect(adapter.capabilities.supportsInternalQueueLoop).toBe(false);

    // All capability keys present
    for (const key of TERMINAL_CAPABILITY_KEYS) {
      expect(key in adapter.capabilities).toBe(true);
    }
  });

  test("router maps launchMode 'host' to hostAdapter", () => {
    const router = createTerminalAdapterRouter();
    const adapter = router.getAdapter({ launchMode: "host", agentId: "agent:1" });

    expect(adapter.capabilities.supportsSocketProtocol).toBe(true);
    expect(adapter.capabilities.supportsSessionReuse).toBe(true);
  });

  test("router seeds host capabilities from metadata", () => {
    const router = createTerminalAdapterRouter();
    const adapter = router.getAdapter({
      launchMode: "host",
      agentId: "agent:1",
      meta: {
        host_inject_sock: "/tmp/seed.sock",
        host_capabilities: {
          host: "seed-host",
          commands: ["snapshot", "activate", "notify"],
        },
      },
    });

    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);
    expect(adapter.getState().injectSock).toBe("/tmp/seed.sock");
  });

  test("send/sendRaw/resize return false when UFOO_HOST_INJECT_SOCK is not set", () => {
    const originalSock = process.env.UFOO_HOST_INJECT_SOCK;
    const originalHorizon = process.env.HORIZON_INJECT_SOCK;
    delete process.env.UFOO_HOST_INJECT_SOCK;
    delete process.env.HORIZON_INJECT_SOCK;

    try {
      const adapter = createHostAdapter({ createAdapter });
      expect(adapter.send("test")).toBe(false);
      expect(adapter.sendRaw("test")).toBe(false);
      expect(adapter.resize(80, 24)).toBe(false);
    } finally {
      if (originalSock) process.env.UFOO_HOST_INJECT_SOCK = originalSock;
      if (originalHorizon) process.env.HORIZON_INJECT_SOCK = originalHorizon;
    }
  });

  test("snapshot/subscribe/activate return false when capability not enabled", async () => {
    const originalSock = process.env.UFOO_HOST_INJECT_SOCK;
    delete process.env.UFOO_HOST_INJECT_SOCK;

    try {
      const adapter = createHostAdapter({ createAdapter });
      // Before connect, dynamic caps are false
      expect(adapter.snapshot()).toBe(false);
      expect(adapter.subscribe()).toBe(false);
      expect(await adapter.activate()).toBe(false);
    } finally {
      if (originalSock) process.env.UFOO_HOST_INJECT_SOCK = originalSock;
    }
  });

  test("getState returns host environment info", () => {
    const originalName = process.env.UFOO_HOST_NAME;
    const originalSid = process.env.UFOO_HOST_SESSION_ID;
    process.env.UFOO_HOST_NAME = "test-host";
    process.env.UFOO_HOST_SESSION_ID = "sess-123";

    try {
      const adapter = createHostAdapter({ createAdapter });
      const state = adapter.getState();
      expect(state.hostName).toBe("test-host");
      expect(state.sessionId).toBe("sess-123");
      expect(state.hostCapabilities).toBeNull();
    } finally {
      if (originalName) process.env.UFOO_HOST_NAME = originalName;
      else delete process.env.UFOO_HOST_NAME;
      if (originalSid) process.env.UFOO_HOST_SESSION_ID = originalSid;
      else delete process.env.UFOO_HOST_SESSION_ID;
    }
  });

  test("HORIZON_INJECT_SOCK fallback works when UFOO_HOST_INJECT_SOCK is not set", () => {
    const originalUfoo = process.env.UFOO_HOST_INJECT_SOCK;
    const originalHorizon = process.env.HORIZON_INJECT_SOCK;
    delete process.env.UFOO_HOST_INJECT_SOCK;
    process.env.HORIZON_INJECT_SOCK = "/tmp/fake.sock";

    try {
      const adapter = createHostAdapter({ createAdapter });
      const state = adapter.getState();
      expect(state.injectSock).toBe("/tmp/fake.sock");
    } finally {
      if (originalUfoo) process.env.UFOO_HOST_INJECT_SOCK = originalUfoo;
      else delete process.env.UFOO_HOST_INJECT_SOCK;
      if (originalHorizon) process.env.HORIZON_INJECT_SOCK = originalHorizon;
      else delete process.env.HORIZON_INJECT_SOCK;
    }
  });
});

// --- Socket integration tests ---

describe("hostAdapter with mock socket", () => {
  let mock;
  let originalSock;
  let originalDaemonSock;

  beforeEach(() => {
    originalSock = process.env.UFOO_HOST_INJECT_SOCK;
    originalDaemonSock = process.env.UFOO_HOST_DAEMON_SOCK;
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
    if (originalSock) process.env.UFOO_HOST_INJECT_SOCK = originalSock;
    else delete process.env.UFOO_HOST_INJECT_SOCK;
    if (originalDaemonSock) process.env.UFOO_HOST_DAEMON_SOCK = originalDaemonSock;
    else delete process.env.UFOO_HOST_DAEMON_SOCK;
  });

  test("connect performs capabilities handshake and enables dynamic flags", async () => {
    mock = createMockHostSocket((req) => {
      if (req.type === "capabilities") {
        return {
          v: 1, request_id: req.request_id || "", ok: true,
          result: {
            host: "test-host",
            protocol_version: 1,
            commands: ["inject", "raw", "resize", "snapshot", "activate", "notify"],
          },
        };
      }
      return { v: 1, ok: false, error_code: "unsupported", error: "unknown" };
    });

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    // Before connect, dynamic caps are false
    expect(adapter.capabilities.supportsSnapshot).toBe(false);
    expect(adapter.capabilities.supportsActivate).toBe(false);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(false);

    const connected = await adapter.connect();
    expect(connected).toBe(true);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].type).toBe("capabilities");

    // After connect, dynamic caps are enabled
    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);
    // Commands not reported stay false
    expect(adapter.capabilities.supportsReplay).toBe(false);
    expect(adapter.capabilities.supportsSubscribeFull).toBe(false);

    const state = adapter.getState();
    expect(state.hostCapabilities).toBeTruthy();
    expect(state.hostCapabilities.host).toBe("test-host");
  });

  test("connect with minimal host (no dynamic caps)", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true,
      result: {
        host: "minimal-host",
        protocol_version: 1,
        commands: ["inject", "raw"],
      },
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    await adapter.connect();

    // Only base caps, no dynamic
    expect(adapter.capabilities.supportsSocketProtocol).toBe(true);
    expect(adapter.capabilities.supportsSessionReuse).toBe(true);
    expect(adapter.capabilities.supportsSnapshot).toBe(false);
    expect(adapter.capabilities.supportsActivate).toBe(false);
  });

  test("connect with full-featured host enables all dynamic caps", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true,
      result: {
        host: "full-host",
        protocol_version: 1,
        commands: [
          "inject", "raw", "resize",
          "snapshot", "subscribe", "subscribe_screen",
          "activate", "close_session", "notify", "replay",
        ],
      },
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    await adapter.connect();

    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsSubscribeFull).toBe(true);
    expect(adapter.capabilities.supportsSubscribeScreen).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsWindowClose).toBe(true);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);
    expect(adapter.capabilities.supportsReplay).toBe(true);
  });

  test("disconnect resets dynamic capabilities", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true,
      result: {
        host: "test",
        protocol_version: 1,
        commands: ["snapshot", "activate", "notify"],
      },
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    await adapter.connect();
    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);

    await adapter.disconnect();

    // Dynamic caps reset
    expect(adapter.capabilities.supportsSnapshot).toBe(false);
    expect(adapter.capabilities.supportsActivate).toBe(false);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(false);
    // Base caps remain
    expect(adapter.capabilities.supportsSocketProtocol).toBe(true);
    expect(adapter.capabilities.supportsSessionReuse).toBe(true);
    expect(adapter.getState().hostCapabilities).toBeNull();
  });

  test("connect refreshes capabilities on reconnect", async () => {
    const firstMock = createMockHostSocket(() => ({
      v: 1, ok: true,
      result: {
        host: "first-host",
        protocol_version: 1,
        commands: ["snapshot", "activate", "notify"],
      },
    }));

    process.env.UFOO_HOST_INJECT_SOCK = firstMock.sockPath;
    const adapter = createHostAdapter({ createAdapter });
    await adapter.connect();

    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(true);

    await firstMock.close();
    process.env.UFOO_HOST_INJECT_SOCK = "/tmp/nonexistent-ufoo-reconnect.sock";

    mock = createMockHostSocket(() => ({
      v: 1, ok: true,
      result: {
        host: "second-host",
        protocol_version: 1,
        commands: ["snapshot"],
      },
    }));
    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;

    await adapter.connect();

    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(false);
    expect(adapter.capabilities.supportsNotifierInjector).toBe(false);
  });

  test("connect returns false when socket is unreachable", async () => {
    process.env.UFOO_HOST_INJECT_SOCK = "/tmp/nonexistent-ufoo-test.sock";
    const adapter = createHostAdapter({ createAdapter });

    const connected = await adapter.connect();
    expect(connected).toBe(false);
  });

  test("connect falls back to daemon session_commands when inject socket is unavailable", async () => {
    process.env.UFOO_HOST_INJECT_SOCK = "/tmp/nonexistent-ufoo-inject.sock";
    mock = createMockHostSocket(() => ({
      v: 1, ok: true,
      result: {
        host: "daemon-host",
        protocol_version: 1,
        session_commands: ["snapshot", "activate"],
      },
    }));
    process.env.UFOO_HOST_DAEMON_SOCK = mock.sockPath;

    const adapter = createHostAdapter({ createAdapter });
    const connected = await adapter.connect();

    expect(connected).toBe(true);
    expect(adapter.capabilities.supportsSnapshot).toBe(true);
    expect(adapter.capabilities.supportsActivate).toBe(true);
    expect(adapter.getState().hostCapabilities.commands).toEqual(["snapshot", "activate"]);
  });

  test("send dispatches inject command to socket", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, request_id: req.request_id || "", ok: true, result: {},
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    const result = adapter.send("echo hello");
    expect(result).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(mock.requests.length).toBeGreaterThanOrEqual(1);
    const injectReq = mock.requests.find((r) => r.type === "inject");
    expect(injectReq).toBeTruthy();
    expect(injectReq.command).toBe("echo hello");
  });

  test("sendRaw dispatches raw command to socket", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true, result: {},
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    const result = adapter.sendRaw("\x1b[A");
    expect(result).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const rawReq = mock.requests.find((r) => r.type === "raw");
    expect(rawReq).toBeTruthy();
    expect(rawReq.data).toBe("\x1b[A");
  });

  test("resize dispatches resize command to socket", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true, result: {},
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    const result = adapter.resize(120, 40);
    expect(result).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const resizeReq = mock.requests.find((r) => r.type === "resize");
    expect(resizeReq).toBeTruthy();
    expect(resizeReq.cols).toBe(120);
    expect(resizeReq.rows).toBe(40);
  });

  test("snapshot forwards to host when capability enabled", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true,
      result: req.type === "capabilities"
        ? { host: "test", protocol_version: 1, commands: ["snapshot"] }
        : { lines: ["$ hello"], cols: 80, rows: 24 },
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    await adapter.connect();
    expect(adapter.capabilities.supportsSnapshot).toBe(true);

    const result = adapter.snapshot();
    expect(result).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const snapshotReq = mock.requests.find((r) => r.type === "snapshot");
    expect(snapshotReq).toBeTruthy();
  });

  test("activate forwards to host when capability enabled", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true,
      result: req.type === "capabilities"
        ? { host: "test", protocol_version: 1, commands: ["activate"] }
        : {},
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    await adapter.connect();
    expect(adapter.capabilities.supportsActivate).toBe(true);

    const result = await adapter.activate();
    expect(result).toBe(true);

    const activateReq = mock.requests.find((r) => r.type === "activate");
    expect(activateReq).toBeTruthy();
  });

  test("subscribe forwards to host when capability enabled", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, ok: true,
      result: req.type === "capabilities"
        ? { host: "test", protocol_version: 1, commands: ["subscribe"] }
        : {},
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    await adapter.connect();
    expect(adapter.capabilities.supportsSubscribeFull).toBe(true);

    const result = adapter.subscribe();
    expect(result).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const subscribeReq = mock.requests.find((r) => r.type === "subscribe");
    expect(subscribeReq).toBeTruthy();
  });
});

// --- Protocol envelope tests ---

describe("Terminal Host Protocol envelope", () => {
  let mock;
  let originalSock;

  beforeEach(() => {
    originalSock = process.env.UFOO_HOST_INJECT_SOCK;
  });

  afterEach(async () => {
    if (mock) {
      await mock.close();
      mock = null;
    }
    if (originalSock) process.env.UFOO_HOST_INJECT_SOCK = originalSock;
    else delete process.env.UFOO_HOST_INJECT_SOCK;
  });

  test("error response includes error_code", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, request_id: "", ok: false,
      error_code: "invalid_request", error: "missing field: command",
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    // connect will fail because capabilities returns error
    const connected = await adapter.connect();
    expect(connected).toBe(false);
  });

  test("success response unwraps result field", async () => {
    mock = createMockHostSocket((req) => ({
      v: 1, request_id: "", ok: true,
      result: { session_id: "ABC123", inject_sock: "/tmp/inject.sock" },
    }));

    process.env.UFOO_HOST_INJECT_SOCK = mock.sockPath;
    const adapter = createHostAdapter({ createAdapter });

    const connected = await adapter.connect();
    expect(connected).toBe(true);
    const state = adapter.getState();
    expect(state.hostCapabilities.session_id).toBe("ABC123");
  });
});
