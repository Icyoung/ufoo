"use strict";

/**
 * Phase 1 Rust chat host: Node owns daemon + history; ufoo-tui owns TTY.
 *
 * Opt-in via UFOO_TUI=rust; UFOO_TUI=auto prefers Rust when binary exists.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createUiHostServer, createAuthToken } = require("./uiHostServer");
const { resolveTuiLaunchPlan } = require("./tuiLauncher");
const { createToolMergePublisher } = require("./toolMergeBridge");
const { createRustMultiSession } = require("./rustMultiSession");
const { writeMultiPaneBusEvent } = require("./multiPaneBusMirror");
const { buildSettingsSnapshot, applySettingsPatch } = require("./settingsBridge");
const fmt = require("./format");
const {
  loadGlobalProjectRows,
  buildDashboardPublishPayload,
} = require("./dashboardBridge");
const { createChatController } = require("../app/chat/ChatController");
const {
  resolveAgentEnterRequest,
  resolveDashboardAgentEnterAction,
} = require("../app/chat/agentEnter");
const { loadConfig } = require("../config");
const { bootstrapEnvironment, ensureSubscriberId } = require("../app/chat/bootstrap");
const {
  createEnvelope,
  encodeMessage,
  MULTI_FRAMES_CAPABILITY,
} = require("../runtime/contracts/uiProtocol");
const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES } = require("../runtime/contracts/eventContract");
const { createDaemonMessageRouter } = require("../app/chat/daemonMessageRouter");
const {
  resolveDaemonEndpoint,
  routeDaemonRequest,
} = require("../runtime/daemon/endpoint");
const PACKAGE_VERSION = require("../../package.json").version;

function stripTags(value) {
  return String(value || "").replace(/\{[^}]+\}/g, "");
}

function historyToEntries(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const markdownState = { inCodeBlock: false };
  const MARKDOWN_KINDS = new Set(["assistant", "agent", "report", "error"]);
  const out = [];
  list.forEach((row, index) => {
    if (typeof row === "string") {
      out.push({
        id: `hist-${index}`,
        kind: "system",
        text: stripTags(row),
        speaker: "",
      });
      return;
    }
    const sourceType = String(row && (row.sourceType || row.type || row.kind) || "system");
    const kind = sourceType === "user" || sourceType === "assistant" || sourceType === "error"
      || sourceType === "agent" || sourceType === "report"
      ? sourceType
      : "system";
    const raw = String(row && (row.text || row.content || ""));
    const speaker = String(row && row.speaker || "");
    if (MARKDOWN_KINDS.has(kind)) {
      let lines;
      try {
        lines = fmt.renderLogLinesWithMarkdownAnsi(raw, markdownState);
        if (!Array.isArray(lines) || lines.length === 0) lines = raw.split(/\r?\n/);
      } catch {
        lines = raw.split(/\r?\n/);
      }
      lines.forEach((line, lineIdx) => {
        out.push({
          id: `hist-${index}-${lineIdx}`,
          kind,
          text: String(line || ""),
          speaker: lineIdx === 0 ? speaker : "",
        });
      });
      return;
    }
    out.push({
      id: `hist-${index}`,
      kind,
      text: stripTags(raw),
      speaker,
    });
  });
  return out;
}

/** Ink parity: `/group run` / `/solo run` dynamic argument lists. */
function loadDynamicCompletionSources(root) {
  const sources = { groupTemplates: [], soloProfiles: [] };
  try {
    const { loadTemplateRegistry } = require("../orchestration/groups/templates");
    const reg = typeof loadTemplateRegistry === "function" ? loadTemplateRegistry(root) : null;
    if (reg && Array.isArray(reg.templates)) {
      sources.groupTemplates = reg.templates.map((item) => ({
        alias: item.alias,
        cmd: item.alias,
        desc: item.templateDescription || "",
        source: item.source || "",
      }));
    }
  } catch {
    // ignore registry load failures
  }
  try {
    const { loadPromptProfileRegistry } = require("../orchestration/groups/promptProfiles");
    const { buildPromptProfileCandidates } = require("../orchestration/solo/commands");
    const reg = typeof loadPromptProfileRegistry === "function"
      ? loadPromptProfileRegistry(root)
      : null;
    if (reg && typeof buildPromptProfileCandidates === "function") {
      sources.soloProfiles = buildPromptProfileCandidates(reg) || [];
    }
  } catch {
    // ignore registry load failures
  }
  return sources;
}

