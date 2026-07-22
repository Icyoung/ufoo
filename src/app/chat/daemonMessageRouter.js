const { IPC_RESPONSE_TYPES, BUS_STATUS_PHASES } = require("../../runtime/contracts/eventContract");
const { renderMarkdownLines } = require("../../ui/format/markdownRenderer");
const { decodeEscapedNewlines } = require("./text");

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
    isAgentEventForViewingAgent = (data, viewingAgent, publisher) =>
      Boolean(viewingAgent && (publisher === viewingAgent || data?.target === viewingAgent)),
    writeToAgentTerm = () => {},
    consumePendingDelivery = () => false,
    getPendingState = () => null,
    beginStream = () => null,
    appendStreamDelta = () => {},
    finalizeStream = () => {},
    hasStream = () => false,
    setTransientAgentState = () => {},
    clearTransientAgentState = () => {},
    refreshDashboard = () => {},
  } = options;

  function isLikelySubscriberId(value) {
    const text = String(value || "");
    if (!text) return false;
    return text.includes(":") && !text.includes(" ");
  }

  function speakerPrefix(label, color = "cyan") {
    const escapedLabel = escapeBlessed(label);
    if (color === "white") {
      return `{white-fg}${escapedLabel}{/white-fg} {gray-fg}·{/gray-fg} `;
    }
    return `{cyan-fg}${escapedLabel}{/cyan-fg} {gray-fg}·{/gray-fg} `;
  }

  function launchTargetLabel(result = {}, renameResult = null) {
    const nickname = (renameResult && renameResult.ok && renameResult.nickname)
      || result.nickname
      || "";
    if (nickname) return nickname;
    const ids = Array.isArray(result.subscriber_ids) ? result.subscriber_ids : [];
    return ids[0] || result.agent_id || "";
  }

  function buildLifecycleSummary(payload = {}, msg = {}) {
    const ops = Array.isArray(payload.ops) ? payload.ops : [];
    const results = Array.isArray(msg.opsResults) ? msg.opsResults : [];
    if (ops.length === 0) return "";
    const launchOp = ops.find((op) => op && op.action === "launch");
    if (launchOp) {
      const launchResult = results.find((item) => item && item.action === "launch") || {};
      const renameResult = results.find((item) => item && item.action === "rename" && item.ok);
      if (launchResult.ok === false) {
        return `Launch failed: ${launchResult.error || "unknown error"}`;
      }
      const agent = String(launchResult.agent || launchOp.agent || "agent").trim();
      const count = Number(launchResult.count || launchOp.count || 1);
      const ids = Array.isArray(launchResult.subscriber_ids) ? launchResult.subscriber_ids.filter(Boolean) : [];
      const target = launchTargetLabel(launchResult, renameResult);
      if (launchResult.skipped && target) return `Reused ${agent}:${target}`;
      if (ids.length > 1) return `Launched ${ids.length} ${agent} agents: ${ids.join(", ")}`;
      if (target) return `Launched ${agent}:${target}`;
      if (count > 1) return `Launched ${count} ${agent} agents`;
      return `Launched a ${agent} agent`;
    }
    const closeOp = ops.find((op) => op && op.action === "close");
    if (closeOp) {
      const closeResult = results.find((item) => item && item.action === "close") || {};
      if (closeResult.ok === false) return `Close failed: ${closeResult.error || "unknown error"}`;
      return `Closed ${closeResult.agent_id || closeOp.agent_id || closeOp.target || "agent"}`;
    }
    return "";
  }

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
      displayMessage = decodeEscapedNewlines(displayMessage);
    }

    return { displayMessage, streamPayload };
  }

  function handleStatusMessage(msg) {
    const data = msg.data || {};
    if (typeof data.phase === "string") {
      const text = data.text || "";
      const item = { key: data.key, text };
      const key = typeof data.key === "string" ? data.key : "";
      if (isLikelySubscriberId(key)) {
        if (data.phase === BUS_STATUS_PHASES.START) {
          setTransientAgentState(key, "working", { detail: text });
        } else if (data.phase === BUS_STATUS_PHASES.DONE || data.phase === BUS_STATUS_PHASES.ERROR) {
          clearTransientAgentState(key);
        }
      }
      if (data.phase === BUS_STATUS_PHASES.START) {
        enqueueBusStatus(item);
      } else if (data.phase === BUS_STATUS_PHASES.DONE || data.phase === BUS_STATUS_PHASES.ERROR) {
        resolveBusStatus(item);
        if (text) {
          const prefix = data.phase === BUS_STATUS_PHASES.ERROR
            ? "{gray-fg}✗{/gray-fg}"
            : "{gray-fg}✓{/gray-fg}";
          resolveStatusLine(`${prefix} ${escapeBlessed(text)}`, data);
        }
      } else {
        enqueueBusStatus(item);
      }
      refreshDashboard();
      renderScreen();
      return false;
    }

    updateDashboard(data);
    return false;
  }

  function logGroupMembers(members = []) {
    if (!Array.isArray(members) || members.length === 0) return;
    members.forEach((member) => {
      const nickname = member && member.nickname ? member.nickname : (member && member.template_agent_id ? member.template_agent_id : "unknown");
      const type = member && member.type ? ` [${member.type}]` : "";
      const status = member && member.status ? ` (${member.status})` : "";
      const subscriber = member && member.subscriber_id ? ` -> ${member.subscriber_id}` : "";
      logMessage(
        "system",
        `  • ${escapeBlessed(`${nickname}${type}${status}${subscriber}`)}`
      );
    });
  }

  function parseGroupErrorEntry(err) {
    const errPath = err && (err.path || err.filePath) ? (err.path || err.filePath) : "template";
    const errMessage = err && (err.message || err.error) ? (err.message || err.error) : "validation error";
    return { errPath, errMessage };
  }

  function logGroupPayload(group) {
    if (!group || typeof group !== "object") return;

    if (typeof group.diagram === "string" && group.diagram) {
      const mode = group.mode ? ` ${group.mode}` : "";
      const format = group.format ? ` ${group.format}` : "";
      logMessage("system", `{cyan-fg}Group diagram:{/cyan-fg} ${escapeBlessed(`${mode}${format}`.trim())}`);
      group.diagram.split(/\r?\n/).forEach((line) => {
        logMessage("system", escapeBlessed(line));
      });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(group, "target") && Array.isArray(group.errors)) {
      if (group.ok) {
        const alias = group.alias || group.target || "";
        const source = group.source ? ` (${group.source})` : "";
        logMessage("system", `{white-fg}✓{/white-fg} Group template valid: ${escapeBlessed(`${alias}${source}`)}`);
      } else {
        logMessage("error", `{white-fg}✗{/white-fg} Group template invalid: ${escapeBlessed(group.target || group.alias || "unknown")}`);
        group.errors.forEach((err) => {
          const { errPath, errMessage } = parseGroupErrorEntry(err);
          logMessage("error", `  - ${escapeBlessed(`${errPath}: ${errMessage}`)}`);
        });
      }
      return;
    }

    if (Array.isArray(group.groups)) {
      logMessage("system", `{cyan-fg}Groups:{/cyan-fg} ${group.groups.length}`);
      group.groups.forEach((item) => {
        const id = item && item.group_id ? item.group_id : "unknown";
        const status = item && item.status ? item.status : "unknown";
        const alias = item && item.template_alias ? item.template_alias : "-";
        const active = Number(item && item.members_active) || 0;
        const total = Number(item && item.members_total) || 0;
        logMessage(
          "system",
          `  • ${escapeBlessed(id)} [${escapeBlessed(status)}] ${escapeBlessed(alias)} active=${active}/${total}`
        );
      });
      return;
    }

    if (group.group && typeof group.group === "object") {
      const runtime = group.group;
      const id = runtime.group_id || group.group_id || "unknown";
      const status = runtime.status || group.status || "unknown";
      const alias = runtime.template_alias || group.template_alias || "-";
      logMessage(
        "system",
        `{cyan-fg}Group:{/cyan-fg} ${escapeBlessed(id)} [${escapeBlessed(status)}] ${escapeBlessed(alias)}`
      );
      logGroupMembers(runtime.members);
      if (Array.isArray(group.stopped_agents) && group.stopped_agents.length > 0) {
        logMessage("system", `{white-fg}Stopped:{/white-fg} ${group.stopped_agents.length} agent(s)`);
      }
      return;
    }

    if (group.group_id && Array.isArray(group.members)) {
      const status = group.dry_run ? "dry_run" : (group.status || "unknown");
      const alias = group.template_alias || "-";
      logMessage(
        "system",
        `{cyan-fg}Group:{/cyan-fg} ${escapeBlessed(group.group_id)} [${escapeBlessed(status)}] ${escapeBlessed(alias)}`
      );
      logGroupMembers(group.members);
      return;
    }

    if (group.ok === false && group.error) {
      logMessage("error", `{white-fg}✗{/white-fg} ${escapeBlessed(group.error)}`);
      const validationErrors = Array.isArray(group.validationErrors)
        ? group.validationErrors
        : (Array.isArray(group.errors) ? group.errors : []);
      validationErrors.forEach((err) => {
        const { errPath, errMessage } = parseGroupErrorEntry(err);
        logMessage("error", `  - ${escapeBlessed(`${errPath}: ${errMessage}`)}`);
      });
    }
  }

  function handleResponseMessage(msg) {
    const payload = msg.data || {};
    if (payload.reply) {
      const replyText = decodeEscapedNewlines(payload.reply);
      resolveStatusLine(`{gray-fg}←{/gray-fg} ${escapeBlessed(replyText)}`);
      const ops = Array.isArray(payload.ops) ? payload.ops : [];
      const isLifecycleStatusOnly = ops.length > 0
        && ops.every((op) => op && (op.action === "close" || op.action === "launch"));
      const group = payload.group && typeof payload.group === "object" ? payload.group : null;
      const isGroupStartedConfirmation = Boolean(
        group &&
        group.group_id &&
        Array.isArray(group.members) &&
        !group.dry_run &&
        /^Group started\b/i.test(replyText)
      );
      // Suppress lifecycle confirmations from chat history — status line plus structured payload is enough.
      if (isLifecycleStatusOnly) {
        const summary = buildLifecycleSummary(payload, msg);
        if (summary) logMessage("reply", `${speakerPrefix("ufoo", "white")}${escapeBlessed(summary)}`);
      } else if (!isGroupStartedConfirmation) {
        logMessage("reply", `${speakerPrefix("ufoo", "white")}${escapeBlessed(replyText)}`);
      }
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
          const displayNickname = item.display_nickname || item.nickname || "";
          const nickname = displayNickname ? ` (${displayNickname})` : "";
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

    if (payload.cron && typeof payload.cron === "object") {
      const cron = payload.cron;
      const operation = String(cron.operation || "").toLowerCase();
      if (!cron.ok) {
        logMessage("error", `{white-fg}✗{/white-fg} ${escapeBlessed(cron.error || "cron failed")}`);
      } else if (operation === "list" || operation === "ls") {
        const tasks = Array.isArray(cron.tasks) ? cron.tasks : [];
        if (tasks.length === 0) {
          logMessage("system", "{cyan-fg}Cron:{/cyan-fg} none");
        } else {
          logMessage("system", `{cyan-fg}Cron:{/cyan-fg} ${tasks.length} task(s)`);
          tasks.forEach((task) => {
            const summary = task && (task.summary || task.id) ? (task.summary || task.id) : "";
            if (summary) {
              logMessage("system", `  • ${escapeBlessed(summary)}`);
            }
          });
        }
      } else if (operation === "start" && cron.task) {
        const task = cron.task;
        if (task.mode === "once") {
          logMessage(
            "system",
            `{white-fg}✓{/white-fg} Cron scheduled ${escapeBlessed(task.id)}: ${escapeBlessed(task.label || task.onceAt || String(task.onceAtMs || ""))}`
          );
        } else {
          logMessage(
            "system",
            `{white-fg}✓{/white-fg} Cron started ${escapeBlessed(task.id)}: ${escapeBlessed(task.label || task.interval || String(task.intervalMs || ""))}`
          );
        }
      } else if (operation === "stop") {
        if (cron.id === "all") {
          logMessage("system", `{white-fg}✓{/white-fg} Stopped ${Number(cron.stopped) || 0} cron task(s)`);
        } else if (cron.id) {
          logMessage("system", `{white-fg}✓{/white-fg} Stopped cron task ${escapeBlessed(cron.id)}`);
        }
      }
    }

    if (payload.group && typeof payload.group === "object") {
      logGroupPayload(payload.group);
    }

    if (payload.dispatch && payload.dispatch.length > 0) {
      const targets = payload.dispatch.map((d) => d.target || d).join(", ");
      resolveStatusLine(`{gray-fg}→{/gray-fg} Dispatched to: ${escapeBlessed(targets)}`);
    }

    if (
      payload.disambiguate &&
      Array.isArray(payload.disambiguate.candidates) &&
      payload.disambiguate.candidates.length > 0
    ) {
      const pending = getPending();
      const routedProjectRoot = payload.routed_project && payload.routed_project.project_root
        ? payload.routed_project.project_root
        : (pending && pending.project_root ? pending.project_root : "");
      setPending({
        disambiguate: payload.disambiguate,
        original: pending && pending.original,
        project_root: routedProjectRoot || undefined,
      });
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
    if (data.event === "activity_state_changed") {
      const agentId = String(data.subscriber || data.publisher || "").trim();
      const state = String(data.state || data.activity_state || "").trim();
      const detailSource = data.detail || (data.data && data.data.detail) || data.message || "";
      if (agentId && state) {
        const normalized = state.toLowerCase();
        if (normalized === "idle" || normalized === "ready") {
          clearTransientAgentState(agentId);
        } else {
          setTransientAgentState(agentId, state, { detail: detailSource });
        }
        refreshDashboard();
      }
      requestStatus();
      return true;
    }
    if (data.event === "controller_report") {
      const report = data.report && typeof data.report === "object" ? data.report : {};
      const publisher = report.agent_id || data.publisher || "ufoo-agent";
      const displayName = resolveAgentDisplayName(publisher);
      const detail = report.summary || report.message || data.message || report.task_id || "report";
      logMessage("report", `${speakerPrefix(displayName)}${escapeBlessed(detail)}`, data);
      requestStatus();
      renderScreen();
      return true;
    }
    const publisher = data.publisher && data.publisher !== "unknown"
      ? data.publisher
      : (data.event === "broadcast" ? "broadcast" : "bus");

    const { displayMessage, streamPayload } = normalizeDisplayMessage(data.message || "");

    // Skip silent events (e.g. delivery confirmations from notifier) and empty messages
    if (data.silent && !streamPayload) return true;
    if (!displayMessage && !streamPayload) return true;

    const viewingAgent = getViewingAgent();
    const isOwnInternalPrompt =
      data.source === "chat-internal-agent-view" &&
      viewingAgent &&
      data.target === viewingAgent &&
      publisher !== viewingAgent;
    if (
      getCurrentView() === "agent" &&
      isAgentViewUsesBus() &&
      isOwnInternalPrompt
    ) {
      return true;
    }
    const isAgentViewTarget =
      getCurrentView() === "agent" &&
      isAgentViewUsesBus() &&
      viewingAgent &&
      isAgentEventForViewingAgent(data, viewingAgent, publisher);

    const displayName = resolveAgentDisplayName(publisher);

    if (isAgentViewTarget) {
      if (streamPayload) {
        const delta = typeof streamPayload.delta === "string"
          ? decodeEscapedNewlines(streamPayload.delta)
          : "";
        if (delta || streamPayload.done) {
          writeToAgentTerm(delta, {
            data,
            publisher,
            streamPayload,
            done: Boolean(streamPayload.done),
            reason: streamPayload.reason || "",
          });
        }
      } else if (displayMessage) {
        writeToAgentTerm(`${displayMessage}\r\n`);
      }
      return true;
    }

    if (data.event === "delivery" && consumePendingDelivery(publisher, displayName)) {
      // Delivery confirmations are already shown in the status bar — suppress from chat.
      requestStatus();
      renderScreen();
      return true;
    }

    const pendingBeforeMessage = getPendingState(publisher, displayName);
    const prefixLabel = speakerPrefix(displayName);
    const continuationPrefix = " ".repeat(stripBlessedTags(prefixLabel).length);

    if (streamPayload) {
      const delta = typeof streamPayload.delta === "string"
        ? decodeEscapedNewlines(streamPayload.delta)
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
    const error = String(msg.error || "unknown error");
    resolveStatusLine(`{gray-fg}✗{/gray-fg} Error: ${error}`);
    logMessage("error", `{white-fg}✗{/white-fg} ${escapeBlessed(error)}`);
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
