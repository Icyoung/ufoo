const { IPC_REQUEST_TYPES } = require("../../runtime/contracts/eventContract");
const { decodeEscapedNewlines } = require("./text");
const { describeCommandForChat, shouldEchoCommandInChat } = require("./commands");
const { parseShellCommand, runShellCommand: defaultRunShellCommand } = require("./shellCommand");
const { normalizeAttachmentList, formatAttachmentPromptSummary } = require("../../runtime/attachments");

function createInputSubmitHandler(options = {}) {
  const {
    state,
    parseAtTarget = () => null,
    resolveAgentId = () => null,
    requireKnownTarget = false,
    executeCommand = async () => false,
    queueStatusLine = () => {},
    send = () => {},
    logMessage = () => {},
    getAgentLabel = (id) => id,
    escapeBlessed = (value) => String(value || ""),
    markPendingDelivery = () => {},
    clearTargetAgent = () => {},
    setTargetAgent = () => {},
    activateInternalAgent = () => {},
    // In the all-children layout, focus an existing in-window TUI pane.
    // Return true if handled.
    focusMultiPane = null,
    commitInputHistory = () => {},
    focusInput = () => {},
    renderScreen = () => {},  // Add renderScreen callback
    runShellCommand = defaultRunShellCommand,
    getShellCwd = () => process.cwd(),
  } = options;

  if (!state || typeof state !== "object") {
    throw new Error("createInputSubmitHandler requires a mutable state object");
  }

  function userEcho(text, targetLabel = "") {
    const body = escapeBlessed(text);
    // Match ucode › prompt echo so history reload and live log share a prefix.
    if (!targetLabel) return `› ${body}`;
    return `› {magenta-fg}@${escapeBlessed(targetLabel)}{/magenta-fg} ${body}`;
  }

  async function tryActivateTargetAgent(agentId) {
    if (typeof focusMultiPane === "function") {
      try {
        const focused = await focusMultiPane(agentId);
        if (focused) {
          clearTargetAgent();
          return true;
        }
      } catch {
        // Try the host's internal side pane.
      }
    }

    const result = await activateInternalAgent(agentId);
    if (!result || result.ok === false) return false;
    clearTargetAgent();
    return true;
  }

  function formatEchoWithAttachments(messageText, attachments = []) {
    if (!attachments.length) return messageText;
    const tags = attachments.map((att) => `[${att.kind === "image" ? "image" : "file"}: ${att.name}]`).join(" ");
    return messageText ? `${messageText}\n${tags}` : tags;
  }

  async function handleSubmit(value, submitOptions = {}) {
    const rawText = decodeEscapedNewlines(value).trim();
    const attachments = normalizeAttachmentList(submitOptions.attachments || []);
    const text = rawText;

    if (!text && attachments.length === 0) {
      if (state.targetAgent) {
        const handled = await tryActivateTargetAgent(state.targetAgent);
        if (handled) return;
      }
      focusInput();
      return;
    }

    if (text) commitInputHistory(text);

    const shellCommand = parseShellCommand(text);
    if (shellCommand) {
      logMessage("user", `{gray-fg}!{/gray-fg} ${escapeBlessed(shellCommand)}`);
      queueStatusLine(`Running: ${escapeBlessed(shellCommand)}`);
      renderScreen();
      try {
        const result = await runShellCommand(shellCommand, { cwd: getShellCwd() });
        const stdout = String(result && result.stdout ? result.stdout : "").trimEnd();
        const stderr = String(result && result.stderr ? result.stderr : "").trimEnd();
        if (stdout) {
          stdout.split(/\r?\n/).forEach((line) => logMessage("system", escapeBlessed(line)));
        }
        if (stderr) {
          stderr.split(/\r?\n/).forEach((line) => logMessage(result && result.ok ? "system" : "error", escapeBlessed(line)));
        }
        if (!stdout && !stderr) {
          logMessage("system", "{gray-fg}(no output){/gray-fg}");
        }
        if (result && result.ok) {
          queueStatusLine(`Done: ${escapeBlessed(shellCommand)}`);
        } else {
          const suffix = result && result.signal ? ` signal ${result.signal}` : ` exit ${result && result.code != null ? result.code : 1}`;
          logMessage("error", `{white-fg}✗{/white-fg} Command failed:${escapeBlessed(suffix)}`);
        }
      } catch (err) {
        logMessage("error", `{white-fg}✗{/white-fg} Command error: ${escapeBlessed(err && err.message ? err.message : err)}`);
      }
      focusInput();
      return;
    }

    if (state.targetAgent) {
      if (requireKnownTarget && !resolveAgentId(state.targetAgent)) {
        clearTargetAgent();
        logMessage("error", "Unknown or inactive @target");
        focusInput();
        return;
      }
      const label = getAgentLabel(state.targetAgent);
      const effectiveMessage = formatAttachmentPromptSummary(text, attachments);
      logMessage(
        "user",
        userEcho(formatEchoWithAttachments(text, attachments), label)
      );
      renderScreen();  // Immediately render the user message
      markPendingDelivery(state.targetAgent);
      send({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target: state.targetAgent,
        message: effectiveMessage,
        ...(attachments.length > 0 ? { attachments } : {}),
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
        if (!requireKnownTarget) queueStatusLine(`Target selected: @${escapeBlessed(atTarget.target)}`);
        focusInput();
        return;
      }
      const resolvedTarget = resolveAgentId(atTarget.target) || (requireKnownTarget ? "" : atTarget.target);
      if (!resolvedTarget) {
        logMessage("error", "Unknown or inactive @target");
        focusInput();
        return;
      }
      const message = formatAttachmentPromptSummary(atTarget.message.trim(), attachments);
      logMessage(
        "user",
        userEcho(formatEchoWithAttachments(atTarget.message.trim(), attachments), atTarget.target)
      );
      renderScreen();  // Immediately render the user message
      markPendingDelivery(resolvedTarget);
      send({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target: resolvedTarget,
        message,
        ...(attachments.length > 0 ? { attachments } : {}),
        injection_mode: "immediate",
        source: "chat-direct",
      });
      focusInput();
      return;
    }

    if (text.startsWith("/")) {
      if (shouldEchoCommandInChat(text)) {
        const commandSummary = describeCommandForChat(text);
        logMessage("user", userEcho(commandSummary || text));
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
      const effectiveText = formatAttachmentPromptSummary(text, attachments);
      state.pending = { original: effectiveText };
      queueStatusLine("ufoo-agent processing");
      send({
        type: IPC_REQUEST_TYPES.PROMPT,
        text: effectiveText,
        ...(attachments.length > 0 ? { attachments } : {}),
        request_meta: {
          source: "chat-dialog",
          dispatch_default_injection_mode: "immediate",
          allow_relevance_queue: true,
        },
      });
      logMessage("user", userEcho(formatEchoWithAttachments(text, attachments)));
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
