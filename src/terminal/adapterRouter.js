const {
  createTerminalCapabilities,
  assertTerminalAdapterContract,
} = require("./adapterContract");
const { createTerminalAdapter } = require("./adapters/terminalAdapter");
const { createTmuxAdapter } = require("./adapters/tmuxAdapter");
const { createInternalQueueAdapter } = require("./adapters/internalQueueAdapter");
const { createInternalPtyAdapter } = require("./adapters/internalPtyAdapter");
const { createHostAdapter } = require("./adapters/hostAdapter");

function createTerminalAdapterRouter(options = {}) {
  const {
    activateAgent = () => {},
    activateTerminal = null,
    activateTmux = null,
    sendRaw = () => {},
    sendResize = () => {},
    requestSnapshot = () => false,
  } = options;

  function createAdapter({ capabilities, handlers = {} }) {
    const adapter = {
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
    assertTerminalAdapterContract(adapter);
    return adapter;
  }

  function getAdapter(params = {}) {
    const { launchMode = "", agentId = "", meta = null } = params;

    if (launchMode === "terminal") {
      return createTerminalAdapter({
        agentId,
        activateAgent: activateTerminal || activateAgent,
        createAdapter,
      });
    }

    if (launchMode === "tmux") {
      return createTmuxAdapter({
        agentId,
        activateAgent: activateTmux || activateAgent,
        createAdapter,
      });
    }

    if (launchMode === "host") {
      return createHostAdapter({
        createAdapter,
        injectSock: meta?.host_inject_sock || meta?.hostInjectSock || "",
        daemonSock: meta?.host_daemon_sock || meta?.hostDaemonSock || "",
        hostName: meta?.host_name || meta?.hostName || "",
        sessionId: meta?.host_session_id || meta?.hostSessionId || "",
        hostCapabilities: meta?.host_capabilities || meta?.hostCapabilities || null,
      });
    }

    if (launchMode === "internal-pty") {
      return createInternalPtyAdapter({
        sendRaw,
        sendResize,
        requestSnapshot,
        createAdapter,
      });
    }

    if (launchMode === "internal") {
      return createInternalQueueAdapter({
        sendRaw,
        sendResize,
        requestSnapshot,
        createAdapter,
      });
    }

    return createAdapter({ capabilities: createTerminalCapabilities() });
  }

  return {
    getAdapter,
  };
}

module.exports = {
  createTerminalAdapterRouter,
};
