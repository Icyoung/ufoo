const { IPC_RESPONSE_TYPES, BUS_STATUS_PHASES } = require("../shared/eventContract");
const { renderMarkdownLines } = require("../shared/markdownRenderer");

function createDaemonMessageRouter(options = {}) {
  const {
    escapeBlessed = (value) => String(value || ""),
    stripBlessedTags = (value) => String(value || "").replace(/\{[^}]+\}/g, ""),
    logMessage = () => {},
    renderScreen = () => {},
    updateDashboard = () => {},
    requestStatus = () => {},
    resolveStatusLine = () => {},
    enqueueBusStatus = () => {},
    resolveBusStatus = () => {},
    getPending = () => null,
    setPending = () => {},
    resolveAgentDisplayName = (value) => value,
    getCurrentView = () => "main",
    isAgentViewUsesBus = () => false,
    getViewingAgent = () => "",
    writeToAgentTerm = () => {},
    consumePendingDelivery = () => false,
    getPendingState = () => null,
    beginStream = () => null,
    appendStreamDelta = () => {},
    finalizeStream = () => {},
    hasStream = () => false,
  } = options;

  function normalizeDisplayMessage(raw) {
    let displayMessage = raw || "";
    let streamPayload = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.reply) {
        displayMessage = parsed.reply;
      } else if (parsed && typeof parsed === "object" && parsed.stream) {
        streamPayload = parsed;
      }
    } catch {
      // Not JSON, keep original.
    }

    if (typeof displayMessage === "string") {
      displayMessage = displayMessage.replace(/\\n/g, "\n");
    }

    return { displayMessage, streamPayload };
  }

  function handleStatusMessage(msg) {
    const data = msg.data || {};
    if (typeof data.phase === "string") {
      const text = data.text || "";
      const item = { key: data.key, text };
      if (data.phase === BUS_STATUS_PHASES.START) {
        enqueueBusStatus(item);
      } else if (data.phase === BUS_STATUS_PHASES.DONE || data.phase === BUS_STATUS_PHASES.ERROR) {
        resolveBusStatus(item);
        if (text) {
          const prefix = data.phase === BUS_STATUS_PHASES.ERROR
            ? "{white-fg}✗{/white-fg}"
            : "{white-fg}✓{/white-fg}";
          logMessage("status", `${prefix} ${escapeBlessed(text)}`, data);
        }
      } else {
        enqueueBusStatus(item);
      }
      renderScreen();
      return false;
    }

    updateDashboard(data);
    return false;
  }

  function handleResponseMessage(msg) {
    const payload = msg.data || {};
    if (payload.reply) {
      resolveStatusLine(`{gray-fg}←{/gray-fg} ${escapeBlessed(payload.reply)}`);
      logMessage("reply", `{white-fg}←{/white-fg} ${escapeBlessed(payload.reply)}`);
    }

    if (payload.recoverable && typeof payload.recoverable === "object") {
      const recoverableList = Array.isArray(payload.recoverable.recoverable)
        ? payload.recoverable.recoverable
        : [];
      const skippedList = Array.isArray(payload.recoverable.skipped)
        ? payload.recoverable.skipped
        : [];

      if (recoverableList.length > 0) {
        logMessage("system", "{cyan-fg}Recoverable agents:{/cyan-fg}");
        recoverableList.forEach((item) => {
          const nickname = item.nickname ? ` (${item.nickname})` : "";
          const meta = item.launchMode ? ` [${item.agent}/${item.launchMode}]` : ` [${item.agent}]`;
          logMessage("system", `  • ${escapeBlessed(`${item.id}${nickname}${meta}`)}`);
        });
      } else {
        logMessage("system", "{gray-fg}No recoverable agents{/gray-fg}");
      }

      if (skippedList.length > 0) {
        logMessage("system", "{gray-fg}Skipped:{/gray-fg}");
        skippedList.forEach((item) => {
          const reason = item && item.reason ? item.reason : "skipped";
          const id = item && item.id ? item.id : "unknown";
          logMessage("system", `  - ${escapeBlessed(`${id}: ${reason}`)}`);
        });
      }
    }

    if (payload.dispatch && payload.dispatch.length > 0) {
      const targets = payload.dispatch.map((d) => d.target || d).join(", ");
      logMessage("dispatch", `{white-fg}→{/white-fg} Dispatched to: ${escapeBlessed(targets)}`);
    }

    if (
      payload.disambiguate &&
      Array.isArray(payload.disambiguate.candidates) &&
      payload.disambiguate.candidates.length > 0
    ) {
      const pending = getPending();
      setPending({ disambiguate: payload.disambiguate, original: pending && pending.original });
      const prompt = payload.disambiguate.prompt || "Choose target:";
      resolveStatusLine(`{gray-fg}?{/gray-fg} ${escapeBlessed(prompt)}`);
      logMessage("disambiguate", `{white-fg}?{/white-fg} ${escapeBlessed(prompt)}`);
      payload.disambiguate.candidates.forEach((candidate, index) => {
        logMessage(
          "disambiguate",
          `   {cyan-fg}${index + 1}){/cyan-fg} ${escapeBlessed(candidate.agent_id)} {gray-fg}— ${escapeBlessed(candidate.reason || "")}{/gray-fg}`
        );
      });
    } else {
      setPending(null);
    }

    if (!payload.reply && !payload.disambiguate) {
      resolveStatusLine("{gray-fg}✓{/gray-fg} Done");
    }

    if (Array.isArray(payload.ops) && payload.ops.length > 0) {
      const hasStateMutation = payload.ops.some((op) =>
        op && (op.action === "close" || op.action === "launch" || op.action === "rename" || op.action === "cron")
      );
      if (hasStateMutation) {
        requestStatus();
      }
    }

    renderScreen();
    return false;
  }

  function handleBusMessage(msg) {
    const data = msg.data || {};
    const prefix = data.event === "broadcast" ? "{gray-fg}⇢{/gray-fg}" : "{gray-fg}↔{/gray-fg}";
    const publisher = data.publisher && data.publisher !== "unknown"
      ? data.publisher
      : (data.event === "broadcast" ? "broadcast" : "bus");

    const { displayMessage, streamPayload } = normalizeDisplayMessage(data.message || "");

    const isAgentViewTarget =
      getCurrentView() === "agent" &&
      isAgentViewUsesBus() &&
      getViewingAgent() &&
      publisher === getViewingAgent();

    const displayName = resolveAgentDisplayName(publisher);

    if (isAgentViewTarget) {
      if (streamPayload) {
        const delta = typeof streamPayload.delta === "string"
          ? streamPayload.delta.replace(/\\n/g, "\n")
          : "";
        if (delta) writeToAgentTerm(delta);
      } else if (displayMessage) {
        writeToAgentTerm(`${displayMessage}\r\n`);
      }
      return true;
    }

    if (data.event === "delivery" && consumePendingDelivery(publisher, displayName)) {
      const ok = (data.status || "").toLowerCase() !== "error";
      const detail = typeof data.message === "string" && data.message
        ? data.message
        : (ok ? `Delivered to @${displayName}` : `Delivery failed to @${displayName}`);
      if (ok) {
        logMessage("status", `{white-fg}✓{/white-fg} ${escapeBlessed(detail)}`);
      } else {
        logMessage("error", `{white-fg}✗{/white-fg} ${escapeBlessed(detail)}`);
      }
      requestStatus();
      renderScreen();
      return true;
    }

    const pendingBeforeMessage = getPendingState(publisher, displayName);
    const prefixLabel = `${prefix} {gray-fg}${escapeBlessed(displayName)}{/gray-fg}: `;
    const continuationPrefix = " ".repeat(stripBlessedTags(prefixLabel).length);

    if (streamPayload) {
      const delta = typeof streamPayload.delta === "string"
        ? streamPayload.delta.replace(/\\n/g, "\n")
        : "";
      const state = beginStream(publisher, prefixLabel, continuationPrefix, data);
      if (delta) appendStreamDelta(state, delta);
      if (streamPayload.done) {
        finalizeStream(publisher, data, streamPayload.reason || "");
        if (data.event === "message" && pendingBeforeMessage) {
          consumePendingDelivery(publisher, displayName);
        }
      }
    } else {
      if (hasStream(publisher)) {
        finalizeStream(publisher, data, "interrupted");
      }
      const mdState = {};
      const renderedLines = renderMarkdownLines(displayMessage, mdState, escapeBlessed);
      const line = renderedLines.map((l, i) => {
        const p = i === 0 ? prefixLabel : continuationPrefix;
        return `${p}${l}`;
      }).join("\n");
      logMessage("bus", line, data);
      if (data.event === "message" && pendingBeforeMessage) {
        consumePendingDelivery(publisher, displayName);
      }
    }

    if (data.event === "agent_renamed" || data.event === "message") {
      requestStatus();
    }
    renderScreen();
    return false;
  }

  function handleErrorMessage(msg) {
    resolveStatusLine(`{gray-fg}✗{/gray-fg} Error: ${msg.error}`);
    logMessage("error", `{white-fg}✗{/white-fg} Error: ${msg.error}`);
    renderScreen();
    return false;
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== "object") return false;

    if (msg.type === IPC_RESPONSE_TYPES.STATUS) return handleStatusMessage(msg);
    if (msg.type === IPC_RESPONSE_TYPES.RESPONSE) return handleResponseMessage(msg);
    if (msg.type === IPC_RESPONSE_TYPES.BUS) return handleBusMessage(msg);
    if (msg.type === IPC_RESPONSE_TYPES.ERROR) return handleErrorMessage(msg);

    return false;
  }

  return {
    handleMessage,
  };
}

module.exports = {
  createDaemonMessageRouter,
};