async function runChatRust(projectRoot, options = {}) {
  const plan = resolveTuiLaunchPlan({
    mode: options.tuiMode || process.env.UFOO_TUI || "rust",
    requireRust: true,
  });
  if (plan.mode !== "rust" || !plan.binary) {
    const err = new Error(`Rust TUI unavailable (${plan.reason || "unknown"})`);
    err.code = "UFOO_TUI_UNAVAILABLE";
    err.plan = plan;
    throw err;
  }

  const env = bootstrapEnvironment(projectRoot, options);
  if (env.needsBootstrap || !fs.existsSync(env.runtimePaths.ufooDir)) {
    const repoRoot = path.join(__dirname, "..", "..");
    const init = new env.UfooInit(repoRoot);
    await init.init({
      targets: "context,bus",
      project: projectRoot,
      controllerMode: env.globalMode,
    });
  }
  await ensureSubscriberId(projectRoot);
  const initialDaemonEndpoint = resolveDaemonEndpoint(projectRoot);
  const initialDaemonRoot = initialDaemonEndpoint.scope === "global"
    ? initialDaemonEndpoint.controllerRoot
    : initialDaemonEndpoint.projectRoot;
  if (!env.isRunning(initialDaemonRoot)) {
    env.startDaemon(projectRoot);
  }

  const { connectWithRetry } = require("../app/chat/transport");
  const { createDaemonTransport } = require("../app/chat/daemonTransport");
  const { createDaemonConnection } = require("../app/chat/daemonConnection");

  const sock = initialDaemonEndpoint.socketPath;
  const daemonTransport = createDaemonTransport({
    projectRoot,
    sockPath: sock,
    daemonRoot: initialDaemonRoot,
    isRunning: env.isRunning,
    startDaemon: env.startDaemon,
    connectWithRetry,
  });

  let entrySeq = 0;
  const streamIds = new Map();
  let hostRef = null;
  let daemonSend = () => {};
  let daemonCoordinator = null;
  let routedMessageHandler = () => {};
  let activeProjectRoot = projectRoot;
  let globalScope = "controller";
  let agentViewId = "";
  let multiSession = null;
  /** Internal pane agents currently BUS_WATCH'd for multi/side inbound. */
  const watchedInternalAgents = new Set();
  const settings = (() => {
    try {
      return loadConfig(projectRoot) || {};
    } catch {
      return {};
    }
  })();

  function historyOptions() {
    const { chatHistoryOptionsForScope } = require("../app/chat/historyStore");
    return chatHistoryOptionsForScope({
      globalMode: Boolean(env.globalMode),
      globalScope,
    });
  }

  function sendInternalAgentWatch(agentId, enabled) {
    const id = String(agentId || "").trim();
    if (!id) return;
    try {
      daemonSend({
        type: IPC_REQUEST_TYPES.BUS_WATCH,
        agent_id: id,
        enabled: enabled !== false,
      });
    } catch {
      // ignore
    }
  }

  function reconcileMultiInternalWatches() {
    const next = new Set();
    if (multiSession && multiSession.isActive()
        && typeof multiSession.listInternalAgentIds === "function") {
      for (const id of multiSession.listInternalAgentIds()) {
        next.add(id);
      }
    }
    for (const id of next) {
      if (!watchedInternalAgents.has(id)) sendInternalAgentWatch(id, true);
    }
    for (const id of watchedInternalAgents) {
      if (!next.has(id)) sendInternalAgentWatch(id, false);
    }
    watchedInternalAgents.clear();
    for (const id of next) watchedInternalAgents.add(id);
  }

  function mirrorBusToMultiPanes(data = {}) {
    if (!multiSession || !multiSession.isActive()) return false;
    if (typeof multiSession.writeToPane !== "function") return false;
    const ids = typeof multiSession.listInternalAgentIds === "function"
      ? multiSession.listInternalAgentIds()
      : [...watchedInternalAgents];
    if (!ids || ids.length === 0) return false;
    return writeMultiPaneBusEvent(data, {
      agentIds: ids,
      getMeta: (agentId) => {
        try { return controller.session.metaMap.get(agentId) || {}; } catch { return {}; }
      },
      writeToPane: (agentId, text) => multiSession.writeToPane(agentId, text),
    });
  }

  function publishDashboardFromStatus(data = {}) {
    const payload = buildDashboardPublishPayload(controller, data);
    publish("agents.snapshot", {
      agents: payload.agents,
      footer: payload.footer,
    });
    if (multiSession && multiSession.isActive()) {
      try { multiSession.syncAgents(); } catch {}
      try { reconcileMultiInternalWatches(); } catch {}
    }
    publish("cron.snapshot", {
      tasks: payload.cron,
      cron: payload.cron,
      loop: payload.loop,
      loop_summary: payload.loop_summary,
    });
    if (payload.loop_summary) {
      publish("loop.set", { text: payload.loop_summary, loop_summary: payload.loop_summary });
    }
  }

  function publishProjects() {
    if (!env.globalMode) {
      publish("projects.snapshot", {
        global_mode: false,
        controller_root: projectRoot,
        active_root: activeProjectRoot,
        scope: globalScope,
        projects: [],
      });
      return [];
    }
    const projects = loadGlobalProjectRows(activeProjectRoot);
    publish("projects.snapshot", {
      global_mode: true,
      controller_root: projectRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      projects,
    });
    return projects;
  }

  function publish(name, payload) {
    if (!hostRef) return;
    hostRef.broadcast(hostRef.createEvent(name, payload, {
      surface: "chat",
      project_id: projectRoot,
    }));
  }

  function publishLossy(name, payload) {
    if (!hostRef) return;
    hostRef.broadcast(hostRef.createLossyEvent(name, payload, {
      surface: "chat",
      project_id: projectRoot,
    }));
  }

  function listProjectsForCommands() {
    return loadGlobalProjectRows(activeProjectRoot).map((row) => ({
      project_root: row.root,
      project_name: row.label,
      status: row.status,
      label: row.label,
      root: row.root,
    }));
  }

  function resolveSwitchTargetRoot(target = {}) {
    const rawTarget = String(
      (target && (target.projectRoot || target.project_root || target.root || target.target))
      || target
      || ""
    ).trim();
    if (!rawTarget) return "";
    if (/^\d+$/.test(rawTarget)) {
      const idx = Number.parseInt(rawTarget, 10) - 1;
      const projects = listProjectsForCommands();
      return String((projects[idx] && (projects[idx].project_root || projects[idx].root)) || "");
    }
    return rawTarget;
  }

  const tools = createToolMergePublisher((name, payload) => publish(name, payload));

  const hostApi = {
    async switchToProjectRoot(targetRoot, options = {}) {
      const root = String(targetRoot || "").trim();
      if (!root) return { ok: false, error: "project root unavailable" };
      const pathMod = require("path");
      const label = pathMod.basename(root) || root;

      if (multiSession && multiSession.isActive()) {
        multiSession.stop();
      }

      const targetEndpoint = resolveDaemonEndpoint(root);
      const targetDaemonRoot = targetEndpoint.scope === "global"
        ? targetEndpoint.controllerRoot
        : targetEndpoint.projectRoot;
      if (
        env.globalMode
        && targetEndpoint.scope === "project"
        && typeof env.isRunning === "function"
        && !env.isRunning(targetDaemonRoot)
      ) {
        try {
          const { markProjectStopped } = require("../runtime/projects");
          markProjectStopped(root);
        } catch {
          // ignore
        }
        publishProjects();
        appendLocal("system", `Project ${label} is not running; removed stale dashboard entry`);
        return { ok: false, error: `project is not running: ${label}`, stopped: true };
      }

      if (agentViewId) {
        try {
          daemonSend({
            type: IPC_REQUEST_TYPES.BUS_WATCH,
            agent_id: agentViewId,
            enabled: false,
          });
        } catch {
          // ignore
        }
        agentViewId = "";
        publish("agent.view.close", {});
      }

      if (daemonCoordinator && typeof daemonCoordinator.switchProject === "function") {
        const res = await daemonCoordinator.switchProject({
          projectRoot: root,
          sockPath: targetEndpoint.socketPath,
          daemonRoot: targetDaemonRoot,
          transformRequest: (request) => routeDaemonRequest(targetEndpoint, request),
          autoStart: options.autoStart === true,
        });
        if (!res || res.ok !== true) {
          appendLocal("error", `Switch failed: ${(res && res.error) || "switch failed"}`);
          return res || { ok: false, error: "switch failed" };
        }
      }

      activeProjectRoot = root;
      globalScope = root === projectRoot ? "controller" : "project";
      controller.session.targetAgent = null;
      controller.session.agents = [];
      controller.session.metaMap.clear();
      controller.session.labelMap.clear();
      controller.session.footer = "";
      publish("agents.snapshot", { agents: [], footer: "no agents" });
      publish("prompt.set_prefix", { prefix: "› " });
      publishProjects();
      publish("app.snapshot", buildSnapshot());
      publish("status.set", { text: `project ${options.label || label}` });
      if (typeof controller.requestDaemonStatus === "function") {
        controller.requestDaemonStatus();
      }
      return { ok: true, project_root: root, root };
    },
    async switchToControllerRoot() {
      if (multiSession && multiSession.isActive()) {
        multiSession.stop();
      }
      if (!env.globalMode) {
        return { ok: true, project_root: projectRoot, root: projectRoot };
      }
      if (daemonCoordinator && typeof daemonCoordinator.switchProject === "function") {
        const controllerEndpoint = resolveDaemonEndpoint(projectRoot);
        const res = await daemonCoordinator.switchProject({
          projectRoot,
          sockPath: controllerEndpoint.socketPath,
          daemonRoot: controllerEndpoint.scope === "global"
            ? controllerEndpoint.controllerRoot
            : controllerEndpoint.projectRoot,
          transformRequest: (request) => routeDaemonRequest(controllerEndpoint, request),
        });
        if (!res || res.ok !== true) {
          appendLocal("error", `Switch to global failed: ${(res && res.error) || "switch failed"}`);
          return res || { ok: false, error: "switch to global failed" };
        }
      }
      if (agentViewId) {
        try {
          daemonSend({
            type: IPC_REQUEST_TYPES.BUS_WATCH,
            agent_id: agentViewId,
            enabled: false,
          });
        } catch {
          // ignore
        }
        agentViewId = "";
        publish("agent.view.close", {});
      }
      activeProjectRoot = projectRoot;
      globalScope = "controller";
      controller.session.targetAgent = null;
      controller.session.agents = [];
      controller.session.metaMap.clear();
      controller.session.labelMap.clear();
      controller.session.footer = "";
      publish("agents.snapshot", { agents: [], footer: "no agents" });
      publish("prompt.set_prefix", { prefix: "› " });
      publishProjects();
      publish("app.snapshot", buildSnapshot());
      publish("status.set", { text: "global controller" });
      if (typeof controller.requestDaemonStatus === "function") {
        controller.requestDaemonStatus();
      }
      return { ok: true, project_root: projectRoot, root: projectRoot };
    },
    openBusAgentView(agentId, label = "") {
      const id = String(agentId || "").trim();
      if (!id) return { ok: false, error: "missing agent_id" };
      const viewLabel = String(label || id);
      if (agentViewId && agentViewId !== id) {
        try {
          daemonSend({
            type: IPC_REQUEST_TYPES.BUS_WATCH,
            agent_id: agentViewId,
            enabled: false,
          });
        } catch {
          // ignore
        }
      }
      agentViewId = id;
      controller.session.targetAgent = null;
      publish("prompt.set_prefix", { prefix: "› " });
      try {
        const { loadInternalAgentLogHistory } = require("../app/chat/internalAgentLogHistory");
        const history = loadInternalAgentLogHistory(activeProjectRoot, id, {
          width: 80,
        }) || [];
        const entries = historyToEntries(
          Array.isArray(history) ? history.map((line) => String(line || "")) : []
        );
        publish("agent.view.open", {
          agent_id: id,
          label: viewLabel,
          status: "ready",
          entries,
        });
      } catch {
        publish("agent.view.open", {
          agent_id: id,
          label: viewLabel,
          status: "ready",
          entries: [],
        });
      }
      try {
        daemonSend({
          type: IPC_REQUEST_TYPES.BUS_WATCH,
          agent_id: id,
          enabled: true,
        });
      } catch {
        // ignore
      }
      return { ok: true, mode: "agent_view", agent_id: id };
    },
    isInternalAgent(agentId) {
      const id = String(agentId || "").trim();
      if (!id) return false;
      const enter = resolveAgentEnterRequest({
        agentId: id,
        projectRoot: activeProjectRoot,
        activeAgentMeta: controller.session.metaMap,
        settings,
      });
      if (enter && enter.useBus) return true;
      // UI launch mode internal + agent without activate/socket → treat as bus.
      const mode = String(settings.launchMode || settings.launch_mode || "").trim();
      if (mode === "internal" && enter && !enter.supportsActivate && !enter.supportsSocket) {
        return true;
      }
      return false;
    },
    /** Internal activate: split like multi-with-1-agent (kind=side). Not /multi. */
    startSide(agentId) {
      const id = String(agentId || "").trim();
      if (!id) return { ok: false, error: "missing agent_id" };
      if (!multiSession) return { ok: false, error: "split session not initialised" };
      // Prefer capability check, but do not hard-fail — connected Rust child
      // may be mid-handshake; multi.set is still the right wire.
      const caps = hostRef && typeof hostRef.getClientCapabilities === "function"
        ? hostRef.getClientCapabilities()
        : [];
      if (caps.length > 0 && !caps.includes(MULTI_FRAMES_CAPABILITY)) {
        return {
          ok: false,
          error: `Rust TUI lacks ${MULTI_FRAMES_CAPABILITY}; rebuild ufoo-tui`,
        };
      }
      // Close fullscreen AgentView if it was open.
      if (agentViewId) {
        try {
          daemonSend({
            type: IPC_REQUEST_TYPES.BUS_WATCH,
            agent_id: agentViewId,
            enabled: false,
          });
        } catch {
          // ignore
        }
        agentViewId = "";
        publish("agent.view.close", {});
      }
      // /multi stays /multi — stop it before entering side.
      if (multiSession.isMultiKind && multiSession.isMultiKind()) {
        multiSession.stop();
      }
      const result = multiSession.start({
        kind: "side",
        agentIds: [id],
        focus: { target: "agent", agent_id: id },
      });
      if (result && result.ok) {
        controller.session.targetAgent = null;
        publish("prompt.set_prefix", { prefix: "› " });
        publish("status.set", { text: "ready" });
        try { reconcileMultiInternalWatches(); } catch { /* ignore */ }
        return result;
      }
      return result || { ok: false, error: "side start failed" };
    },
    enterAgentView(agentId, options = {}) {
      const id = String(agentId || "").trim();
      if (!id) return;
      const enter = resolveAgentEnterRequest({
        agentId: id,
        projectRoot: activeProjectRoot,
        activeAgentMeta: controller.session.metaMap,
        settings,
      });
      const label = (() => {
        const meta = controller.session.metaMap.get(id) || {};
        return meta.display_nickname || meta.nickname || id;
      })();
      const action = options.useBus
        ? "internal"
        : resolveDashboardAgentEnterAction(enter);
      const isInternal = action === "internal"
        || (enter && enter.useBus)
        || options.useBus;

      // /multi (including internal panes): focus the in-window pane.
      if (multiSession && multiSession.isMultiKind && multiSession.isMultiKind()) {
        try { multiSession.syncAgents(); } catch {}
        const focused = multiSession.focusAgent(id);
        if (focused && focused.ok) {
          appendLocal("system", `Multi focus → ${id}`);
          return { ok: true, mode: "multi_focus", agent_id: id };
        }
      }

      // Non-multi internal activate → side (same chrome as multi×1).
      if (isInternal) {
        const side = hostApi.startSide(id);
        if (side && side.ok) {
          return { ok: true, mode: "side", agent_id: id };
        }
        appendLocal("error", (side && side.error) || "side start failed");
        return side || { ok: false, error: "side start failed" };
      }

      // Already in side for this agent: re-focus.
      if (multiSession && multiSession.isSideKind && multiSession.isSideKind()) {
        const focused = multiSession.focusAgent(id);
        if (focused && focused.ok) {
          return { ok: true, mode: "side", agent_id: id };
        }
        // Different agent — switch side target.
        const side = hostApi.startSide(id);
        if (side && side.ok) return { ok: true, mode: "side", agent_id: id };
      }

      // Ink parity: activate = focus the agent's external terminal window/tab.
      if (action === "activate") {
        try {
          const AgentActivator = require("../coordination/bus/activate");
          const activator = new AgentActivator(activeProjectRoot || projectRoot);
          void activator.activate(id).catch((err) => {
            appendLocal(
              "error",
              `Failed to activate ${id}: ${err && err.message ? err.message : err}`
            );
          });
          appendLocal("system", `Activated ${label}`);
          return { ok: true, mode: "activate", agent_id: id };
        } catch (err) {
          appendLocal(
            "error",
            `Failed to activate ${id}: ${err && err.message ? err.message : err}`
          );
          return { ok: false, mode: "activate", agent_id: id, error: String(err && err.message || err) };
        }
      }

      // No PTY fullscreen handoff — host/socket agents need activate capability.
      appendLocal(
        "error",
        `Cannot enter ${label}: no activate support (host should expose activate; use /mode terminal|tmux|internal otherwise)`
      );
      return { ok: false, mode: "none", agent_id: id, error: "no activate support" };
    },
    getAgentAdapter(agentId) {
      try {
        const { createTerminalAdapterRouter } = require("../runtime/terminal/adapterRouter");
        const meta = controller.session.metaMap.get(agentId) || {};
        const launchMode = String(
          meta.launch_mode || meta.launchMode || settings.launchMode || ""
        ).trim();
        return createTerminalAdapterRouter().getAdapter({ launchMode, agentId, meta });
      } catch {
        return null;
      }
    },
  };

  function appendLocal(kind, text, speaker = "") {
    const MARKDOWN_KINDS = new Set(["assistant", "agent", "report", "error"]);
    const raw = String(text == null ? "" : text);
    let lines = [raw];
    if (MARKDOWN_KINDS.has(kind)) {
      try {
        if (!appendLocal._mdState) appendLocal._mdState = { inCodeBlock: false };
        lines = fmt.renderLogLinesWithMarkdownAnsi(raw, appendLocal._mdState);
        if (!Array.isArray(lines) || lines.length === 0) lines = raw.split(/\r?\n/);
      } catch {
        lines = raw.split(/\r?\n/);
      }
    }
    let last = null;
    for (let i = 0; i < lines.length; i += 1) {
      entrySeq += 1;
      const line = String(lines[i] || "");
      last = {
        id: `live-${entrySeq}`,
        kind,
        text: /\x1b\[/.test(line) ? line : stripTags(line),
        speaker: i === 0 ? speaker : "",
      };
      publish("transcript.append", last);
    }
    try {
      const { appendChatHistory } = require("../app/chat/historyStore");
      appendChatHistory(
        activeProjectRoot || projectRoot,
        kind,
        text,
        { speaker },
        historyOptions()
      );
    } catch {
      controller.appendChatHistory(kind, text, { speaker });
    }
    return last;
  }

  const controller = createChatController({
    projectRoot,
    globalMode: env.globalMode,
    ports: {
      publish,
      logMessage: (kind, text) => {
        const normalized = kind === "error" ? "error"
          : kind === "user" ? "user"
            : kind === "assistant" ? "assistant"
              : "system";
        appendLocal(normalized, text);
      },
      setStatus: (text) => publish("status.set", { text: stripTags(text || "ready") }),
      appendHistory: (type, text, meta = {}) => {
        const { appendChatHistory } = require("../app/chat/historyStore");
        appendChatHistory(activeProjectRoot || projectRoot, type, text, meta, historyOptions());
      },
      getHistoryOptions: () => historyOptions(),
      clearLog: () => {
        try {
          const { chatHistoryFilePath } = require("../app/chat/historyStore");
          const fs = require("fs");
          const file = chatHistoryFilePath(activeProjectRoot || projectRoot, historyOptions());
          if (file && fs.existsSync(file)) fs.writeFileSync(file, "");
        } catch {
          // ignore
        }
        publish("transcript.reset", {});
      },
      restartDaemon: async () => {
        if (daemonCoordinator && typeof daemonCoordinator.restart === "function") {
          await daemonCoordinator.restart();
          return;
        }
        const { restartDaemonLifecycle } = require("../runtime/daemon/restart");
        const { startDaemon, stopDaemon } = require("../app/chat/transport");
        await restartDaemonLifecycle({
          projectRoot: activeProjectRoot || projectRoot,
          stopDaemon: (root) => stopDaemon(root, { source: "rust-command:/daemon restart" }),
          startDaemon,
        });
      },
      isDaemonRunning: (root) => {
        const { isRunning } = require("../runtime/daemon");
        return isRunning(root || activeProjectRoot || projectRoot);
      },
      enterAgentView: (...args) => hostApi.enterAgentView(...args),
      getAgentAdapter: (...args) => hostApi.getAgentAdapter(...args),
      focusMultiPane: async (agentId) => {
        // /multi: focus pane (terminal or internal — multi unchanged).
        if (multiSession && multiSession.isMultiKind && multiSession.isMultiKind()) {
          try { multiSession.syncAgents(); } catch { /* ignore */ }
          const focused = multiSession.focusAgent(agentId);
          if (focused && focused.ok) {
            appendLocal("system", `Multi focus → ${agentId}`);
            return true;
          }
          return false;
        }
        // Non-multi internal → side split (not user-facing /multi).
        if (hostApi.isInternalAgent(agentId)) {
          const side = hostApi.startSide(agentId);
          return Boolean(side && side.ok);
        }
        return false;
      },
      activateAgent: async (agentId) => {
        if (multiSession && multiSession.isMultiKind && multiSession.isMultiKind()) {
          try { multiSession.syncAgents(); } catch { /* ignore */ }
          const focused = multiSession.focusAgent(agentId);
          if (focused && focused.ok) {
            appendLocal("system", `Multi focus → ${agentId}`);
            return;
          }
        }
        if (hostApi.isInternalAgent(agentId)) {
          const side = hostApi.startSide(agentId);
          if (!side || !side.ok) {
            appendLocal("error", (side && side.error) || "side start failed");
          }
          return;
        }
        const AgentActivator = require("../coordination/bus/activate");
        const activator = new AgentActivator(activeProjectRoot || projectRoot);
        await activator.activate(agentId);
      },
      listProjects: () => listProjectsForCommands(),
      getCurrentProject: () => ({ project_root: activeProjectRoot }),
      getActiveProjectRoot: () => activeProjectRoot,
      switchProject: async (target) => {
        const root = resolveSwitchTargetRoot(target);
        if (!root) return { ok: false, error: "project root unavailable" };
        return hostApi.switchToProjectRoot(root, { focusInput: true });
      },
      dispatch: (action) => {
        if (!action || typeof action !== "object") return;
        if (action.type === "stream/begin") {
          tools.beginScope();
          const speaker = String(action.publisher || "");
          const id = `stream-${speaker || "agent"}-${Date.now()}`;
          streamIds.set(speaker, id);
          publish("stream.start", { id, speaker });
          return;
        }
        if (action.type === "stream/delta") {
          const key = String(action.publisher || "");
          let id = streamIds.get(key);
          if (!id) {
            id = `stream-${key || "agent"}-${Date.now()}`;
            streamIds.set(key, id);
            publish("stream.start", { id, speaker: key });
          }
          publish("stream.delta", { id, text: String(action.delta || ""), speaker: key });
          return;
        }
        if (action.type === "stream/end") {
          tools.flush();
          for (const [key, id] of [...streamIds.entries()]) {
            publish("stream.done", { id });
            streamIds.delete(key);
          }
          publish("status.set", { text: "ready", busy: false });
          return;
        }
        if (action.type === "log/clear") {
          publish("transcript.reset", {});
        }
      },
      toggleMultiWindow: () => {
        if (!multiSession) {
          appendLocal("error", "Multi-window session not initialised");
          return false;
        }
        // Exit /multi when already in multi. If currently in side (internal
        // activate split), fall through and open real /multi instead.
        if (multiSession.isActive() && !(multiSession.isSideKind && multiSession.isSideKind())) {
          multiSession.stop();
          try { reconcileMultiInternalWatches(); } catch { /* ignore */ }
          appendLocal("system", "Exited multi-window.");
          return true;
        }
        if (multiSession.isActive()) {
          multiSession.stop();
          try { reconcileMultiInternalWatches(); } catch { /* ignore */ }
        }
        const caps = hostRef && typeof hostRef.getClientCapabilities === "function"
          ? hostRef.getClientCapabilities()
          : [];
        if (!caps.includes(MULTI_FRAMES_CAPABILITY)) {
          appendLocal(
            "error",
            `Rust TUI lacks ${MULTI_FRAMES_CAPABILITY}; upgrade ufoo-tui`
          );
          return false;
        }
        const result = multiSession.start({ kind: "multi" });
        if (!result.ok) {
          appendLocal("error", result.error || "multi-window start failed");
          return false;
        }
        try { reconcileMultiInternalWatches(); } catch { /* ignore */ }
        appendLocal("system", "Entered multi-window (Ctrl+W focus · Ctrl+Q exit).");
        return true;
      },
      applyChatSettings: (patch = {}) => {
        if (patch.launchMode != null) settings.launchMode = patch.launchMode;
        if (patch.agentProvider != null) settings.agentProvider = patch.agentProvider;
        publish("settings.snapshot", buildSettingsSnapshot(settings));
      },
    },
  });

  function getActiveAgentIds() {
    const ids = [];
    try {
      for (const id of controller.session.metaMap.keys()) {
        const clean = String(id || "").trim();
        if (clean) ids.push(clean);
      }
    } catch {
      // ignore
    }
    return ids;
  }

  function getAgentLabel(agentId) {
    try {
      const meta = controller.session.metaMap.get(agentId) || {};
      return String(meta.display_nickname || meta.nickname || agentId);
    } catch {
      return agentId;
    }
  }

  function getAgentMetaForMulti(agentId) {
    try {
      return controller.session.metaMap.get(agentId) || {};
    } catch {
      return {};
    }
  }

  function resolveMultiPaneOptions(agentId) {
    const enter = resolveAgentEnterRequest({
      agentId,
      projectRoot: activeProjectRoot,
      activeAgentMeta: controller.session.metaMap,
      settings,
    });
    if (!enter || !enter.useBus) return { mode: "socket" };
    let initialLines = [];
    try {
      const { loadInternalAgentLogHistory } = require("../app/chat/internalAgentLogHistory");
      initialLines = loadInternalAgentLogHistory(activeProjectRoot, agentId, {
        maxEvents: 200,
        maxLines: 200,
      }) || [];
    } catch {
      initialLines = [];
    }
    return {
      mode: "internal",
      initialLines: [
        `ufoo internal agent · ${getAgentLabel(agentId)}`,
        `agent: ${agentId}`,
        "",
        ...initialLines,
      ],
    };
  }

  multiSession = createRustMultiSession({
    projectRoot,
    getActiveAgents: getActiveAgentIds,
    getAgentMeta: getAgentMetaForMulti,
    getInjectSockPath: (id) =>
      require("../app/chat/agentEnter").resolveInjectSockPathForAgent(activeProjectRoot, id),
    resolvePaneOptions: resolveMultiPaneOptions,
    onInternalSubmit: (agentId, message) => {
      try {
        daemonSend({
          type: IPC_REQUEST_TYPES.BUS_SEND,
          target: agentId,
          message: String(message || ""),
          injection_mode: "immediate",
          source: "rust-multi-window",
        });
      } catch {
        // ignore
      }
    },
    publish,
    publishLossy,
    getLabel: getAgentLabel,
  });

  function buildSnapshot() {
    const { loadChatHistory, loadInputHistory } = require("../app/chat/historyStore");
    const historyRoot = activeProjectRoot || projectRoot;
    const historyOpts = historyOptions();
    const history = loadChatHistory(historyRoot, 200, historyOpts);
    const inputHistory = loadInputHistory(historyRoot, 200, historyOpts);
    const agents = controller.getAgentsSnapshot();
    const settingsSnap = buildSettingsSnapshot(settings);
    const projects = env.globalMode ? loadGlobalProjectRows(activeProjectRoot) : [];
    return {
      status: "ready",
      package_version: PACKAGE_VERSION,
      footer: agents.footer || "",
      entries: historyToEntries(history),
      input_history: Array.isArray(inputHistory) ? inputHistory.filter(Boolean) : [],
      agents: agents.agents,
      settings: settingsSnap,
      launch_mode: settingsSnap.launch_mode,
      agent_provider: settingsSnap.agent_provider,
      mode_options: settingsSnap.mode_options,
      provider_options: settingsSnap.provider_options,
      global_mode: Boolean(env.globalMode),
      controller_root: projectRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      projects,
      cron: agents.cron && agents.cron.tasks ? agents.cron.tasks : [],
      loop: agents.loop || null,
      loop_summary: require("./dashboardBridge").formatLoopSummary(agents.loop || null),
      multi: multiSession ? multiSession.getSnapshot() : { active: false },
    };
  }

  const uiSocketPath = path.join(
    os.tmpdir(),
    `ufoo-ui-chat-${process.pid}-${Date.now()}.sock`
  );
  const uiAuthToken = createAuthToken();

  const host = createUiHostServer({
    socketPath: uiSocketPath,
    authToken: uiAuthToken,
    capabilities: ["chat", "scrollback", "prompt", MULTI_FRAMES_CAPABILITY],
    onClientReady(socket) {
      const snap = createEnvelope({
        kind: "snapshot",
        name: "app.snapshot",
        seq: host.nextSeq(),
        scope: { surface: "chat", project_id: projectRoot },
        payload: buildSnapshot(),
      });
      socket.write(encodeMessage(snap));
      if (env.globalMode) publishProjects();
    },
    async onCommand(cmd) {
      const name = String(cmd.name || "");
      const payload = cmd.payload && typeof cmd.payload === "object" ? cmd.payload : {};
      if (name === "app.exit") {
        return { ok: true };
      }
      if (name === "ui.resync.request") {
        publish("app.snapshot", buildSnapshot());
        return { ok: true };
      }
      if (name === "completion.request") {
        const fmt = require("./format");
        const { COMMAND_TREE, COMMAND_REGISTRY } = require("../app/chat/commands");
        const agents = controller.session.agents.slice();
        const agentLabels = agents.map((id) => {
          const meta = controller.session.metaMap.get(id) || {};
          return meta.display_nickname || meta.nickname || id;
        });
        const dynamic = loadDynamicCompletionSources(activeProjectRoot);
        const items = fmt.buildCompletions({
          text: String(payload.text || ""),
          agents,
          agentLabels,
          commands: COMMAND_REGISTRY,
          commandTree: COMMAND_TREE,
          groupTemplates: dynamic.groupTemplates,
          soloProfiles: dynamic.soloProfiles,
          limit: 20,
        });
        publish("completions.set", { items });
        return { ok: true, count: items.length };
      }
      if (name === "task.cancel") {
        publish("status.set", { text: "cancel requested", busy: false });
        publish("stream.done", { id: "cancel" });
        return { ok: true };
      }
      if (name === "agent.select") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (agentId) {
          controller.session.targetAgent = agentId;
          const label = payload.label || agentId;
          publish("status.set", {
            text: `target @${label}`,
          });
          publish("prompt.set_prefix", { prefix: `›@${label} ` });
        } else {
          controller.session.targetAgent = null;
          publish("prompt.set_prefix", { prefix: "› " });
        }
        return { ok: true, agent_id: agentId };
      }
      if (name === "agent.open" || name === "ui.suspend.request") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (name === "agent.open") {
          return hostApi.enterAgentView(agentId, payload) || { ok: true, agent_id: agentId };
        }
        // Suspend handoff removed (no PTY mirror). Ignore explicit suspend.
        appendLocal("system", "ui.suspend ignored (PTY handoff removed)");
        return { ok: true, suspend: false, agent_id: agentId };
      }
      if (name === "multi.exit") {
        if (multiSession && multiSession.isActive()) {
          multiSession.stop();
          try { reconcileMultiInternalWatches(); } catch { /* ignore */ }
        }
        return { ok: true };
      }
      if (name === "multi.focus") {
        return multiSession
          ? multiSession.handleFocus(payload)
          : { ok: false, error: "multi not active" };
      }
      if (name === "multi.viewport") {
        return multiSession
          ? multiSession.handleViewport(payload)
          : { ok: false, error: "multi not active" };
      }
      if (name === "multi.raw") {
        return multiSession
          ? multiSession.handleRaw(payload)
          : { ok: false, error: "multi not active" };
      }
      if (name === "agent.view.exit") {
        if (agentViewId) {
          try {
            daemonSend({
              type: IPC_REQUEST_TYPES.BUS_WATCH,
              agent_id: agentViewId,
              enabled: false,
            });
          } catch {
            // ignore
          }
        }
        for (const [key, id] of [...streamIds.entries()]) {
          if (String(id).startsWith("av-stream-") || key === agentViewId) {
            publish("stream.done", { id });
            streamIds.delete(key);
          }
        }
        agentViewId = "";
        publish("agent.view.close", {});
        publish("app.snapshot", buildSnapshot());
        return { ok: true };
      }
      if (name === "agent.view.submit") {
        const agentId = String(payload.agent_id || agentViewId || "").trim();
        const text = String(payload.text || "").trim();
        if (!agentId || !text) return { ok: false, error: "missing agent or text" };
        publish("agent.view.append", {
          id: `av-user-${Date.now()}`,
          kind: "user",
          text: `> ${text}`,
          speaker: "",
        });
        daemonSend({
          type: IPC_REQUEST_TYPES.BUS_SEND,
          target: agentId,
          message: text,
          injection_mode: "immediate",
          source: "chat-internal-agent-view",
        });
        publish("agent.view.status", { text: "working" });
        return { ok: true };
      }
      if (name === "agent.close") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (!agentId) return { ok: false, error: "missing agent_id" };
        daemonSend({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: agentId });
        publish("status.set", { text: `closing ${agentId}` });
        return { ok: true };
      }
      if (name === "cron.stop") {
        const id = String(payload.id || "").trim();
        if (!id) return { ok: false, error: "missing cron id" };
        daemonSend({ type: IPC_REQUEST_TYPES.CRON, operation: "stop", id });
        publish("status.set", { text: `stopping cron ${payload.label || id}` });
        controller.requestDaemonStatus();
        return { ok: true };
      }
      if (name === "project.switch") {
        const root = String(payload.root || "").trim();
        if (!root) return { ok: false, error: "missing project root" };
        return hostApi.switchToProjectRoot(root, { label: payload.label || root });
      }
      if (name === "project.return_controller") {
        return hostApi.switchToControllerRoot();
      }
      if (name === "project.close") {
        const root = String(payload.root || "").trim();
        if (!root) return { ok: false, error: "missing project root" };
        try {
          const { createProjectCloseController } = require("../app/chat/projectCloseController");
          const { requestDaemon, stopDaemon } = require("../app/chat/transport");
          const { isRunning } = require("../runtime/daemon");
          const projects = loadGlobalProjectRows(activeProjectRoot);
          const index = projects.findIndex((row) => String(row.root || "") === root);
          if (index < 0) {
            return { ok: false, error: "project not found" };
          }
          const closer = createProjectCloseController({
            getProjects: () => projects.map((row) => ({
              ...row,
              project_name: row.label || row.root,
              project_root: row.root,
            })),
            getActiveProjectRoot: () => activeProjectRoot,
            resolveProjectRoot: (row) => String((row && (row.root || row.project_root)) || ""),
            isRunning: (targetRoot) => {
              const endpoint = resolveDaemonEndpoint(targetRoot);
              return endpoint.scope === "global" ? true : isRunning(targetRoot);
            },
            stopDaemon,
            closeProject: async (targetRoot) => {
              const endpoint = resolveDaemonEndpoint(targetRoot);
              if (endpoint.scope === "global") {
                return requestDaemon(targetRoot, {
                  type: IPC_REQUEST_TYPES.CLOSE_PROJECT_RUNTIME,
                  terminate_agents: true,
                });
              }
              return stopDaemon(targetRoot, { source: `project-close:${targetRoot}` });
            },
            switchProject: async (fallbackRoot) => hostApi.switchToProjectRoot(fallbackRoot),
            refreshProjects: () => publishProjects(),
            logMessage: (kind, text) => {
              const normalized = kind === "error" ? "error" : "system";
              appendLocal(normalized, stripTags(text));
            },
            resolveStatusLine: (text) => publish("status.set", { text: stripTags(text) }),
            escapeBlessed: (value) => String(value || ""),
          });
          const result = await closer.requestCloseProject(index);
          if (result && result.ok) {
            publish("app.snapshot", buildSnapshot());
          }
          return result;
        } catch (err) {
          appendLocal("error", `Close failed: ${err && err.message ? err.message : err}`);
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      if (name === "settings.set") {
        try {
          const applied = applySettingsPatch(projectRoot, payload);
          if (!applied.ok) return applied;
          Object.assign(settings, {
            launchMode: applied.settings.launch_mode,
            agentProvider: applied.settings.agent_provider,
          });
          publish("settings.snapshot", applied.settings);
          if (payload.launch_mode || payload.launchMode) {
            appendLocal("system", `Launch mode: ${applied.settings.launch_mode}`);
          }
          if (payload.agent_provider || payload.agentProvider) {
            const label = applied.settings.provider_options.find(
              (opt) => opt.value === applied.settings.agent_provider
            );
            appendLocal(
              "system",
              `ufoo-agent: ${(label && label.label) || applied.settings.agent_provider}`
            );
            try {
              const { getUfooPaths } = require("../coordination/state/paths");
              const fs = require("fs");
              const pathMod = require("path");
              const agentDir = getUfooPaths(projectRoot).agentDir;
              fs.rmSync(pathMod.join(agentDir, "ufoo-agent.json"), { force: true });
              fs.rmSync(pathMod.join(agentDir, "ufoo-agent.history.jsonl"), { force: true });
            } catch {
              // ignore
            }
          }
          publish("status.set", { text: "settings saved · restarting daemon…" });
          try {
            if (daemonCoordinator && typeof daemonCoordinator.restart === "function") {
              await daemonCoordinator.restart();
            }
          } catch (err) {
            appendLocal("error", `Daemon restart failed: ${err && err.message ? err.message : err}`);
          }
          try {
            daemonSend({ type: IPC_REQUEST_TYPES.STATUS });
          } catch {
            // ignore
          }
          publish("status.set", { text: "settings saved" });
          return { ok: true, settings: applied.settings };
        } catch (err) {
          return { ok: false, error: err && err.message ? err.message : String(err) };
        }
      }
      if (name === "interaction.respond") {
        appendLocal("system", payload.cancelled
          ? "interaction cancelled"
          : `interaction answer: ${String(payload.text || "").slice(0, 200)}`);
        publish("interaction.clear", {});
        return { ok: true };
      }
      if (name === "input.submit") {
        const text = String(payload.text || "");
        const payloadTarget = String(payload.target_agent || payload.targetAgent || "").trim();
        if (payloadTarget && !controller.session.targetAgent) {
          controller.session.targetAgent = payloadTarget;
        }
        // Empty ›@ Enter for internal: open side split directly (do not
        // depend solely on tryActivate → focusMultiPane chain).
        if (!text.trim()) {
          const target = controller.session.targetAgent || payloadTarget;
          if (target && hostApi.isInternalAgent(target)
              && !(multiSession && multiSession.isMultiKind && multiSession.isMultiKind())) {
            const side = hostApi.startSide(target);
            if (!side || !side.ok) {
              appendLocal("error", `side failed: ${(side && side.error) || "unknown"}`);
              // Fall through to submitInput for bus AgentView fallback.
            } else {
              publish("status.set", { text: "ready", busy: false });
              return { ok: true, routed: "side", agent_id: target };
            }
          }
        }
        await controller.submitInput(text);
        publish("status.set", { text: "ready", busy: false });
        return { ok: true, routed: text.trim() ? "submit" : "empty" };
      }
      return { ok: false, error: `unsupported command ${name}` };
    },
  });
  hostRef = host;
  await host.listen();

  const router = createDaemonMessageRouter({
    escapeBlessed: (value) => String(value || ""),
    stripBlessedTags: stripTags,
    logMessage: (kind, text) => {
      const normalized = kind === "error" ? "error"
        : kind === "user" ? "user"
          : kind === "assistant" ? "assistant"
            : "system";
      if (agentViewId) {
        publish("agent.view.append", {
          id: `av-log-${Date.now()}`,
          kind: normalized,
          text: stripTags(text),
          speaker: "",
        });
        return;
      }
      appendLocal(normalized, text);
    },
    renderScreen: () => {},
    updateDashboard: (data) => {
      controller.applyStatus(data);
      publishDashboardFromStatus(data);
      if (env.globalMode) publishProjects();
    },
    requestStatus: () => controller.requestDaemonStatus(),
    getPending: () => controller.session.pending,
    setPending: (value) => {
      controller.session.pending = value || null;
    },
    resolveStatusLine: (text) => {
      if (agentViewId) {
        publish("agent.view.status", { text: stripTags(text || "ready") });
        return;
      }
      publish("status.set", { text: stripTags(text || "ready") });
    },
    enqueueBusStatus: (text) => {
      if (agentViewId) {
        publish("agent.view.status", { text: stripTags(text) });
        return;
      }
      publish("status.set", { text: stripTags(text) });
    },
    resolveBusStatus: () => {
      if (agentViewId) {
        publish("agent.view.status", { text: "ready" });
        return;
      }
      publish("status.set", { text: "ready" });
    },
    getCurrentView: () => (agentViewId ? "agent" : "main"),
    isAgentViewUsesBus: () => Boolean(agentViewId),
    getViewingAgent: () => agentViewId || "",
    isAgentEventForViewingAgent: (data, viewingAgent, publisher) => {
      if (!viewingAgent) return false;
      const candidates = [
        viewingAgent,
        publisher,
        data && data.publisher,
        data && data.target,
        data && data.subscriber,
      ].filter(Boolean).map(String);
      return candidates.some((id) => (
        id === viewingAgent
        || id.endsWith(`:${viewingAgent}`)
        || viewingAgent.endsWith(`:${id}`)
        || viewingAgent === id
      ));
    },
    writeToAgentTerm: (text, meta = {}) => {
      if (!agentViewId) return;
      const streamPayload = meta && meta.streamPayload && typeof meta.streamPayload === "object"
        ? meta.streamPayload
        : null;
      const publisher = String((meta && meta.publisher) || agentViewId);
      const raw = stripTags(text);
      if (streamPayload) {
        let id = streamIds.get(publisher);
        if (!id) {
          id = `av-stream-${publisher || "agent"}-${Date.now()}`;
          streamIds.set(publisher, id);
          publish("stream.start", { id, speaker: publisher });
        }
        if (raw) {
          publish("stream.delta", { id, text: raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), speaker: publisher });
        }
        if (streamPayload.done || meta.done) {
          publish("stream.done", { id });
          streamIds.delete(publisher);
          publish("agent.view.status", { text: "ready" });
        } else {
          publish("agent.view.status", { text: "working" });
        }
        return;
      }
      if (!raw) return;
      publish("agent.view.append", {
        id: `av-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: meta && meta.kind ? meta.kind : "assistant",
        text: raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
        speaker: publisher,
      });
    },
    beginStream: (...args) => controller.getStreamState().beginStream(...args),
    appendStreamDelta: (...args) => controller.getStreamState().appendStreamDelta(...args),
    finalizeStream: (...args) => controller.getStreamState().finalizeStream(...args),
    hasStream: (...args) => controller.getStreamState().hasStream(...args),
    getPendingState: (...args) => controller.getStreamState().getPendingState(...args),
    consumePendingDelivery: (...args) => controller.getStreamState().consumePendingDelivery(...args),
    setTransientAgentState: (agentId, value, options = {}) => {
      controller.patchAgentActivity(agentId, {
        activity_state: value,
        activity_detail: options.detail || "",
      });
      if (agentViewId && agentId === agentViewId) {
        publish("agent.view.status", { text: value || "ready" });
      }
    },
    clearTransientAgentState: (agentId) => {
      controller.patchAgentActivity(agentId, {
        activity_state: "",
        activity_detail: "",
      });
      if (agentViewId && agentId === agentViewId) {
        publish("agent.view.status", { text: "ready" });
      }
    },
  });

  const daemonConnection = createDaemonConnection({
    connectClient: daemonTransport.connectClient.bind(daemonTransport),
    transformRequest: (request) => routeDaemonRequest(initialDaemonEndpoint, request),
    handleMessage: (msg) => {
      if (typeof routedMessageHandler === "function" && routedMessageHandler(msg)) {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === IPC_RESPONSE_TYPES.BUS) {
        try { mirrorBusToMultiPanes(msg.data || {}); } catch { /* ignore */ }
      }
      if (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK) {
        if (agentViewId) {
          publish("agent.view.append", {
            id: `av-ok-${Date.now()}`,
            kind: "system",
            text: "✓ Message delivered",
            speaker: "",
          });
          publish("agent.view.status", { text: "ready" });
        } else {
          appendLocal("system", "✓ Message delivered");
          publish("status.set", { text: "ready" });
        }
        controller.requestDaemonStatus();
        return;
      }
      router.handleMessage(msg);
    },
    queueStatusLine: (text) => publish("status.set", { text: stripTags(text) }),
    resolveStatusLine: (text) => publish("status.set", { text: stripTags(text || "ready") }),
    logMessage: (kind, text) => {
      const normalized = kind === "error" ? "error" : "system";
      appendLocal(normalized, stripTags(text));
    },
  });

  const { createDaemonCoordinator } = require("../app/chat/daemonCoordinator");
  const { startDaemon, stopDaemon } = require("../app/chat/transport");
  const { isRunning } = require("../runtime/daemon");
  daemonCoordinator = createDaemonCoordinator({
    projectRoot,
    daemonTransport,
    daemonConnection,
    stopDaemon,
    startDaemon,
    isDaemonRunning: isRunning,
    queueStatusLine: (text) => publish("status.set", { text: stripTags(text) }),
    resolveStatusLine: (text) => publish("status.set", { text: stripTags(text || "ready") }),
    logMessage: (kind, text) => {
      const normalized = kind === "error" ? "error" : "system";
      appendLocal(normalized, stripTags(text));
    },
  });

  await daemonConnection.connect();
  daemonSend = (req) => daemonConnection.send(req);
  controller.setSend(daemonSend);

  controller.start({
    send: daemonSend,
    sendStatus: () => daemonSend({ type: IPC_REQUEST_TYPES.STATUS }),
    statusIntervalMs: 3000,
  });

  async function spawnTuiOnce() {
    const child = spawn(plan.binary, [
      "--surface", "chat",
      "--ui-socket", uiSocketPath,
    ], {
      stdio: "inherit",
      env: {
        ...process.env,
        UFOO_UI_PROTOCOL: plan.protocol,
        UFOO_UI_TOKEN: uiAuthToken,
      },
    });
    return new Promise((resolve) => {
      child.on("error", (err) => {
        // eslint-disable-next-line no-console
        console.error("ufoo-tui spawn failed");
        resolve(1);
      });
      child.on("close", (code, signal) => {
        resolve(signal ? 1 : (code == null ? 0 : code));
      });
    });
  }

  // PTY suspend handoff removed. If an old ufoo-tui still exits 75, respawn once.
  const EXIT_SUSPEND = 75;
  let exitCode = await spawnTuiOnce();
  if (exitCode === EXIT_SUSPEND) {
    appendLocal("system", "Suspend exit ignored (PTY handoff removed); resuming chat.");
    publish("ui.resume", { ok: true });
    exitCode = await spawnTuiOnce();
  }

  if (multiSession && multiSession.isActive()) {
    try { multiSession.stop(); } catch {}
  }
  controller.stop();
  daemonConnection.markExit();
  daemonConnection.close();
  await host.close();
  return exitCode;
}

module.exports = {
  runChatRust,
  historyToEntries,
  loadDynamicCompletionSources,
};
