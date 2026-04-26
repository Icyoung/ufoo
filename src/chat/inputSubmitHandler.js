const { IPC_REQUEST_TYPES } = require("../shared/eventContract");
const { decodeEscapedNewlines } = require("./text");
const { shouldEchoCommandInChat } = require("./commands");

function createInputSubmitHandler(options = {}) {
  const {
    state,
    parseAtTarget = () => null,
    resolveAgentId = () => null,
    executeCommand = async () => false,
    queueStatusLine = () => {},
    send = () => {},
    logMessage = () => {},
    getAgentLabel = (id) => id,
    escapeBlessed = (value) => String(value || ""),
    markPendingDelivery = () => {},
    clearTargetAgent = () => {},
    setTargetAgent = () => {},
    enterAgentView = () => {},
    getAgentAdapter = () => null,
    activateAgent = async () => {},
    getInjectSockPath = () => "",
    existsSync = () => false,
    commitInputHistory = () => {},
    focusInput = () => {},
    renderScreen = () => {},  // Add renderScreen callback
  } = options;

  if (!state || typeof state !== "object") {
    throw new Error("createInputSubmitHandler requires a mutable state object");
  }

  function userPrefix() {
    return "{white-fg}you{/white-fg} {gray-fg}·{/gray-fg}";
  }

  async function tryActivateTargetAgent(agentId) {
    const adapter = getAgentAdapter(agentId);
    const capabilities = adapter && adapter.capabilities ? adapter.capabilities : null;
    const sockPath = getInjectSockPath(agentId);
    const supportsSocket = Boolean(capabilities && capabilities.supportsSocketProtocol);
    const supportsActivate = Boolean(capabilities && capabilities.supportsActivate);
    const supportsInternalQueue = Boolean(capabilities && capabilities.supportsInternalQueueLoop);

    if (existsSync(sockPath) && supportsSocket) {
      clearTargetAgent();
      enterAgentView(agentId);
      return true;
    }

    if (supportsActivate) {
      clearTargetAgent();
      try {
        if (adapter && typeof adapter.activate === "function") {
          adapter.activate(agentId);
        } else {
          const pendingActivation = activateAgent(agentId);
          if (pendingActivation && typeof pendingActivation.catch === "function") {
            pendingActivation.catch(() => {});
          }
        }
      } catch {
        // Best-effort activation.
      }
      return true;
    }

    if (supportsInternalQueue) {
      clearTargetAgent();
      enterAgentView(agentId, { useBus: true });
      return true;
    }

    return false;
  }

  async function handleSubmit(value) {
    const text = decodeEscapedNewlines(value).trim();

    if (!text) {
      if (state.targetAgent) {
        const handled = await tryActivateTargetAgent(state.targetAgent);
        if (handled) return;
      }
      focusInput();
      return;
    }

    commitInputHistory(text);

    if (state.targetAgent) {
      const label = getAgentLabel(state.targetAgent);
      logMessage(
        "user",
        `${userPrefix()} {magenta-fg}@${escapeBlessed(label)}{/magenta-fg} ${escapeBlessed(text)}`
      );
      renderScreen();  // Immediately render the user message
      markPendingDelivery(state.targetAgent);
      send({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target: state.targetAgent,
        message: text,
        injection_mode: "immediate",
        source: "chat-direct",
      });
      clearTargetAgent();
      focusInput();
      return;
    }

    const atTarget = parseAtTarget(text);
    if (atTarget) {
      if (!atTarget.message) {
        const resolvedTarget = resolveAgentId(atTarget.target) || "";
        if (!resolvedTarget) {
          logMessage("error", "{white-fg}✗{/white-fg} Unknown @target");
          focusInput();
          return;
        }
        setTargetAgent(resolvedTarget);
        queueStatusLine(`Target selected: @${escapeBlessed(atTarget.target)}`);
        focusInput();
        return;
      }
      const resolvedTarget = resolveAgentId(atTarget.target) || atTarget.target;
      const message = atTarget.message.trim();
      logMessage(
        "user",
        `${userPrefix()} {magenta-fg}@${escapeBlessed(atTarget.target)}{/magenta-fg} ${escapeBlessed(message)}`
      );
      renderScreen();  // Immediately render the user message
      markPendingDelivery(resolvedTarget);
      send({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target: resolvedTarget,
        message,
        injection_mode: "immediate",
        source: "chat-direct",
      });
      focusInput();
      return;
    }

    if (text.startsWith("/")) {
      if (shouldEchoCommandInChat(text)) {
        logMessage("user", `${userPrefix()} ${escapeBlessed(text)}`);
        renderScreen();  // Render slash command immediately
      }
      try {
        await executeCommand(text);
      } catch (err) {
        logMessage("error", `{white-fg}✗{/white-fg} Command error: ${escapeBlessed(err.message)}`);
      }
      focusInput();
      return;
    }

    if (state.pending && state.pending.disambiguate) {
      const idx = parseInt(text, 10);
      const choice = state.pending.disambiguate.candidates[idx - 1];
      if (choice) {
        queueStatusLine(`ufoo-agent processing (assigning ${choice.agent_id})`);
        const requestMeta = {
          source: "chat-dialog",
          dispatch_default_injection_mode: "immediate",
          allow_relevance_queue: true,
        };
        if (state.pending.project_root) {
          requestMeta.force_project_root = state.pending.project_root;
        }
        send({
          type: IPC_REQUEST_TYPES.PROMPT,
          text: `Use agent ${choice.agent_id} to handle: ${state.pending.original || "the request"}`,
          request_meta: requestMeta,
        });
        state.pending = null;
      } else {
        logMessage("error", "Invalid selection.");
      }
    } else {
      state.pending = { original: text };
      queueStatusLine("ufoo-agent processing");
      send({
        type: IPC_REQUEST_TYPES.PROMPT,
        text,
        request_meta: {
          source: "chat-dialog",
          dispatch_default_injection_mode: "immediate",
          allow_relevance_queue: true,
        },
      });
      logMessage("user", `${userPrefix()} ${escapeBlessed(text)}`);
      renderScreen();  // Render plain text message immediately
    }

    focusInput();
  }

  return {
    handleSubmit,
  };
}

module.exports = {
  createInputSubmitHandler,
};
