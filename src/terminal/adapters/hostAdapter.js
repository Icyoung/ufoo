const { createTerminalCapabilities } = require("../adapterContract");
const net = require("net");

/**
 * Mapping from host protocol command names to ufoo capability flags.
 * When a host reports supporting a command, the corresponding capability is enabled.
 */
const COMMAND_TO_CAPABILITY = {
  activate: "supportsActivate",
  snapshot: "supportsSnapshot",
  subscribe: "supportsSubscribeFull",
  subscribe_screen: "supportsSubscribeScreen",
  close_session: "supportsWindowClose",
  notify: "supportsNotifierInjector",
  replay: "supportsReplay",
};

/**
 * Send a JSON request to a Unix socket and return the parsed response.
 * Expects the unified envelope: {v, request_id, ok, result|error}
 */
function sendToSocket(sockPath, request, options = {}) {
  return new Promise((resolve, reject) => {
    if (!sockPath) {
      reject(new Error("socket path not set"));
      return;
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 5000;

    const client = net.createConnection(sockPath, () => {
      client.write(JSON.stringify(request) + "\n");
    });

    let buffer = "";
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("host socket timeout"));
    }, timeoutMs);

    client.on("data", (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        clearTimeout(timeout);
        try {
          const res = JSON.parse(line);
          client.end();
          if (res.ok) {
            resolve(res.result || {});
          } else {
            const err = new Error(res.error || "host request failed");
            err.errorCode = res.error_code || "";
            reject(err);
          }
        } catch (err) {
          client.end();
          reject(err);
        }
        return;
      }
    });

    client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    client.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

function getInjectSock() {
  return process.env.UFOO_HOST_INJECT_SOCK
    || process.env.HORIZON_INJECT_SOCK  // deprecated fallback
    || "";
}

function getDaemonSock() {
  return process.env.UFOO_HOST_DAEMON_SOCK || "";
}

function normalizeHostValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHostCapabilities(hostCapabilities) {
  if (!hostCapabilities || typeof hostCapabilities !== "object") {
    return null;
  }
  const normalized = { ...hostCapabilities };
  const commands = Array.isArray(normalized.commands) ? normalized.commands : [];
  const sessionCommands = Array.isArray(normalized.session_commands)
    ? normalized.session_commands
    : [];
  if (commands.length === 0 && sessionCommands.length > 0) {
    normalized.commands = [...sessionCommands];
  } else {
    normalized.commands = [...commands];
  }
  return normalized;
}

function clearDynamicCapabilities(capabilities) {
  for (const flag of Object.values(COMMAND_TO_CAPABILITY)) {
    if (flag in capabilities) {
      capabilities[flag] = false;
    }
  }
}

/**
 * Map host-reported commands array to ufoo capability flags.
 * Mutates the capabilities object in-place.
 */
function applyHostCapabilities(capabilities, hostCommands) {
  if (!Array.isArray(hostCommands)) return;
  for (const cmd of hostCommands) {
    const flag = COMMAND_TO_CAPABILITY[cmd];
    if (flag && flag in capabilities) {
      capabilities[flag] = true;
    }
  }
}

async function probeHostCapabilities(options = {}) {
  const injectSock = normalizeHostValue(options.injectSock) || getInjectSock();
  const daemonSock = normalizeHostValue(options.daemonSock) || getDaemonSock();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 5000;

  for (const sock of [injectSock, daemonSock]) {
    if (!sock) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await sendToSocket(sock, { type: "capabilities" }, { timeoutMs });
      const normalized = normalizeHostCapabilities(result);
      if (normalized) {
        return normalized;
      }
    } catch {
      // try next socket
    }
  }

  return null;
}

/**
 * ufoo Terminal Host adapter — connects to any terminal host's per-session
 * inject socket via the ufoo Terminal Host Protocol.
 *
 * Detects UFOO_HOST_SESSION_ID and UFOO_HOST_INJECT_SOCK env vars.
 * Works with any host that implements the protocol (Horizon, Warp, etc.).
 *
 * After connect(), capabilities are dynamically updated based on what
 * the host reports in its capabilities handshake response.
 */
