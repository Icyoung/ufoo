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
const { createAgentSettingsController } = require("./agentSettingsController");
const fmt = require("./format");
const { buildUfooStartupEntries } = require("./format/startupBanner");
const {
  loadGlobalProjectRows,
  buildDashboardPublishPayload,
} = require("./dashboardBridge");
const { createChatController } = require("../app/chat/ChatController");
const { isInternalAgentMeta, isInternalDashboardEvent } = require("../runtime/contracts/agentMode");
const { loadConfig } = require("../config");
const { bootstrapEnvironment, ensureSubscriberId } = require("../app/chat/bootstrap");
const {
  createEnvelope,
  encodeMessage,
  MULTI_FRAMES_CAPABILITY,
  WINDOW_MODES_CAPABILITY,
} = require("../runtime/contracts/uiProtocol");
const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES } = require("../runtime/contracts/eventContract");
const { createDaemonMessageRouter } = require("../app/chat/daemonMessageRouter");
const {
  resolveDaemonEndpoint,
  routeDaemonRequest,
} = require("../runtime/daemon/endpoint");
const PACKAGE_VERSION = require("../../package.json").version;

async function loadResumeCompletionSources(root, request = require("../app/chat/transport").requestDaemon) {
  const result = await request(root, { type: IPC_REQUEST_TYPES.LIST_RECOVERABLE_AGENTS, internal_only: true }, {
    retries: 1, timeoutMs: 5000,
  });
  const recovery = result.recoverable || {};
  const agents = (recovery.recoverable || []).filter((item) => !item.group_id);
  agents.sort((a, b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")) || a.id.localeCompare(b.id));
  return [
    ...agents.map((item) => ({ id: item.id, label: item.display_nickname || item.nickname || item.id,
      desc: `${item.agent} · session ${item.sessionId}` })),
    ...(recovery.groups || []).map((group) => ({ id: `group:${group.group_id}`,
      desc: `Group · ${group.template_alias || group.group_id} · ${group.members.length} recoverable agents` })),
  ];
}

function parseWindowModeArgs(args = []) {
  const text = args.map((value) => String(value).trim()).join(" ").toLowerCase();
  return ["main", "side", "multi"].includes(text) ? text : "";
}

function resolveSubmittedInputTarget(payload, currentTarget, isInternalAgent) {
  const target = String(payload.target_agent || payload.targetAgent || "").trim();
  if ((payload.has_target && !target) || (target && !isInternalAgent(target))) {
    return { ok: false, error: "Unknown internal target" };
  }
  return { ok: true, target: target || (payload.input_target === "main" ? null : currentTarget) };
}

function stripTags(value) {
  return String(value || "").replace(/\{[^}]+\}/g, "");
}

function historyToEntries(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const MARKDOWN_KINDS = new Set(["assistant", "agent", "report", "error"]);
  const KINDS = new Set(["system", "user", "assistant", "error", "agent", "report",
    "thinking", "tool", "spacer", "meta", "bus", "success", "banner"]);
  const cleanText = (text) => String(text || "")
    // Strip presentation tags without eating code such as { value: 1 }.
    .replace(/\{\/?(?:[a-z]+(?:-[a-z]+)*-(?:fg|bg)|#[\da-f]{3,8}-(?:fg|bg)|bold|italic|underline|blink|inverse|invisible|normal|reset|escape)\}/gi, "")
    .replace(/\{open\}/g, "{").replace(/\{close\}/g, "}");
  return list.map((row, index) => {
    const source = row && typeof row === "object" ? row : { text: row };
    const meta = source.meta && typeof source.meta === "object" ? source.meta : {};
    const sourceType = String(source.sourceType || source.type || source.kind || "system");
    const streamed = sourceType === "bus" && meta.stream_done === true;
    const kind = streamed || sourceType === "reply" ? "assistant"
      : KINDS.has(sourceType) ? sourceType : "system";
    let text = cleanText(source.text || source.content || "");
    let speaker = String(source.speaker || meta.speaker || "");
    if (streamed) {
      // Stream persistence prefixes the display name, whereas the live TUI
      // receives it separately. Restore that same identity and raw body.
      const match = text.match(/^([^\n]+?): ([\s\S]*)$/);
      if (match) { speaker = speaker || match[1]; text = match[2]; }
    } else if (MARKDOWN_KINDS.has(kind)) {
      try {
        const lines = fmt.renderLogLinesWithMarkdownAnsi(text, { inCodeBlock: false });
        if (Array.isArray(lines) && lines.length > 0) text = lines.map((line) => String(line || "")).join("\n");
      } catch {
        // Keep the original complete block if markdown rendering fails.
      }
    }
    return {
      id: String(source.id || `hist-${index}`),
      kind,
      text,
      speaker,
      detail: cleanText(source.detail || source.expanded_text || meta.detail || meta.expanded_text || ""),
      expanded: false,
    };
  });
}

/** Completion sources: `/group run` / `/solo run` dynamic argument lists. */
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
      globalController: env.globalMode,
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
  const streamLabels = new Map();
  let mainSubmissionRev = 0;
  let hostRef = null;
  let daemonSend = () => {};
  let daemonCoordinator = null;
  let routedMessageHandler = () => {};
  let activeProjectRoot = projectRoot;
  let globalScope = "controller";
  let multiSession = null;
  const internalSubmissions = new Map();
  /** Internal pane agents currently BUS_WATCH'd for multi/side inbound. */
  const watchedInternalAgents = new Set();
  const welcomedProjects = new Set();
  const settings = (() => {
    try {
      return loadConfig(projectRoot) || {};
    } catch {
      return {};
    }
  })();

  async function applyAgentSettings(patch) {
    const model = patch.agent_model ?? patch.agentModel;
    if (model) {
      const current = loadConfig(activeProjectRoot);
      const provider = patch.agent_provider ?? patch.agentProvider ?? current.agentProvider;
      const confirmation = await require("../agents/providers/modelSettings").confirmAgentModel(activeProjectRoot, model,
        { config: { ...current, agentProvider: provider } });
      if (!confirmation.allowed) return { ok: false, error: confirmation.error };
    }
    const applied = applySettingsPatch(activeProjectRoot, patch);
    if (!applied.ok) return applied;
    Object.assign(settings, loadConfig(activeProjectRoot));
    publish("settings.snapshot", applied.settings);
    if (applied.providerChanged) appendLocal("system", `Provider: ${applied.settings.agent_provider} · new conversation`);
    if (patch.agent_model != null || patch.agentModel != null) appendLocal("system", `Model: ${applied.settings.agent_model}`);
    if (patch.agent_thinking != null || patch.agentThinking != null) appendLocal("system", `Thinking: ${applied.settings.agent_thinking}`);
    const restart = applied.providerChanged || patch.agent_base_url != null || patch.agent_api_key != null
      || patch.agentBaseUrl != null || patch.agentApiKey != null;
    if (restart && daemonCoordinator?.restart) {
      publish("status.set", { text: "settings saved · restarting daemon…" });
      await daemonCoordinator.restart();
    }
    publish("status.set", { text: "settings saved", busy: false });
    publish("prompt.restore", {});
    return applied;
  }
  const agentSettings = createAgentSettingsController({ getProjectRoot: () => activeProjectRoot,
    applyPatch: applyAgentSettings, publish: (...args) => publish(...args), logMessage: (...args) => appendLocal(...args),
    focusMain() {
      if (multiSession?.isActive()) {
        multiSession.handleFocus({ target: "chat" });
        publish("window.set", multiSession.getSnapshot());
      }
      controller.session.targetAgent = null;
      publish("prompt.set_prefix", { prefix: "› " });
    },
  });

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
    if (multiSession
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
    if (!multiSession) return false;
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
      acceptEvent: (agentId, event, seq) => multiSession.acceptEvent(agentId, event, seq),
      hasStructuredEvents: (agentId) => multiSession.hasStructuredEvents(agentId),
    });
  }

  function publishDashboardFromStatus(data = {}) {
    const payload = buildDashboardPublishPayload(controller, data);
    publish("agents.snapshot", {
      agents: payload.agents,
      footer: payload.footer,
    });
    if (multiSession) {
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

  function isInternalChild(agentId) {
    const id = String(agentId || "");
    return id !== "ufoo-agent" && !id.endsWith(":ufoo-agent") && hostApi.isInternalAgent(id);
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

      if (multiSession) multiSession.stop({ clearDrafts: true });

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
      if (multiSession) multiSession.stop({ clearDrafts: true });
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
    isInternalAgent(agentId) {
      return isInternalAgentMeta(controller.session.metaMap.get(String(agentId || "").trim()));
    },
    /** Activate an internal child in the one-child window mode. */
    startSide(agentId) {
      const id = String(agentId || "").trim();
      if (!hostApi.isInternalAgent(id)) return { ok: false, error: "Dashboard supports internal agents only" };
      if (!multiSession) return { ok: false, error: "split session not initialised" };
      // Prefer capability check, but do not hard-fail — connected Rust child
      // may be mid-handshake; window.set is still the right wire.
      const caps = hostRef && typeof hostRef.getClientCapabilities === "function"
        ? hostRef.getClientCapabilities()
        : [];
      if (caps.length > 0 && !caps.includes(WINDOW_MODES_CAPABILITY)) {
        return {
          ok: false,
          error: `Rust TUI lacks ${WINDOW_MODES_CAPABILITY}; rebuild ufoo-tui`,
        };
      }
      const result = multiSession.start({
        kind: "side",
        agentIds: [id],
        focus: { target: "agent", agent_id: id },
      });
      if (result && result.ok) {
        controller.session.targetAgent = null;
        publish("prompt.set_prefix", { prefix: "› " });
        try { reconcileMultiInternalWatches(); } catch { /* ignore */ }
        return result;
      }
      return result || { ok: false, error: "side start failed" };
    },
    activateInternalAgent(agentId) {
      const id = String(agentId || "").trim();
      if (!hostApi.isInternalAgent(id)) return { ok: false, error: "Dashboard supports internal agents only" };
      if (multiSession && multiSession.isMultiKind()) {
        multiSession.syncAgents();
        const result = multiSession.focusAgent(id);
        if (result && result.ok) return { ...result, mode: "multi_focus", agent_id: id };
      }
      const result = hostApi.startSide(id);
      return result && result.ok ? { ...result, mode: "side", agent_id: id } : result;
    },
  };

  function appendLocal(kind, text, speaker = "") {
    const raw = String(text == null ? "" : text);
    const last = { ...historyToEntries([{ kind, text: raw, speaker }])[0], id: `live-${++entrySeq}` };
    publish("transcript.append", last);
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

  function changeWindowLayout(mode) {
    if (!multiSession) return { ok: false, error: "Window session not initialised" };
    if (!["main", "side", "multi", "cycle"].includes(mode)) {
      const error = "Usage: /window main | /window side | /window multi";
      appendLocal("error", error);
      return { ok: false, error };
    }
    if (mode !== "main") {
      const caps = hostRef && typeof hostRef.getClientCapabilities === "function"
        ? hostRef.getClientCapabilities() : [];
      if (!caps.includes(WINDOW_MODES_CAPABILITY)) {
        const error = `Rust TUI lacks ${WINDOW_MODES_CAPABILITY}; upgrade ufoo-tui`;
        appendLocal("error", error);
        return { ok: false, error };
      }
    }
    const result = multiSession.setLayout(mode);
    if (!result.ok) {
      appendLocal("error", result.error || "Layout switch failed");
      return result;
    }
    reconcileMultiInternalWatches();
    controller.session.targetAgent = null;
    publish("prompt.set_prefix", { prefix: "› " });
    return result;
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
      activateInternalAgent: (...args) => hostApi.activateInternalAgent(...args),
      focusMultiPane: async (agentId) => {
        // Focus a visible internal pane.
        if (multiSession && multiSession.isMultiKind && multiSession.isMultiKind()) {
          try { multiSession.syncAgents(); } catch { /* ignore */ }
          const focused = multiSession.focusAgent(agentId);
          if (focused && focused.ok) {
            return true;
          }
          return false;
        }
        // Activate the child in a one-child layout.
        if (hostApi.isInternalAgent(agentId)) {
          const side = hostApi.startSide(agentId);
          return Boolean(side && side.ok);
        }
        return false;
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
        // Child streams are presented in their own pane, including their busy
        // state. They must not start or complete the main agent's status.
        if (action.publisher && isInternalChild(action.publisher)) return;
        if (action.type === "stream/begin") {
          tools.beginScope();
          const speaker = String(action.publisher || "");
          const id = `stream-${speaker || "agent"}-${Date.now()}`;
          streamIds.set(speaker, id);
          streamLabels.set(speaker, action.displayName || speaker);
          publish("stream.start", { id, speaker: action.displayName || speaker });
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
          publish("stream.delta", { id, text: String(action.delta || ""), speaker: streamLabels.get(key) || key });
          return;
        }
        if (action.type === "stream/end") {
          tools.flush();
          for (const [key, id] of [...streamIds.entries()]) {
            if (action.publisher && key !== action.publisher) continue;
            publish("stream.done", { id });
            streamIds.delete(key);
            streamLabels.delete(key);
          }
          publish("status.set", { text: "ready", busy: false });
          return;
        }
        if (action.type === "log/clear") {
          publish("transcript.reset", {});
        }
      },
      setWindowLayout: (args) => changeWindowLayout(parseWindowModeArgs(args)).ok,
      openAgentSettings: (section) => agentSettings.open(section),
      applyAgentModel: (...args) => agentSettings.applyModel(...args),
      applyAgentSettings,
      openResumeMenu: () => {
        if (multiSession?.isActive()) {
          multiSession.handleFocus({ target: "chat" });
          publish("window.set", multiSession.getSnapshot());
        }
        publish("prompt.set_text", { text: "/resume ", if_empty: true });
      },
      applyChatSettings: (patch = {}) => {
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
    let initialEntries = [];
    try {
      const { loadInternalAgentTranscript } = require("../app/chat/internalAgentLogHistory");
      initialEntries = loadInternalAgentTranscript(activeProjectRoot, agentId, {
        maxEvents: 200,
        maxEntries: 200,
      }) || [];
    } catch {
      initialEntries = [];
    }
    return {
      mode: "internal",
      initialEntries,
    };
  }

  multiSession = createRustMultiSession({
    getProjectRoot: () => activeProjectRoot,
    projectRoot,
    getActiveAgents: getActiveAgentIds,
    getAgentMeta: getAgentMetaForMulti,
    resolvePaneOptions: resolveMultiPaneOptions,
    onInternalSubmit: (agentId, message) => {
      // Layout commands belong to the workspace even when a child has focus.
      if (/^\/window(?:\s|$)/.test(String(message || "").trim())) {
        changeWindowLayout(parseWindowModeArgs(String(message).trim().split(/\s+/).slice(1)));
        return;
      }
      const requestId = `pane-send-${require("crypto").randomUUID()}`;
      internalSubmissions.set(requestId, { agentId, message, projectRoot: activeProjectRoot });
      try {
        return daemonSend({
          type: IPC_REQUEST_TYPES.BUS_SEND,
          request_id: requestId,
          target: agentId,
          message: String(message || ""),
          injection_mode: "immediate",
          source: "rust-multi-window",
        });
      } catch (error) {
        internalSubmissions.delete(requestId);
        throw error;
      }
    },
    publish,
    publishLossy,
    getLabel: getAgentLabel,
  });

  function buildSnapshot({ startup = true } = {}) {
    const { loadChatHistory, loadInputHistory } = require("../app/chat/historyStore");
    const historyRoot = activeProjectRoot || projectRoot;
    const historyOpts = historyOptions();
    const history = loadChatHistory(historyRoot, 200, historyOpts);
    const inputHistory = loadInputHistory(historyRoot, 200, historyOpts);
    const showWelcome = startup && history.length === 0 && inputHistory.length === 0
      && !welcomedProjects.has(historyRoot);
    if (showWelcome) welcomedProjects.add(historyRoot);
    const agents = controller.getAgentsSnapshot();
    const settingsSnap = buildSettingsSnapshot(settings);
    const projects = env.globalMode ? loadGlobalProjectRows(activeProjectRoot) : [];
    return {
      status: "ready",
      package_version: PACKAGE_VERSION,
      footer: agents.footer || "",
      entries: [
        ...historyToEntries(history),
        ...(showWelcome ? buildUfooStartupEntries({
          version: PACKAGE_VERSION,
          workspaceRoot: historyRoot,
          globalMode: Boolean(env.globalMode),
          width: Math.max(1, (process.stdout.columns || 80) - 6),
        }) : []),
      ],
      input_history: Array.isArray(inputHistory) ? inputHistory.filter(Boolean) : [],
      agents: agents.agents,
      settings: settingsSnap,
      agent_provider: settingsSnap.agent_provider,
      provider_options: settingsSnap.provider_options,
      global_mode: Boolean(env.globalMode),
      controller_root: projectRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      projects,
      cron: agents.cron && agents.cron.tasks ? agents.cron.tasks : [],
      loop: agents.loop || null,
      loop_summary: require("./dashboardBridge").formatLoopSummary(agents.loop || null),
      window: multiSession ? multiSession.getSnapshot() : { active: false, mode: "main" },
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
    capabilities: ["chat", "scrollback", "prompt", MULTI_FRAMES_CAPABILITY, WINDOW_MODES_CAPABILITY],
    onClientReady(socket) {
      const snap = createEnvelope({
        kind: "snapshot",
        name: "app.snapshot",
        seq: host.nextSeq(),
        scope: { surface: "chat", project_id: projectRoot },
        payload: buildSnapshot({ startup: true }),
      });
      socket.write(encodeMessage(snap));
      multiSession?.publishFrames();
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
        multiSession?.publishFrames();
        return { ok: true };
      }
      if (name === "completion.request") {
        const fmt = require("./format");
        const { getChatCommandCatalog } = require("../app/chat/commands");
        const agents = controller.session.agents.slice();
        const agentLabels = agents.map((id) => {
          const meta = controller.session.metaMap.get(id) || {};
          return meta.display_nickname || meta.nickname || id;
        });
        const dynamic = loadDynamicCompletionSources(activeProjectRoot);
        const completionRoot = activeProjectRoot;
        const resumeQuery = /^\/resume(?:\s|$)/.test(String(payload.text || "").trimStart());
        let resumeTargets = [];
        if (resumeQuery) {
          try { resumeTargets = await loadResumeCompletionSources(completionRoot); }
          catch (error) {
            appendLocal("error", `Could not load recoverable sessions: ${error.message}`);
          }
          if (completionRoot !== activeProjectRoot) return { ok: true, stale: true };
        }
        const settingsLists = /^\/settings\s+agent\s+(?:model|thinking)(?:\s|$)/.test(String(payload.text || "").trimStart())
          ? await agentSettings.completions(String(payload.text || "")) : {};
        if (completionRoot !== activeProjectRoot) return { ok: true, stale: true };
        const items = fmt.buildCompletions({
          text: String(payload.text || ""),
          agents,
          agentLabels,
          ...getChatCommandCatalog({ globalMode: env.globalMode }),
          groupTemplates: dynamic.groupTemplates,
          soloProfiles: dynamic.soloProfiles,
          argumentLists: { ...settingsLists, ...(resumeQuery ? { "/resume": resumeTargets } : {}) },
          limit: Math.max(20, resumeTargets.length, ...Object.values(settingsLists).map((list) => list.length)),
        });
        publish("completions.set", { items, text: String(payload.text || "") });
        if (resumeQuery && resumeTargets.length === 0 && String(payload.text || "").trim() === "/resume") {
          appendLocal("system", "No recoverable internal agent sessions or groups.");
        }
        return { ok: true, count: items.length };
      }
      if (name === "task.cancel") {
        publish("status.set", { text: "cancel requested", busy: false });
        publish("stream.done", { id: "cancel" });
        return { ok: true };
      }
      if (name === "agent.select") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (agentId && !hostApi.isInternalAgent(agentId)) return { ok: false, error: "Unknown internal agent" };
        if (agentId) {
          controller.session.targetAgent = agentId;
          const label = payload.label || agentId;
          publish("prompt.set_prefix", { prefix: `›@${label} ` });
        } else {
          controller.session.targetAgent = null;
          publish("prompt.set_prefix", { prefix: "› " });
        }
        return { ok: true, agent_id: agentId };
      }
      if (name === "agent.open") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        return hostApi.activateInternalAgent(agentId) || { ok: true, agent_id: agentId };
      }
      if (name === "window.set" || name === "window.cycle") {
        if (name === "window.set" && payload.session_id && (!multiSession || payload.session_id !== multiSession.getSessionId())) {
          return { ok: false, error: "stale session_id" };
        }
        return changeWindowLayout(name === "window.cycle" ? "cycle" : payload.mode);
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
      if (name === "multi.scroll") {
        return multiSession
          ? multiSession.handleScroll(payload)
          : { ok: false, error: "multi not active" };
      }
      if (name === "multi.expand") return multiSession?.handleExpand(payload) || { ok: false };
      if (name === "agent.close") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (!hostApi.isInternalAgent(agentId)) return { ok: false, error: "Unknown internal agent" };
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
      if (name === "settings.open") return agentSettings.open(payload.section || "model");
      if (name === "settings.set") {
        try { return await applyAgentSettings(payload); }
        catch (error) {
          appendLocal("error", `Settings failed: ${error.message}`);
          return { ok: false, error: error.message };
        }
      }
      if (name === "interaction.respond") {
        const settingsReply = await agentSettings.respond(payload);
        if (settingsReply) return settingsReply;
        appendLocal("system", payload.cancelled
          ? "interaction cancelled"
          : `interaction answer: ${String(payload.text || "").slice(0, 200)}`);
        publish("interaction.clear", {});
        return { ok: true };
      }
      if (name === "input.submit") {
        const text = String(payload.text || "");
        // The submitted identity wins over mutable footer/focus state. Never
        // send an unresolved explicit child target to the main agent.
        const routing = resolveSubmittedInputTarget(payload, controller.session.targetAgent, hostApi.isInternalAgent);
        if (!routing.ok) return routing;
        controller.session.targetAgent = routing.target;
        const childOrLayout = Boolean(routing.target)
          || text.trimStart().startsWith("@") || /^\/window(?:\s|$)/.test(text.trim());
        // Empty ›@ Enter for internal: open side split directly (do not
        // depend solely on tryActivate → focusMultiPane chain).
        if (!text.trim()) {
          const target = routing.target;
          if (target && hostApi.isInternalAgent(target)
              && !(multiSession && multiSession.isMultiKind && multiSession.isMultiKind())) {
            const side = hostApi.startSide(target);
            if (!side || !side.ok) {
              appendLocal("error", `side failed: ${(side && side.error) || "unknown"}`);
              // Preserve the target and let the input handler report the failed focus.
            } else {
              return { ok: true, routed: "side", agent_id: target };
            }
          }
        }
        const beforeSubmit = mainSubmissionRev;
        await controller.submitInput(text);
        if (!childOrLayout && beforeSubmit === mainSubmissionRev) publish("status.set", { text: "ready", busy: false });
        return { ok: true, routed: text.trim() ? "submit" : "empty" };
      }
      return { ok: false, error: `unsupported command ${name}` };
    },
  });
  hostRef = host;
  await host.listen();

  const router = createDaemonMessageRouter({
    escapeBlessed: (value) => String(value || ""),
    resolveAgentDisplayName: getAgentLabel,
    stripBlessedTags: stripTags,
    logMessage: (kind, text) => {
      const normalized = kind === "error" ? "error"
        : kind === "user" ? "user"
          : kind === "assistant" ? "assistant"
            : "system";
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
    resolveStatusLine: (text, data) => {
      if (data?.key && isInternalChild(data.key)) return;
      publish("status.set", { text: stripTags(text || "ready"), busy: false });
    },
    enqueueBusStatus: (item) => {
      if (item?.key && isInternalChild(item.key)) return;
      publish("status.set", { text: stripTags(typeof item === "object" ? item.text : item), busy: true });
    },
    resolveBusStatus: (item) => {
      if (item?.key && isInternalChild(item.key)) return;
      publish("status.set", { text: "ready", busy: false });
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
    },
    clearTransientAgentState: (agentId) => {
      controller.patchAgentActivity(agentId, {
        activity_state: "",
        activity_detail: "",
      });
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
      if ([IPC_RESPONSE_TYPES.BUS_SEND_OK, IPC_RESPONSE_TYPES.ERROR].includes(msg.type)) {
        // Older daemons return uncorrelated bus_send_ok; retain compatibility.
        const id = msg.request_id || (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK
          ? internalSubmissions.keys().next().value : "");
        const submission = internalSubmissions.get(id);
        if (submission) {
          internalSubmissions.delete(id);
          if (submission.projectRoot === activeProjectRoot && msg.type === IPC_RESPONSE_TYPES.ERROR) {
            multiSession.acceptEvent(submission.agentId, { type: "submission_failed", message: submission.message,
              error: `Message delivery failed: ${msg.error || "unknown error"}` });
          }
          controller.requestDaemonStatus();
          return;
        }
      }
      if (msg.type === IPC_RESPONSE_TYPES.STATUS) {
        const root = msg.data && (msg.data.projectRoot || msg.data.project_root);
        if (root) {
          const { canonicalProjectRoot } = require("../runtime/projects");
          if (canonicalProjectRoot(root) !== canonicalProjectRoot(activeProjectRoot)) return;
        }
        const key = msg.data && msg.data.key;
        if (key && String(key).includes(":") && !hostApi.isInternalAgent(key)) return;
      }
      if (msg.type === IPC_RESPONSE_TYPES.BUS) {
        if (!isInternalDashboardEvent(msg.data || {}, (id) => controller.session.metaMap.get(id))) return;
        try { mirrorBusToMultiPanes(msg.data || {}); } catch { /* ignore */ }
        if (msg.data?.event === "agent_surface") return;
      }
      if (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK) {
        appendLocal("system", "✓ Message delivered");
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
  daemonSend = (req) => {
    if (req.type === IPC_REQUEST_TYPES.PROMPT) mainSubmissionRev += 1;
    return daemonConnection.send(req);
  };
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

  const exitCode = await spawnTuiOnce();

  if (multiSession && multiSession.isActive()) {
    try { multiSession.stop(); } catch {}
  }
  controller.stop();
  internalSubmissions.clear();
  daemonConnection.markExit();
  daemonConnection.close();
  await host.close();
  return exitCode;
}

module.exports = {
  runChatRust,
  historyToEntries,
  loadDynamicCompletionSources,
  loadResumeCompletionSources,
  parseWindowModeArgs,
  resolveSubmittedInputTarget,
};
