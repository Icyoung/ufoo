"use strict";

/**
 * Headless ChatController — composition root for Ink + Rust chat adapters.
 *
 * Owns stream state, STATUS→agents snapshot, slash/submit wiring ports.
 * View adapters attach via `ports` (dispatch / publish / log / setStatus).
 */

const { createThrottledSender, createChatStreamState } = require("./streamState");
const {
  loadChatHistory,
  loadInputHistory,
  appendChatHistory,
  appendInputHistory,
  chatHistoryOptionsForScope,
  chatHistoryFilePath,
} = require("./historyStore");
const { bootstrapEnvironment, ensureSubscriberId } = require("./bootstrap");
const {
  buildAgentMaps,
  resolveAgentId,
  normalizeStatusToAgentsSnapshot,
  toInkAgentsDispatchList,
} = require("./agentDirectory");
const { buildPromptIpcRequest, buildDirectBusSendRequest } = require("./ipcBuilders");
const { IPC_REQUEST_TYPES } = require("../../runtime/contracts/eventContract");

function createChatController({
  projectRoot = process.cwd(),
  globalMode = false,
  ports = {},
} = {}) {
  const view = {
    dispatch: typeof ports.dispatch === "function" ? ports.dispatch : () => {},
    logMessage: typeof ports.logMessage === "function" ? ports.logMessage : () => {},
    setStatus: typeof ports.setStatus === "function" ? ports.setStatus : () => {},
    publish: typeof ports.publish === "function" ? ports.publish : () => {},
    getState: typeof ports.getState === "function" ? ports.getState : () => ({}),
    mapAgentsForDispatch: typeof ports.mapAgentsForDispatch === "function"
      ? ports.mapAgentsForDispatch
      : (snapshot) => snapshot.agents,
    appendHistory: typeof ports.appendHistory === "function"
      ? ports.appendHistory
      : (type, text, meta) => appendChatHistory(projectRoot, type, text, meta, { globalMode }),
    displayNameForPublisher: typeof ports.displayNameForPublisher === "function"
      ? ports.displayNameForPublisher
      : (value) => value,
    send: typeof ports.send === "function" ? ports.send : null,
  };

  let started = false;
  let statusTimer = null;
  let streamState = null;
  let requestDaemonStatus = null;
  let commandExecutor = null;
  let submitHandler = null;
  let daemonSend = typeof view.send === "function" ? view.send : () => {};

  const session = {
    agents: [],
    metaMap: new Map(),
    labelMap: new Map(),
    footer: "",
    cron: null,
    loop: null,
    targetAgent: null,
    pending: null,
  };

  function setSend(fn) {
    daemonSend = typeof fn === "function" ? fn : () => {};
  }

  function applyStatus(data = {}) {
    const snapshot = normalizeStatusToAgentsSnapshot(data);
    session.agents = snapshot.agents.map((row) => row.id || row.fullId);
    session.metaMap = snapshot.metaMap;
    session.labelMap = snapshot.labelMap;
    session.footer = snapshot.footer;
    session.cron = snapshot.cron;
    session.loop = snapshot.loop;
    view.publish("agents.snapshot", {
      agents: snapshot.agents.map((row) => ({
        id: row.id,
        label: row.label,
        activity_state: row.activity_state || "",
        activity_detail: row.activity_detail || "",
      })),
      footer: snapshot.footer,
      cron: snapshot.cron,
      loop: snapshot.loop,
    });
    view.dispatch({ type: "agents/set", list: view.mapAgentsForDispatch(snapshot) });
    return snapshot;
  }

  function patchAgentActivity(agentId, patch = {}) {
    if (!agentId) return;
    const existing = session.metaMap.get(agentId) || { id: agentId };
    const next = { ...existing, ...patch };
    session.metaMap.set(agentId, next);
    const rebuilt = normalizeStatusToAgentsSnapshot({
      active: session.agents,
      active_meta: session.agents.map((id) => session.metaMap.get(id) || { id }),
    });
    session.footer = rebuilt.footer;
    view.publish("agents.patch", {
      agents: rebuilt.agents.map((row) => ({
        id: row.id,
        label: row.label,
        activity_state: row.activity_state || "",
        activity_detail: row.activity_detail || "",
      })),
      footer: rebuilt.footer,
    });
  }

  function getAgentLabel(id) {
    return session.labelMap.get(id) || (session.metaMap.get(id) || {}).nickname || id;
  }

  function ensureCommandExecutor() {
    if (commandExecutor) return commandExecutor;
    const { createCommandExecutor } = require("./commandExecutor");
    const { parseCommand } = require("./commands");
    const { startDaemon, stopDaemon } = require("./transport");
    const AgentActivator = require("../../coordination/bus/activate");
    const fs = require("fs");

    commandExecutor = createCommandExecutor({
      projectRoot,
      getActiveProjectRoot: typeof ports.getActiveProjectRoot === "function"
        ? ports.getActiveProjectRoot
        : () => projectRoot,
      parseCommand,
      escapeBlessed: (value) => String(value == null ? "" : value),
      logMessage: view.logMessage,
      resolveStatusLine: (text) => view.setStatus(text),
      renderScreen: () => {},
      clearLog: typeof ports.clearLog === "function"
        ? ports.clearLog
        : () => {
          try {
            const root = typeof ports.getActiveProjectRoot === "function"
              ? ports.getActiveProjectRoot()
              : projectRoot;
            const opts = typeof ports.getHistoryOptions === "function"
              ? ports.getHistoryOptions()
              : { globalMode };
            const file = chatHistoryFilePath(root, opts);
            if (file && fs.existsSync(file)) fs.writeFileSync(file, "");
          } catch {
            // ignore
          }
          view.publish("transcript.reset", {});
          view.dispatch({ type: "log/clear" });
        },
      getActiveAgents: () => session.agents.slice(),
      getActiveAgentMetaMap: () => session.metaMap,
      getAgentLabel,
      isDaemonRunning: typeof ports.isDaemonRunning === "function"
        ? ports.isDaemonRunning
        : () => true,
      startDaemon: (root, options = {}) => startDaemon(root || projectRoot, options),
      stopDaemon: (root, options = {}) => stopDaemon(root || projectRoot, options),
      restartDaemon: typeof ports.restartDaemon === "function"
        ? ports.restartDaemon
        : async () => {},
      send: (req) => daemonSend(req),
      requestStatus: () => {
        if (typeof requestDaemonStatus === "function") requestDaemonStatus();
        else daemonSend({ type: IPC_REQUEST_TYPES.STATUS });
      },
      requestCron: (payload = {}) => daemonSend({ type: IPC_REQUEST_TYPES.CRON, ...payload }),
      activateAgent: async (target) => {
        const activator = new AgentActivator(projectRoot);
        await activator.activate(target);
      },
      globalMode: Boolean(globalMode),
      listProjects: typeof ports.listProjects === "function"
        ? ports.listProjects
        : () => [],
      getCurrentProject: typeof ports.getCurrentProject === "function"
        ? ports.getCurrentProject
        : () => ({ project_root: projectRoot }),
      switchProject: typeof ports.switchProject === "function"
        ? ports.switchProject
        : async () => ({ ok: false, error: "project switching unavailable" }),
      toggleMultiWindow: typeof ports.toggleMultiWindow === "function"
        ? ports.toggleMultiWindow
        : () => {
          view.logMessage("system", "Multi-window unavailable in this host.");
        },
      applyChatSettings: typeof ports.applyChatSettings === "function"
        ? ports.applyChatSettings
        : null,
    });
    return commandExecutor;
  }

  function ensureSubmitHandler() {
    if (submitHandler) return submitHandler;
    const { createInputSubmitHandler } = require("./inputSubmitHandler");
    const { parseAtTarget } = require("./commands");
    const submitState = {};
    Object.defineProperties(submitState, {
      targetAgent: {
        get: () => session.targetAgent,
        set: (next) => {
          session.targetAgent = next || null;
        },
      },
      pending: {
        get: () => session.pending,
        set: (next) => {
          session.pending = next || null;
        },
      },
      activeAgentMetaMap: {
        get: () => session.metaMap,
      },
    });
    submitHandler = createInputSubmitHandler({
      state: submitState,
      parseAtTarget,
      resolveAgentId: (label) => resolveAgentId({
        label,
        activeAgents: session.agents,
        labelMap: session.labelMap,
        lookupNickname: (nickname) => {
          for (const [id, meta] of session.metaMap.entries()) {
            if (!meta) continue;
            if (
              meta.nickname === nickname
              || meta.scoped_nickname === nickname
              || meta.display_nickname === nickname
            ) {
              return id;
            }
          }
          return null;
        },
      }),
      executeCommand: async (text) => ensureCommandExecutor().executeCommand(text),
      queueStatusLine: (text) => view.setStatus(text),
      send: (req) => daemonSend(req),
      logMessage: view.logMessage,
      getAgentLabel,
      escapeBlessed: (value) => String(value == null ? "" : value),
      markPendingDelivery: (agentId) => {
        if (streamState) streamState.markPendingDelivery(agentId, getAgentLabel(agentId));
      },
      clearTargetAgent: () => {
        session.targetAgent = null;
        view.publish("prompt.set_prefix", { prefix: "› " });
      },
      setTargetAgent: (agentId) => {
        session.targetAgent = agentId || null;
        if (!agentId) {
          view.publish("prompt.set_prefix", { prefix: "› " });
          return;
        }
        const label = getAgentLabel(agentId);
        view.publish("prompt.set_prefix", { prefix: `›@${label} ` });
      },
      enterAgentView: (agentId, options = {}) => {
        if (typeof ports.enterAgentView === "function") {
          return ports.enterAgentView(agentId, options);
        }
        view.logMessage("system", "Agent enter unavailable in this host.");
      },
      getAgentAdapter: (agentId) => {
        if (typeof ports.getAgentAdapter === "function") {
          return ports.getAgentAdapter(agentId);
        }
        try {
          const { createTerminalAdapterRouter } = require("../../runtime/terminal/adapterRouter");
          const meta = session.metaMap.get(agentId) || {};
          const launchMode = String(meta.launch_mode || meta.launchMode || "").trim();
          return createTerminalAdapterRouter().getAdapter({ launchMode, agentId, meta });
        } catch {
          return null;
        }
      },
      activateAgent: async (agentId) => {
        if (typeof ports.activateAgent === "function") {
          return ports.activateAgent(agentId);
        }
        const AgentActivator = require("../../coordination/bus/activate");
        const root = typeof ports.getActiveProjectRoot === "function"
          ? ports.getActiveProjectRoot()
          : projectRoot;
        const activator = new AgentActivator(root || projectRoot);
        await activator.activate(agentId);
      },
      focusMultiPane: typeof ports.focusMultiPane === "function"
        ? ports.focusMultiPane
        : null,
      commitInputHistory: (value) => {
        const root = typeof ports.getActiveProjectRoot === "function"
          ? ports.getActiveProjectRoot()
          : projectRoot;
        const opts = typeof ports.getHistoryOptions === "function"
          ? ports.getHistoryOptions()
          : { globalMode };
        appendInputHistory(root || projectRoot, value, opts);
      },
      focusInput: () => {},
      renderScreen: () => {},
      getShellCwd: () => {
        if (typeof ports.getActiveProjectRoot === "function") {
          return ports.getActiveProjectRoot() || projectRoot;
        }
        return projectRoot;
      },
    });
    return submitHandler;
  }

  async function submitInput(text) {
    const handler = ensureSubmitHandler();
    await handler.handleSubmit(text);
  }

  function start(options = {}) {
    if (started) return;
    started = true;
    if (typeof options.send === "function") setSend(options.send);
    streamState = createChatStreamState({
      dispatch: view.dispatch,
      appendHistory: view.appendHistory,
      displayNameForPublisher: (publisher) => {
        if (session.labelMap.has(publisher)) return session.labelMap.get(publisher);
        return view.displayNameForPublisher(publisher);
      },
    });
    const sendStatus = typeof options.sendStatus === "function"
      ? options.sendStatus
      : () => daemonSend({ type: IPC_REQUEST_TYPES.STATUS });
    requestDaemonStatus = createThrottledSender(sendStatus, 500);
    const intervalMs = Number(options.statusIntervalMs) > 0 ? Number(options.statusIntervalMs) : 3000;
    statusTimer = setInterval(() => {
      try {
        requestDaemonStatus();
      } catch {
        // ignore poll errors
      }
    }, intervalMs);
    if (typeof statusTimer.unref === "function") statusTimer.unref();
    try {
      requestDaemonStatus();
    } catch {
      // ignore
    }
  }

  function stop() {
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (streamState && typeof streamState.flushDeltas === "function") {
      streamState.flushDeltas();
    }
    started = false;
  }

  return {
    projectRoot,
    globalMode,
    session,
    bootstrapEnvironment: (root = projectRoot, options = {}) => bootstrapEnvironment(root, {
      globalMode,
      ...options,
    }),
    ensureSubscriberId: (root = projectRoot) => ensureSubscriberId(root),
    loadChatHistory: (cap = 200, options = {}) => loadChatHistory(projectRoot, cap, {
      globalMode,
      ...options,
    }),
    loadInputHistory: (cap = 200, options = {}) => loadInputHistory(projectRoot, cap, {
      globalMode,
      ...options,
    }),
    appendChatHistory: (type, text, meta = {}, options = {}) => appendChatHistory(
      projectRoot,
      type,
      text,
      meta,
      { globalMode, ...options },
    ),
    appendInputHistory: (value, options = {}) => appendInputHistory(projectRoot, value, {
      globalMode,
      ...options,
    }),
    chatHistoryOptionsForScope,
    getStreamState: () => streamState,
    getAgentsFooter: () => session.footer,
    getAgentsSnapshot: () => ({
      agents: session.agents.map((id) => {
        const meta = session.metaMap.get(id) || {};
        return {
          id,
          label: getAgentLabel(id),
          activity_state: meta.activity_state || "",
          activity_detail: meta.activity_detail || "",
        };
      }),
      footer: session.footer,
      cron: session.cron,
      loop: session.loop,
    }),
    applyStatus,
    patchAgentActivity,
    setSend,
    submitInput,
    ensureCommandExecutor,
    buildPromptIpcRequest,
    buildDirectBusSendRequest,
    buildAgentMaps,
    requestDaemonStatus: () => {
      if (typeof requestDaemonStatus === "function") requestDaemonStatus();
    },
    start,
    stop,
  };
}

module.exports = {
  createChatController,
  toInkAgentsDispatchList,
};