function createHostAdapter(options = {}) {
  const {
    createAdapter = () => {},
    injectSock = "",
    daemonSock = "",
    hostName = "",
    sessionId = "",
    hostCapabilities: initialHostCapabilities = null,
  } = options;

  // Start with base capabilities; additional flags are set after connect()
  const capabilities = createTerminalCapabilities({
    supportsSocketProtocol: true,
    supportsSessionReuse: true,
  });

  const explicitInjectSock = normalizeHostValue(injectSock);
  const explicitDaemonSock = normalizeHostValue(daemonSock);
  const explicitHostName = normalizeHostValue(hostName);
  const explicitSessionId = normalizeHostValue(sessionId);
  const seededHostCapabilities = normalizeHostCapabilities(initialHostCapabilities);

  // Cached host capabilities from handshake
  let hostCapabilities = seededHostCapabilities ? { ...seededHostCapabilities } : null;

  function resolveInjectSock() {
    return explicitInjectSock || getInjectSock();
  }

  function resolveDaemonSock() {
    return explicitDaemonSock || getDaemonSock();
  }

  function resetCapabilitiesToSeed() {
    clearDynamicCapabilities(capabilities);
    if (seededHostCapabilities) {
      applyHostCapabilities(capabilities, seededHostCapabilities.commands);
      hostCapabilities = { ...seededHostCapabilities };
    } else {
      hostCapabilities = null;
    }
  }

  resetCapabilitiesToSeed();

  return createAdapter({
    capabilities,
    handlers: {
      connect: async () => {
        clearDynamicCapabilities(capabilities);
        const result = await probeHostCapabilities({
          injectSock: resolveInjectSock(),
          daemonSock: resolveDaemonSock(),
        });
        if (result) {
          hostCapabilities = result;
          applyHostCapabilities(capabilities, result.commands);
          return true;
        }
        resetCapabilitiesToSeed();
        return false;
      },
      disconnect: async () => {
        clearDynamicCapabilities(capabilities);
        hostCapabilities = null;
        return true;
      },
      send: (data) => {
        const sock = resolveInjectSock();
        if (!sock) return false;
        sendToSocket(sock, { type: "inject", command: String(data) }).catch(() => {});
        return true;
      },
      sendRaw: (data) => {
        const sock = resolveInjectSock();
        if (!sock) return false;
        sendToSocket(sock, { type: "raw", data: String(data) }).catch(() => {});
        return true;
      },
      resize: (cols, rows) => {
        const sock = resolveInjectSock();
        if (!sock) return false;
        sendToSocket(sock, { type: "resize", cols, rows }).catch(() => {});
        return true;
      },
      snapshot: () => {
        if (!capabilities.supportsSnapshot) return false;
        const sock = resolveInjectSock();
        if (!sock) return false;
        sendToSocket(sock, { type: "snapshot" }).catch(() => {});
        return true;
      },
      subscribe: () => {
        if (!capabilities.supportsSubscribeFull) return false;
        const sock = resolveInjectSock();
        if (!sock) return false;
        sendToSocket(sock, { type: "subscribe" }).catch(() => {});
        return true;
      },
      activate: async () => {
        if (!capabilities.supportsActivate) return false;
        const sock = resolveInjectSock();
        if (!sock) return false;
        try {
          await sendToSocket(sock, { type: "activate" });
          return true;
        } catch {
          return false;
        }
      },
      getState: () => ({
        hostName: explicitHostName || process.env.UFOO_HOST_NAME || "",
        sessionId: explicitSessionId || process.env.UFOO_HOST_SESSION_ID || process.env.HORIZON_SESSION_ID || "",
        injectSock: resolveInjectSock(),
        daemonSock: resolveDaemonSock(),
        hostCapabilities,
      }),
    },
  });
}

// --- Host command helpers (for callers that need async results) ---

/**
 * Request a terminal snapshot from the host.
 * @param {string} [sockPath] - Override socket path
 * @returns {Promise<{lines: string[], cols: number, rows: number, cursor?: {x: number, y: number}}>}
 */
async function requestSnapshot(sockPath) {
  const sock = normalizeHostValue(sockPath) || getInjectSock();
  return sendToSocket(sock, { type: "snapshot" });
}

/**
 * Activate (focus) the host terminal window/tab.
 * @param {string} [sockPath] - Override socket path
 * @returns {Promise<{}>}
 */
async function requestActivate(sockPath) {
  const sock = normalizeHostValue(sockPath) || getInjectSock();
  return sendToSocket(sock, { type: "activate" });
}

/**
 * Send a notification via the host.
 * @param {string} message - Notification message
 * @param {object} [opts] - Options: { title, urgency }
 * @param {string} [sockPath] - Override socket path
 * @returns {Promise<{}>}
 */
async function requestNotify(message, opts = {}, sockPath) {
  const sock = normalizeHostValue(sockPath) || getInjectSock();
  return sendToSocket(sock, { type: "notify", message, ...opts });
}

/**
 * Close a terminal session via the inject socket.
 * @param {string} [sockPath] - Override socket path
 * @returns {Promise<{}>}
 */
async function requestCloseSession(sockPath) {
  const sock = normalizeHostValue(sockPath) || getInjectSock();
  return sendToSocket(sock, { type: "close_session" });
}

// --- Daemon lifecycle management (per-host, not per-session) ---

/**
 * Create a new terminal session via the daemon management socket.
 * @param {string} [daemonSock] - Override daemon socket path (defaults to env)
 * @param {object} [opts] - Options: { group_id, source_session_id, command }
 * @returns {Promise<{session_id: string, inject_sock: string}>}
 */
async function createSession(daemonSock, opts = {}) {
  const sock = normalizeHostValue(daemonSock) || getDaemonSock();
  const req = { type: "create_session" };
  if (opts.group_id) req.group_id = opts.group_id;
  if (opts.source_session_id) req.source_session_id = opts.source_session_id;
  if (opts.command) req.command = opts.command;
  return sendToSocket(sock, req);
}

/**
 * List all terminal sessions via the daemon management socket.
 * @param {string} [daemonSock] - Override daemon socket path
 * @returns {Promise<{sessions: Array<{session_id: string, inject_sock: string}>}>}
 */
async function listSessions(daemonSock) {
  const sock = normalizeHostValue(daemonSock) || getDaemonSock();
  return sendToSocket(sock, { type: "list_sessions" });
}

/**
 * Close a terminal session via the daemon management socket.
 * @param {string} sessionId - Session to close
 * @param {string} [daemonSock] - Override daemon socket path
 * @returns {Promise<{}>}
 */
async function closeSession(sessionId, daemonSock) {
  const sock = normalizeHostValue(daemonSock) || getDaemonSock();
  return sendToSocket(sock, { type: "close_session", session_id: sessionId });
}

/**
 * Query host capabilities via the daemon management socket.
 * @param {string} [daemonSock] - Override daemon socket path
 * @returns {Promise<object>}
 */
async function queryCapabilities(daemonSock) {
  const sock = normalizeHostValue(daemonSock) || getDaemonSock();
  return sendToSocket(sock, { type: "capabilities" });
}

/**
 * Ping the daemon management socket.
 * @param {string} [daemonSock] - Override daemon socket path
 * @returns {Promise<{pong: true}>}
 */
async function pingDaemon(daemonSock) {
  const sock = normalizeHostValue(daemonSock) || getDaemonSock();
  return sendToSocket(sock, { type: "ping" });
}

module.exports = {
  createHostAdapter,
  // Host command helpers (async, for direct use)
  requestSnapshot,
  requestActivate,
  requestNotify,
  requestCloseSession,
  // Daemon lifecycle API
  createSession,
  listSessions,
  closeSession,
  queryCapabilities,
  pingDaemon,
  // For testing
  sendToSocket,
  COMMAND_TO_CAPABILITY,
  applyHostCapabilities,
  clearDynamicCapabilities,
  normalizeHostCapabilities,
  probeHostCapabilities,
};
