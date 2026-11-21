"use strict";

/**
 * Shared Node UI Host for Ufoo macOS Desktop App (`ufoo-ui/1` + `desktop-host-v1`).
 *
 * Connects to the single user-scoped `GlobalDaemon` (`~/.ufoo/run/ufoo.sock`),
 * reuses `ChatController`, `rustMultiSession`, `agentSurface`, and `settingsBridge`,
 * emits raw Markdown + structured metadata (`markdown-raw-v1`), aggregates the
 * multi-project + 2nd-level Worker Agent tree, and serves Right Inspector queries.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createUiHostServer, createAuthToken } = require("./uiHostServer");
const { createDesktopArchive } = require("./desktopArchive");
const { createToolMergePublisher } = require("./toolMergeBridge");
const { createRustMultiSession } = require("./rustMultiSession");
const { createAgentSurface } = require("./agentSurface");
const { writeMultiPaneBusEvent } = require("./multiPaneBusMirror");
const { buildSettingsSnapshot, applySettingsPatch } = require("./settingsBridge");
const { createAgentSettingsController } = require("./agentSettingsController");
const { listAgentModels, confirmAgentModel } = require("../agents/providers/modelSettings");
const { loadGlobalProjectRows, buildDashboardPublishPayload, formatLoopSummary } = require("./dashboardBridge");
const {
  loadWorkspaceChanges,
  loadWorkspaceDocs,
  handleWorkspaceContext,
  detectGitBranch,
} = require("./workspaceInspector");
const {
  createDesktopHandoffServer,
  parseHandoffUrl,
  launchCliHandoff,
  focusExternalAgentHost,
  installCliShims,
} = require("./cliHandoff");
const { createChatController } = require("../app/chat/ChatController");
const { createDaemonMessageRouter } = require("../app/chat/daemonMessageRouter");
const { bootstrapEnvironment, ensureSubscriberId } = require("../app/chat/bootstrap");
const { loadInternalAgentTranscript } = require("../app/chat/internalAgentLogHistory");
const { readAgentSurfaceEvents, createAgentSurfaceReader } = require("../coordination/history/agentSurface");
const { listReports } = require("../coordination/report/store");
const { getUfooPaths } = require("../coordination/state/paths");
const { loadAgentsData } = require("../coordination/state/agentsStore");
const { isAgentPidAlive } = require("../coordination/bus/utils");
const { isInternalAgentMeta, isInternalDashboardEvent } = require("../runtime/contracts/agentMode");
const {
  createEnvelope,
  encodeMessage,
  MULTI_FRAMES_CAPABILITY,
  WINDOW_MODES_CAPABILITY,
  RAW_MARKDOWN_CAPABILITY,
  DESKTOP_HOST_CAPABILITY,
} = require("../runtime/contracts/uiProtocol");
const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES } = require("../runtime/contracts/eventContract");
const { resolveDaemonEndpoint, routeDaemonRequest } = require("../runtime/daemon/endpoint");
const {
  canonicalProjectRoot,
  buildProjectId,
  upsertProjectRuntime,
  resolveGlobalControllerProjectRoot,
} = require("../runtime/projects");
const { loadConfig, normalizeAgentProvider, defaultAgentModelForProvider } = require("../config");
const {
  loadDynamicCompletionSources,
  loadResumeCompletionSources,
  parseWindowModeArgs,
  resolveSubmittedInputTarget,
} = require("./rustChatHost");

const PACKAGE_VERSION = require("../../package.json").version;

function stripTags(value) {
  return String(value || "")
    .replace(/\{\/?(?:[a-z]+(?:-[a-z]+)*-(?:fg|bg)|#[\da-f]{3,8}-(?:fg|bg)|bold|italic|underline|blink|inverse|invisible|normal|reset|escape)\}/gi, "")
    .replace(/\{open\}/g, "{")
    .replace(/\{close\}/g, "}");
}

function rawHistoryToEntries(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const KINDS = new Set([
    "system", "user", "assistant", "error", "agent", "report",
    "thinking", "tool", "spacer", "meta", "bus", "success", "banner",
  ]);
  return list.map((row, index) => {
    const source = row && typeof row === "object" ? row : { text: row };
    const meta = source.meta && typeof source.meta === "object" ? source.meta : {};
    const sourceType = String(source.sourceType || source.type || source.kind || "system");
    const streamed = sourceType === "bus" && meta.stream_done === true;
    const kind = streamed || sourceType === "reply"
      ? "assistant"
      : KINDS.has(sourceType) ? sourceType : "system";
    let text = stripTags(source.text || source.content || "");
    let speaker = String(source.speaker || meta.speaker || "");
    if (streamed) {
      const match = text.match(/^([^\n]+?): ([\s\S]*)$/);
      if (match) {
        speaker = speaker || match[1];
        text = match[2];
      }
    } else if (kind === "assistant" && /^ufoo\s*·\s*/.test(text)) {
      speaker = speaker || "ufoo";
      text = text.replace(/^ufoo\s*·\s*/, "");
    }
    return {
      id: String(source.id || `hist-${index}`),
      kind,
      text,
      speaker,
      detail: stripTags(source.detail || source.expanded_text || meta.detail || meta.expanded_text || ""),
      expanded: false,
      ts: source.ts || "",
    };
  });
}

function inspectDormantProjectSummary(projectRoot) {
  const out = {
    mainBusy: false,
    waitingUser: false,
    conversationId: "main-default",
    workers: [],
  };
  try {
    const cfg = loadConfig(projectRoot) || {};
    const convId = cfg.agentConversationId || "main-default";
    out.conversationId = convId;
    const snapFile = path.join(projectRoot, ".ufoo", "agent", "main", "runtimes", convId, "snapshot.json");
    if (fs.existsSync(snapFile)) {
      const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
      const tasks = Object.values((snap && snap.tasks) || {});
      out.mainBusy = tasks.some((t) => t && ["queued", "running"].includes(t.status));
      out.waitingUser = tasks.some((t) => t && t.status === "waiting_user");
    }
  } catch {
    // ignore snapshot read errors
  }

  try {
    const paths = getUfooPaths(projectRoot);
    if (fs.existsSync(paths.agentsFile)) {
      const data = loadAgentsData(paths.agentsFile) || {};
      for (const [id, meta] of Object.entries(data.agents || {})) {
        if (!meta || meta.status !== "active") continue;
        if (id === "ufoo-agent" || meta.agent_type === "ufoo-agent") continue;
        const pid = Number.parseInt(meta.pid, 10);
        const alive = meta.mcp_bridge === true || !pid || isAgentPidAlive(pid);
        if (!alive) continue;
        const internal = isInternalAgentMeta(meta);
        out.workers.push({
          id,
          label: String(meta.display_nickname || meta.nickname || id),
          type: String(meta.agent_type || meta.type || id.split(":")[0] || "worker"),
          internal,
          external: !internal,
          activity_state: String(meta.activity_state || "idle"),
          activity_detail: String(meta.activity_detail || ""),
          group_id: String(meta.group_id || ""),
          group_member_id: String(meta.group_member_id || ""),
          group_template_alias: String(meta.group_template_alias || ""),
          host_name: String(meta.host_name || ""),
          launch_mode: String(meta.launch_mode || ""),
        });
      }
    }
  } catch {
    // ignore agent registry read errors
  }
  return out;
}

async function startDesktopUiHost(options = {}) {
  const controllerRoot = canonicalProjectRoot(
    options.controllerRoot || resolveGlobalControllerProjectRoot()
  );
  const initialProjectRoot = options.initialProjectRoot
    ? canonicalProjectRoot(options.initialProjectRoot)
    : controllerRoot;
  const desktopArchive = createDesktopArchive(controllerRoot);

  const shortTmp = process.platform === "darwin" && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  const uiSocketPath = options.socketPath || path.join(
    shortTmp,
    `ufoo-ui-d-${process.pid}-${Date.now().toString(36)}.sock`
  );
  const uiAuthToken = options.authToken || createAuthToken();

  const env = bootstrapEnvironment(controllerRoot, {
    ...options,
    globalMode: true,
  });
  if (env.needsBootstrap || !fs.existsSync(env.runtimePaths.ufooDir)) {
    const repoRoot = path.join(__dirname, "..", "..");
    const init = new env.UfooInit(repoRoot);
    await init.init({
      targets: "context,bus",
      project: controllerRoot,
      globalController: true,
    });
  }
  await ensureSubscriberId(controllerRoot);

  const isDaemonRunning = typeof options.isRunning === "function" ? options.isRunning : env.isRunning;
  const startDaemonFn = typeof options.startDaemon === "function" ? options.startDaemon : env.startDaemon;

  const initialEndpoint = resolveDaemonEndpoint(controllerRoot, { controllerRoot });
  const daemonRoot = initialEndpoint.scope === "global"
    ? initialEndpoint.controllerRoot
    : initialEndpoint.projectRoot;
  if (!isDaemonRunning(daemonRoot)) {
    startDaemonFn(controllerRoot);
  }

  const { connectWithRetry, requestDaemon, startDaemon, stopDaemon } = require("../app/chat/transport");
  const { createDaemonTransport } = require("../app/chat/daemonTransport");
  const { createDaemonConnection } = require("../app/chat/daemonConnection");
  const { createDaemonCoordinator } = require("../app/chat/daemonCoordinator");
  const { isRunning } = require("../runtime/daemon");

  const daemonTransport = createDaemonTransport({
    projectRoot: controllerRoot,
    sockPath: initialEndpoint.socketPath,
    daemonRoot,
    isRunning: isDaemonRunning,
    startDaemon: startDaemonFn,
    connectWithRetry,
  });

  let entrySeq = 0;
  let mainSubmissionRev = 0;
  let hostRef = null;
  let daemonSend = () => {};
  let daemonCoordinator = null;
  let activeProjectRoot = controllerRoot;
  let globalScope = "controller";
  let multiSession = null;
  let stageTarget = { kind: "project_main", agentId: "" };
  let activePendingInteraction = null;
  const streamIds = new Map();
  const streamLabels = new Map();
  const ownRequestIds = new Set();
  const internalSubmissions = new Map();
  const watchedInternalAgents = new Set();
  const standaloneSurfaces = new Map();
  const standaloneDrafts = new Map();
  let standaloneReader = null;
  let standaloneReaderRoot = "";
  let standalonePollTimer = null;
  let treePollTimer = null;
  const recoverableCache = new Map();

  const settings = (() => {
    try {
      return loadConfig(activeProjectRoot) || {};
    } catch {
      return {};
    }
  })();

  function publish(name, payload) {
    if (!hostRef) return;
    hostRef.broadcast(hostRef.createEvent(name, payload, {
      surface: "desktop",
      project_id: activeProjectRoot,
      view_id: stageTarget.kind === "worker_single" ? stageTarget.agentId : "main",
    }));
  }

  function publishLossy(name, payload) {
    if (!hostRef) return;
    hostRef.broadcast(hostRef.createLossyEvent(name, payload, {
      surface: "desktop",
      project_id: activeProjectRoot,
      view_id: stageTarget.kind === "worker_single" ? stageTarget.agentId : "main",
    }));
  }

  function historyOptions() {
    const { chatHistoryOptionsForScope } = require("../app/chat/historyStore");
    return chatHistoryOptionsForScope({
      globalMode: true,
      globalScope,
    });
  }

  function appendLocal(kind, text, speaker = "") {
    const raw = String(text == null ? "" : text);
    const entry = {
      ...rawHistoryToEntries([{ kind, text: raw, speaker, ts: new Date().toISOString() }])[0],
      id: `live-${++entrySeq}`,
    };
    publish("transcript.append", entry);
    try {
      const { appendChatHistory } = require("../app/chat/historyStore");
      appendChatHistory(activeProjectRoot, kind, raw, { speaker }, historyOptions());
    } catch {
      // best-effort persistence
    }
    return entry;
  }

  function isInternalChild(agentId) {
    const id = String(agentId || "");
    return id !== "ufoo-agent" && !id.endsWith(":ufoo-agent") && isInternalAgentMeta(controller.session.metaMap.get(id));
  }

  function getAgentLabel(agentId) {
    const meta = controller.session.metaMap.get(agentId) || {};
    return String(meta.display_nickname || meta.nickname || agentId);
  }

  function getHandoffAgentMeta(agentId) {
    const { agentsFile } = getUfooPaths(activeProjectRoot);
    const agents = loadAgentsData(agentsFile)?.agents;
    return agents?.[agentId] || controller.session.metaMap.get(agentId);
  }

  async function refreshRecoverableForActiveProject() {
    if (globalScope === "controller") return [];
    try {
      const items = await loadResumeCompletionSources(
        activeProjectRoot,
        (root, payload, opts = {}) => requestDaemon(root, payload, { ...opts, controllerRoot })
      );
      recoverableCache.set(activeProjectRoot, items);
      return items;
    } catch {
      return recoverableCache.get(activeProjectRoot) || [];
    }
  }

  function buildActiveProjectWorkerRows() {
    const list = [];
    for (const id of controller.session.agents) {
      if (id === "ufoo-agent" || id.endsWith(":ufoo-agent")) continue;
      const meta = controller.session.metaMap.get(id) || {};
      const internal = isInternalAgentMeta(meta);
      list.push({
        id,
        label: getAgentLabel(id),
        type: String(meta.agent_type || meta.type || id.split(":")[0] || "worker"),
        internal,
        external: !internal,
        activity_state: String(meta.activity_state || "idle"),
        activity_detail: String(meta.activity_detail || ""),
        group_id: String(meta.group_id || ""),
        group_member_id: String(meta.group_member_id || ""),
        group_template_alias: String(meta.group_template_alias || ""),
        host_name: String(meta.host_name || ""),
        launch_mode: String(meta.launch_mode || ""),
      });
    }
    return list;
  }

  function listUnarchivedProjects(archive = desktopArchive.read()) {
    const archivedRoots = new Set(archive.projects.map(({ root }) => root));
    return loadGlobalProjectRows(activeProjectRoot).filter(({ root }) => !archivedRoots.has(root));
  }

  function buildProjectsTreePayload() {
    const archive = desktopArchive.read();
    const rawProjects = listUnarchivedProjects(archive);
    const seen = new Set(rawProjects.map((r) => r.root));
    if (activeProjectRoot && activeProjectRoot !== controllerRoot
      && !archive.projects.some(({ root }) => root === activeProjectRoot) && !seen.has(activeProjectRoot)) {
      rawProjects.unshift({
        id: buildProjectId(activeProjectRoot),
        label: path.basename(activeProjectRoot) || activeProjectRoot,
        root: activeProjectRoot,
        status: "running",
        active: true,
      });
    }

    const projects = rawProjects.map((row) => {
      const isCurrent = row.root === activeProjectRoot && globalScope === "project";
      const dormant = inspectDormantProjectSummary(row.root);
      const workers = isCurrent ? buildActiveProjectWorkerRows() : dormant.workers;
      const archivedIds = new Set(archive.sessions.filter(({ root }) => root === row.root).map(({ id }) => id));
      return {
        id: row.id || buildProjectId(row.root),
        label: row.label || path.basename(row.root),
        root: row.root,
        branch: detectGitBranch(row.root),
        status: row.status || "running",
        active: isCurrent,
        selectedAsMain: isCurrent && stageTarget.kind === "project_main",
        selectedWorkerId: isCurrent && stageTarget.kind === "worker_single" ? stageTarget.agentId : "",
        mainBusy: isCurrent ? Boolean(controller.session.pending) || dormant.mainBusy : dormant.mainBusy,
        waitingUser: isCurrent ? Boolean(activePendingInteraction) || dormant.waitingUser : dormant.waitingUser,
        conversationId: dormant.conversationId,
        workers: workers.filter(({ id }) => !archivedIds.has(id)),
        recoverable: (recoverableCache.get(row.root) || []).filter(({ id }) => !archivedIds.has(id)),
      };
    });

    return {
      controller_root: controllerRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      stage_target: { ...stageTarget },
      projects,
    };
  }

  function publishProjectsTree() {
    const tree = buildProjectsTreePayload();
    publish("projects.tree", tree);
    publish("projects.snapshot", {
      global_mode: true,
      controller_root: controllerRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      projects: tree.projects,
    });
    return tree;
  }

  function ensureStandaloneSurface(agentId) {
    if (!standaloneSurfaces.has(agentId)) {
      const surface = createAgentSurface();
      const initial = loadInternalAgentTranscript(activeProjectRoot, agentId, {
        maxEvents: 300,
        maxEntries: 300,
      });
      if (initial.length) {
        surface.apply("transcript.reset", { entries: initial });
      }
      const events = readAgentSurfaceEvents(activeProjectRoot, [agentId]);
      let maxSeq = 0;
      if (events.length) {
        surface.apply("transcript.reset", { entries: [] });
        for (const evt of events) {
          surface.accept(evt.data.surface);
          maxSeq = Math.max(maxSeq, evt.seq || 0);
        }
      }
      standaloneSurfaces.set(agentId, { surface, seq: maxSeq });
    }
    return standaloneSurfaces.get(agentId);
  }

  function pollStandaloneWorkerSurface() {
    if (stageTarget.kind !== "worker_single" || !stageTarget.agentId) return;
    const agentId = stageTarget.agentId;
    const meta = controller.session.metaMap.get(agentId) || {};
    if (!isInternalAgentMeta(meta)) return;

    if (standaloneReaderRoot !== activeProjectRoot || !standaloneReader) {
      standaloneReaderRoot = activeProjectRoot;
      standaloneReader = createAgentSurfaceReader(activeProjectRoot);
    }
    const holder = ensureStandaloneSurface(agentId);
    let dirty = false;
    for (const evt of standaloneReader.read([agentId])) {
      if ((evt.seq || 0) > holder.seq) {
        holder.seq = evt.seq || holder.seq;
        if (holder.surface.accept(evt.data.surface)) dirty = true;
      }
    }
    if (dirty) publishStandaloneWorkerFrame(agentId);
  }

  function buildStandaloneWorkerFrame(agentId) {
    const id = String(agentId || "").trim();
    const meta = controller.session.metaMap.get(id) || {};
    const internal = isInternalAgentMeta(meta);
    const draft = standaloneDrafts.get(id) || { text: "", revision: 0 };

    if (internal) {
      const holder = ensureStandaloneSurface(id);
      const snap = holder.surface.snapshot();
      return {
        project_root: activeProjectRoot,
        agent_id: id,
        label: getAgentLabel(id),
        type: String(meta.agent_type || meta.type || id.split(":")[0] || "worker"),
        internal: true,
        external: false,
        entries: snap.entries.map((e) => ({
          ...e,
          text: stripTags(e.text || ""),
          detail: stripTags(e.detail || ""),
        })),
        status: snap.status || String(meta.activity_state || "ready"),
        busy: Boolean(snap.busy || meta.activity_state === "working"),
        usage: snap.usage || "",
        plan: snap.plan || [],
        activity_detail: String(meta.activity_detail || ""),
        group_id: String(meta.group_id || ""),
        group_template_alias: String(meta.group_template_alias || ""),
        worktree_root: String(meta.worktree_root || meta.cwd || activeProjectRoot),
        input: draft.text,
        input_revision: draft.revision,
      };
    }

    const entries = loadInternalAgentTranscript(activeProjectRoot, id, {
      maxEvents: 400,
      maxEntries: 300,
    });
    const reports = listReports(activeProjectRoot, { agent: id, num: 25 });
    return {
      project_root: activeProjectRoot,
      agent_id: id,
      label: getAgentLabel(id),
      type: String(meta.agent_type || meta.type || id.split(":")[0] || "external"),
      internal: false,
      external: true,
      entries,
      reports,
      status: String(meta.activity_state || "online"),
      busy: meta.activity_state === "working",
      usage: "",
      plan: [],
      activity_detail: String(meta.activity_detail || ""),
      host_name: String(meta.host_name || meta.launch_mode || "terminal"),
      launch_mode: String(meta.launch_mode || "external"),
      worktree_root: String(meta.cwd || activeProjectRoot),
      input: draft.text,
      input_revision: draft.revision,
    };
  }

  function publishStandaloneWorkerFrame(agentId = stageTarget.agentId) {
    if (!agentId) return null;
    const frame = buildStandaloneWorkerFrame(agentId);
    publishLossy("worker.view.frame", frame);
    return frame;
  }

  async function applyAgentSettings(patch) {
    const root = activeProjectRoot;
    const model = patch.agent_model ?? patch.agentModel;
    if (model) {
      const current = loadConfig(root);
      const agentProvider = normalizeAgentProvider(patch.agent_provider ?? patch.agentProvider ?? current.agentProvider);
      const agentBaseUrl = patch.agent_base_url ?? patch.agentBaseUrl ?? current.agentBaseUrl;
      const confirmation = await confirmAgentModel(root, model, { config: { ...current, agentProvider, agentBaseUrl } });
      if (!confirmation.allowed) return { ok: false, error: confirmation.error };
    }
    if (root !== activeProjectRoot) return { ok: false, error: "The active workspace changed. Reopen settings and try again." };
    const applied = applySettingsPatch(root, patch);
    if (!applied.ok) return applied;
    Object.assign(settings, loadConfig(root));
    publish("settings.snapshot", applied.settings);
    const restart = applied.providerChanged
      || patch.agent_base_url != null
      || patch.agent_api_key != null
      || patch.agentBaseUrl != null
      || patch.agentApiKey != null;
    if (restart && daemonCoordinator?.restart) {
      publish("status.set", { text: "settings saved · restarting daemon…", busy: true });
      await daemonCoordinator.restart();
    }
    publish("status.set", { text: "settings saved", busy: false });
    publishProjectsTree();
    return applied;
  }

  const tools = createToolMergePublisher((name, payload) => publish(name, payload));

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
      // ignore watch errors
    }
  }

  function reconcileInternalWatches() {
    const next = new Set();
    if (multiSession && typeof multiSession.listInternalAgentIds === "function") {
      for (const id of multiSession.listInternalAgentIds()) next.add(id);
    }
    if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
      next.add(stageTarget.agentId);
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

  const agentSettings = createAgentSettingsController({
    getProjectRoot: () => activeProjectRoot,
    applyPatch: applyAgentSettings,
    publish: (...args) => publish(...args),
    logMessage: (...args) => appendLocal(...args),
    focusMain() {
      stageTarget = { kind: "project_main", agentId: "" };
      if (multiSession?.isActive()) {
        multiSession.handleFocus({ target: "chat" });
        publish("window.set", multiSession.getSnapshot());
      }
      controller.session.targetAgent = null;
      publish("prompt.set_prefix", { prefix: "› " });
    },
  });

  async function switchToProjectRoot(targetRoot, switchOpts = {}) {
    const root = canonicalProjectRoot(String(targetRoot || "").trim());
    const archived = desktopArchive.read().projects.some((item) => item.root === root);
    if (archived && !switchOpts.restoreArchived) {
      return { ok: false, error: "This folder is archived. Add it again to restore it." };
    }
    if (!fs.existsSync(getUfooPaths(root).ufooDir)) {
      const repoRoot = path.join(__dirname, "..", "..");
      const init = new env.UfooInit(repoRoot);
      await init.init({ targets: "context,bus", project: root });
    }
    upsertProjectRuntime({
      projectRoot: root,
      projectName: path.basename(root),
      socketPath: initialEndpoint.socketPath,
      status: "running",
      lastSwitchAt: new Date().toISOString(),
    });

    if (multiSession) multiSession.stop({ clearDrafts: false });
    standaloneSurfaces.clear();
    standaloneReader = null;
    activePendingInteraction = null;

    const targetEndpoint = resolveDaemonEndpoint(root, { controllerRoot });
    const targetDaemonRoot = targetEndpoint.scope === "global"
      ? targetEndpoint.controllerRoot
      : targetEndpoint.projectRoot;

    if (daemonCoordinator && typeof daemonCoordinator.switchProject === "function") {
      const res = await daemonCoordinator.switchProject({
        projectRoot: root,
        sockPath: targetEndpoint.socketPath,
        daemonRoot: targetDaemonRoot,
        transformRequest: (request) => routeDaemonRequest(targetEndpoint, request),
        autoStart: true,
      });
      if (!res || res.ok !== true) {
        return res || { ok: false, error: "switch failed" };
      }
    }

    if (archived) desktopArchive.restoreProject(root);
    activeProjectRoot = root;
    globalScope = root === controllerRoot ? "controller" : "project";
    stageTarget = switchOpts.agentId
      ? { kind: "worker_single", agentId: String(switchOpts.agentId).trim() }
      : { kind: "project_main", agentId: "" };

    Object.assign(settings, loadConfig(activeProjectRoot) || {});
    controller.session.targetAgent = null;
    controller.session.agents = [];
    controller.session.metaMap.clear();
    controller.session.labelMap.clear();
    controller.session.footer = "";

    await refreshRecoverableForActiveProject();
    controller.requestDaemonStatus();
    publish("app.snapshot", buildSnapshot());
    publishProjectsTree();
    publishRightInspectorAll();

    if (switchOpts.windowMode && ["main", "side", "multi"].includes(switchOpts.windowMode) && stageTarget.kind === "project_main") {
      changeWindowLayout(switchOpts.windowMode);
    } else if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
      publishStandaloneWorkerFrame(stageTarget.agentId);
    }
    return { ok: true, project_root: root };
  }

  async function switchToControllerRoot() {
    if (multiSession) multiSession.stop({ clearDrafts: false });
    activePendingInteraction = null;
    stageTarget = { kind: "project_main", agentId: "" };

    const controllerEndpoint = resolveDaemonEndpoint(controllerRoot, { controllerRoot });
    if (daemonCoordinator && typeof daemonCoordinator.switchProject === "function") {
      const res = await daemonCoordinator.switchProject({
        projectRoot: controllerRoot,
        sockPath: controllerEndpoint.socketPath,
        daemonRoot: controllerEndpoint.scope === "global"
          ? controllerEndpoint.controllerRoot
          : controllerEndpoint.projectRoot,
        transformRequest: (request) => routeDaemonRequest(controllerEndpoint, request),
      });
      if (!res || res.ok !== true) return res || { ok: false, error: "switch to controller failed" };
    }
    activeProjectRoot = controllerRoot;
    globalScope = "controller";
    controller.session.targetAgent = null;
    controller.session.agents = [];
    controller.session.metaMap.clear();
    controller.session.labelMap.clear();
    publish("app.snapshot", buildSnapshot());
    publishProjectsTree();
    return { ok: true, project_root: controllerRoot };
  }

  function changeWindowLayout(mode, explicitAgentId = "") {
    if (!multiSession) return { ok: false, error: "Window session not initialised" };
    if (!["main", "side", "multi", "cycle"].includes(mode)) {
      return { ok: false, error: "Invalid window mode" };
    }
    stageTarget = { kind: "project_main", agentId: "" };
    const result = multiSession.setLayout(mode, explicitAgentId);
    reconcileInternalWatches();
    publishProjectsTree();
    return result;
  }

  const controller = createChatController({
    projectRoot: controllerRoot,
    globalMode: true,
    ports: {
      publish,
      logMessage: (kind, text) => {
        const normalized = kind === "error" ? "error"
          : kind === "user" ? "user"
            : kind === "assistant" ? "assistant"
              : "system";
        appendLocal(normalized, stripTags(text));
      },
      setStatus: (text) => publish("status.set", { text: stripTags(text || "ready") }),
      appendHistory: (type, text, meta = {}) => {
        const { appendChatHistory } = require("../app/chat/historyStore");
        appendChatHistory(activeProjectRoot, type, stripTags(text), meta, historyOptions());
      },
      getHistoryOptions: () => historyOptions(),
      clearLog: () => {
        try {
          const { chatHistoryFilePath } = require("../app/chat/historyStore");
          const file = chatHistoryFilePath(activeProjectRoot, historyOptions());
          if (file && fs.existsSync(file)) fs.writeFileSync(file, "");
        } catch {
          // ignore
        }
        publish("transcript.reset", {});
      },
      restartDaemon: async () => {
        if (daemonCoordinator?.restart) await daemonCoordinator.restart();
      },
      isDaemonRunning: (root) => isRunning(root || activeProjectRoot),
      activateInternalAgent: (agentId) => {
        const id = String(agentId || "").trim();
        if (!isInternalAgentMeta(controller.session.metaMap.get(id))) {
          return { ok: false, error: "Internal agents only" };
        }
        stageTarget = { kind: "project_main", agentId: "" };
        return multiSession.start({
          kind: "side",
          agentIds: [id],
          focus: { target: "agent", agent_id: id },
        });
      },
      focusMultiPane: async (agentId) => {
        if (multiSession?.isMultiKind?.()) {
          multiSession.syncAgents();
          return Boolean(multiSession.focusAgent(agentId)?.ok);
        }
        const res = multiSession.start({ kind: "side", agentIds: [agentId], focus: { target: "agent", agent_id: agentId } });
        return Boolean(res && res.ok);
      },
      listProjects: () => listUnarchivedProjects().map((r) => ({
        project_root: r.root,
        project_name: r.label,
        status: r.status,
        label: r.label,
        root: r.root,
      })),
      getCurrentProject: () => ({ project_root: activeProjectRoot }),
      getActiveProjectRoot: () => activeProjectRoot,
      switchProject: (target) => switchToProjectRoot(
        typeof target === "object" ? (target.projectRoot || target.project_root || target.root) : target
      ),
      setWindowLayout: (args) => changeWindowLayout(parseWindowModeArgs(args)).ok,
      openAgentSettings: (section) => agentSettings.open(section),
      applyAgentModel: (...args) => agentSettings.applyModel(...args),
      applyAgentSettings,
      applyChatSettings: (patch = {}) => {
        if (patch.agentProvider != null) settings.agentProvider = patch.agentProvider;
        publish("settings.snapshot", buildSettingsSnapshot(settings));
      },
      dispatch: (action) => {
        if (!action || typeof action !== "object") return;
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
    },
  });

  multiSession = createRustMultiSession({
    getProjectRoot: () => activeProjectRoot,
    projectRoot: controllerRoot,
    getActiveAgents: () => [...controller.session.metaMap.keys()],
    getAgentMeta: (id) => controller.session.metaMap.get(id) || {},
    resolvePaneOptions: (agentId) => ({
      mode: "internal",
      initialEntries: loadInternalAgentTranscript(activeProjectRoot, agentId, {
        maxEvents: 250,
        maxEntries: 250,
      }),
    }),
    onInternalSubmit: (agentId, message) => {
      const requestId = `pane-send-${crypto.randomUUID()}`;
      internalSubmissions.set(requestId, { agentId, message, projectRoot: activeProjectRoot });
      return daemonSend({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        request_id: requestId,
        target: agentId,
        message: String(message || ""),
        injection_mode: "immediate",
        source: "ufoo-desktop",
      });
    },
    publish,
    publishLossy,
    getLabel: getAgentLabel,
  });

  function publishRightInspectorAll() {
    if (globalScope === "controller") return;
    try {
      publish("workspace.changes.snapshot", loadWorkspaceChanges(activeProjectRoot));
      publish("workspace.docs.snapshot", loadWorkspaceDocs(activeProjectRoot));
      publish("workspace.context.snapshot", handleWorkspaceContext(activeProjectRoot));
    } catch {
      // ignore initial inspector read errors
    }
  }

  function buildSnapshot() {
    const { loadChatHistory, loadInputHistory } = require("../app/chat/historyStore");
    const history = loadChatHistory(activeProjectRoot, 250, historyOptions());
    const inputHistory = loadInputHistory(activeProjectRoot, 200, historyOptions());
    const agents = controller.getAgentsSnapshot();
    const settingsSnap = buildSettingsSnapshot(loadConfig(activeProjectRoot) || settings);
    const tree = buildProjectsTreePayload();
    return {
      status: "ready",
      package_version: PACKAGE_VERSION,
      footer: agents.footer || "",
      entries: rawHistoryToEntries(history),
      input_history: Array.isArray(inputHistory) ? inputHistory.filter(Boolean) : [],
      agents: agents.agents,
      settings: settingsSnap,
      agent_provider: settingsSnap.agent_provider,
      provider_options: settingsSnap.provider_options,
      global_mode: true,
      controller_root: controllerRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      stage_target: { ...stageTarget },
      pending_interaction: activePendingInteraction,
      projects: tree.projects,
      cron: agents.cron && agents.cron.tasks ? agents.cron.tasks : [],
      loop: agents.loop || null,
      loop_summary: formatLoopSummary(agents.loop || null),
      window: multiSession ? multiSession.getSnapshot() : { active: false, mode: "main" },
    };
  }

  async function applyIncomingHandoff(handoff = {}) {
    if (!handoff) return { ok: false, error: "empty handoff" };
    const targetProject = handoff.projectRoot || activeProjectRoot;
    const isWorker = handoff.target && handoff.target !== "main";
    if (targetProject && targetProject !== controllerRoot) {
      const result = await switchToProjectRoot(targetProject, {
        agentId: isWorker ? handoff.target : "",
        windowMode: !isWorker ? handoff.windowMode : "",
      });
      if (!result.ok) return result;
    }
    if (handoff.docPath && globalScope === "project") {
      publish("workspace.docs.snapshot", loadWorkspaceDocs(activeProjectRoot, { filePath: handoff.docPath }));
    }
    const state = {
      project_root: activeProjectRoot,
      stage_target: { ...stageTarget },
      window_mode: multiSession ? multiSession.getSnapshot().mode : "main",
      doc_path: handoff.docPath || "",
      ts: Date.now(),
    };
    publish("handoff.state", state);
    return { ok: true, ...state };
  }

  const host = createUiHostServer({
    socketPath: uiSocketPath,
    authToken: uiAuthToken,
    capabilities: [
      "chat",
      "scrollback",
      "prompt",
      MULTI_FRAMES_CAPABILITY,
      WINDOW_MODES_CAPABILITY,
      RAW_MARKDOWN_CAPABILITY,
      DESKTOP_HOST_CAPABILITY,
    ],
    onClientReady(socket) {
      const snap = createEnvelope({
        kind: "snapshot",
        name: "app.snapshot",
        seq: host.nextSeq(),
        scope: { surface: "desktop", project_id: activeProjectRoot },
        payload: buildSnapshot(),
      });
      socket.write(encodeMessage(snap));
      multiSession?.publishFrames();
      publishProjectsTree();
      if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
        publishStandaloneWorkerFrame(stageTarget.agentId);
      }
      publishRightInspectorAll();
    },
    async onCommand(cmd) {
      const name = String(cmd.name || "");
      const payload = cmd.payload && typeof cmd.payload === "object" ? cmd.payload : {};

      if (name === "app.exit") return { ok: true };

      if (name === "ui.resync.request") {
        publish("app.snapshot", buildSnapshot());
        multiSession?.publishFrames();
        publishProjectsTree();
        if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
          publishStandaloneWorkerFrame(stageTarget.agentId);
        }
        return { ok: true };
      }

      if (name === "project.add") {
        const root = String(payload.root || payload.projectRoot || "").trim();
        if (!root) return { ok: false, error: "Project directory path is required" };
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
          return { ok: false, error: `Directory does not exist: ${root}` };
        }
        return switchToProjectRoot(root, { restoreArchived: true });
      }

      if (name === "project.archive" || name === "session.archive") {
        const target = String(payload.root || "").trim();
        const id = String(payload.session_id || "").trim();
        if (!target) return { ok: false, error: "Missing project root" };
        let root;
        let missing = false;
        try {
          root = canonicalProjectRoot(target);
        } catch (error) {
          if (name !== "project.archive" || !["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          root = path.resolve(target);
          missing = true;
        }
        if (root === controllerRoot) return { ok: false, error: "The Global Router cannot be archived" };
        if (name === "project.archive") {
          if (missing) desktopArchive.archiveProject(root);
          if (activeProjectRoot === root) {
            const result = await switchToControllerRoot();
            if (!result.ok && !missing) return result;
          }
          if (!missing) desktopArchive.archiveProject(root);
        } else {
          if (!id) return { ok: false, error: "Missing session ID" };
          desktopArchive.archiveSession(root, id);
          if (activeProjectRoot === root && stageTarget.kind === "worker_single" && stageTarget.agentId === id) {
            changeWindowLayout("main");
          }
        }
        publishProjectsTree();
        return missing ? { ok: true, silent: true } : { ok: true };
      }

      if (name === "project.switch") {
        const root = String(payload.root || payload.projectRoot || "").trim();
        if (!root) return { ok: false, error: "Missing project root" };
        return switchToProjectRoot(root, {
          agentId: payload.agent_id || payload.agentId || "",
          windowMode: payload.window_mode || payload.windowMode || "",
        });
      }

      if (name === "project.return_controller") {
        return switchToControllerRoot();
      }

      if (name === "worker.focus_view") {
        const targetRoot = String(payload.root || payload.projectRoot || activeProjectRoot).trim();
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (targetRoot && canonicalProjectRoot(targetRoot) !== activeProjectRoot) {
          return switchToProjectRoot(targetRoot, { agentId });
        }
        if (!agentId || agentId === "main") {
          stageTarget = { kind: "project_main", agentId: "" };
          reconcileInternalWatches();
          publishProjectsTree();
          publish("window.set", multiSession.getSnapshot());
          multiSession.publishFrames();
          return { ok: true, stage_target: stageTarget };
        }
        stageTarget = { kind: "worker_single", agentId };
        reconcileInternalWatches();
        publishProjectsTree();
        const frame = publishStandaloneWorkerFrame(agentId);
        return { ok: true, stage_target: stageTarget, frame };
      }

      if (name === "side.select") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (!agentId) return { ok: false, error: "agent_id required" };
        stageTarget = { kind: "project_main", agentId: "" };
        const res = multiSession.start({
          kind: "side",
          agentIds: [agentId],
          focus: { target: "agent", agent_id: agentId },
        });
        reconcileInternalWatches();
        publishProjectsTree();
        return res;
      }

      if (name === "window.set" || name === "window.cycle") {
        return changeWindowLayout(
          name === "window.cycle" ? "cycle" : payload.mode,
          String(payload.agent_id || payload.agentId || "")
        );
      }

      if (name === "multi.focus") return multiSession.handleFocus(payload);
      if (name === "multi.viewport") return multiSession.handleViewport(payload);
      if (name === "multi.scroll") return multiSession.handleScroll(payload);
      if (name === "multi.expand") return multiSession.handleExpand(payload);

      if (name === "multi.raw") {
        if (stageTarget.kind === "worker_single" && payload.agent_id === stageTarget.agentId) {
          const id = stageTarget.agentId;
          const text = String(payload.input ?? "");
          const rev = Number(payload.input_revision) || 0;
          standaloneDrafts.set(id, { text: payload.submit ? "" : text, revision: rev });
          if (payload.submit && text.trim()) {
            const holder = isInternalAgentMeta(controller.session.metaMap.get(id))
              ? ensureStandaloneSurface(id)
              : null;
            holder?.surface.accept({ type: "task_submitted", message: text });
            daemonSend({
              type: IPC_REQUEST_TYPES.BUS_SEND,
              request_id: `worker-send-${crypto.randomUUID()}`,
              target: id,
              message: text,
              injection_mode: "immediate",
              source: "ufoo-desktop-worker",
            });
          }
          publishStandaloneWorkerFrame(id);
          return { ok: true, input_revision: rev };
        }
        return multiSession.handleRaw(payload);
      }

      if (name === "multi.cancel" || (name === "task.cancel" && payload.agent_id)) {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (agentId && isInternalAgentMeta(controller.session.metaMap.get(agentId))) {
          const { cancelInternalTask } = require("../agents/internal/taskControl");
          await Promise.resolve(cancelInternalTask(activeProjectRoot, agentId)).catch(() => {});
          return { ok: true, cancelled_agent: agentId };
        }
        return multiSession.handleCancel(payload);
      }

      if (name === "task.cancel") {
        if (payload.task_run_id) {
          daemonSend({
            type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
            operation: "cancel",
            task_run_id: String(payload.task_run_id),
          });
        }
        publish("status.set", { text: "cancel requested", busy: false });
        publish("stream.done", { id: "cancel" });
        return { ok: true };
      }

      if (name === "worker.launch") {
        const groupAlias = String(payload.group || payload.template || "").trim();
        if (groupAlias) {
          daemonSend({
            type: IPC_REQUEST_TYPES.LAUNCH_GROUP,
            template: groupAlias,
            objective: String(payload.objective || ""),
            internal_only: true,
          });
          return { ok: true, launched: "group", template: groupAlias };
        }
        const agentType = String(payload.agent || payload.type || "ucode").trim();
        const request = {
          type: IPC_REQUEST_TYPES.LAUNCH_AGENT,
          agent: agentType,
          count: Math.max(1, Number(payload.count) || 1),
          nickname: String(payload.nickname || "").trim() || undefined,
          internal_only: true,
        };
        if (payload.root) {
          const root = canonicalProjectRoot(payload.root);
          if (root === controllerRoot) return { ok: false, error: "Choose a project to launch a worker" };
          if (root !== activeProjectRoot) {
            const result = await switchToProjectRoot(root);
            if (!result.ok) return result;
          }
          const response = await requestDaemon(root, request, { controllerRoot, fullResponse: true, timeoutMs: 30000 });
          const launch = response.opsResults?.find(({ action }) => action === "launch");
          if (launch?.ok === false) return { ok: false, error: launch.error || "Worker launch failed" };
        } else {
          daemonSend(request);
        }
        return { ok: true, launched: "worker", agent: agentType };
      }

      if (name === "worker.resume") {
        const targetId = String(payload.id || payload.target || "").trim();
        if (!targetId) return { ok: false, error: "Recoverable worker or group ID required" };
        await controller.submitInput(`/resume ${targetId}`);
        await refreshRecoverableForActiveProject();
        publishProjectsTree();
        return { ok: true, resumed: targetId };
      }

      if (name === "worker.focus_external") {
        const agentId = String(payload.agent_id || payload.agentId || stageTarget.agentId || "").trim();
        const meta = getHandoffAgentMeta(agentId);
        if (!meta || isInternalAgentMeta(meta)) return { ok: false, error: "External worker not found" };
        return focusExternalAgentHost(activeProjectRoot, meta);
      }

      if (name === "agent.close") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (!isInternalAgentMeta(controller.session.metaMap.get(agentId))) {
          return { ok: false, error: "External agents own their lifecycle" };
        }
        daemonSend({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: agentId });
        if (stageTarget.kind === "worker_single" && stageTarget.agentId === agentId) {
          stageTarget = { kind: "project_main", agentId: "" };
        }
        return { ok: true };
      }

      if (name === "agent.select") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        controller.session.targetAgent = agentId || null;
        publish("prompt.set_prefix", {
          prefix: agentId ? `›@${getAgentLabel(agentId)} ` : "› ",
        });
        return { ok: true, agent_id: agentId };
      }

      if (name === "completion.request") {
        const fmt = require("./format");
        const { getChatCommandCatalog } = require("../app/chat/commands");
        const agents = controller.session.agents.slice();
        const agentLabels = agents.map(getAgentLabel);
        const dynamic = loadDynamicCompletionSources(activeProjectRoot);
        const completionRoot = activeProjectRoot;
        const resumeQuery = /^\/resume(?:\s|$)/.test(String(payload.text || "").trimStart());
        const resumeTargets = resumeQuery ? await refreshRecoverableForActiveProject() : [];
        const settingsLists = await agentSettings.completions(String(payload.text || ""));
        if (completionRoot !== activeProjectRoot) return { ok: true, stale: true };
        const items = fmt.buildCompletions({
          text: String(payload.text || ""),
          agents,
          agentLabels,
          ...getChatCommandCatalog({ globalMode: true }),
          groupTemplates: dynamic.groupTemplates,
          soloProfiles: dynamic.soloProfiles,
          argumentLists: { ...settingsLists, ...(resumeQuery ? { "/resume": resumeTargets } : {}) },
          limit: Math.max(25, ...Object.values(settingsLists).map((list) => list.length)),
        });
        publish("completions.set", { items, text: String(payload.text || "") });
        return { ok: true, count: items.length, items };
      }

      if (name === "settings.open") return agentSettings.open(payload.section || "model");
      if (name === "settings.set") return applyAgentSettings(payload);
      if (name === "settings.models") {
        const root = activeProjectRoot;
        const current = loadConfig(root);
        const agentProvider = normalizeAgentProvider(payload.agent_provider ?? current.agentProvider);
        const defaultModel = defaultAgentModelForProvider(agentProvider);
        if (agentProvider === "custom" && current.agentProvider !== "custom") {
          return { ok: false, models: [], default_model: defaultModel };
        }
        const agentModel = agentProvider === current.agentProvider ? current.agentModel : defaultModel;
        const catalog = await listAgentModels(root, { config: { ...current, agentProvider, agentModel } })
          .catch(() => ({ ok: false, models: [] }));
        return { ok: catalog.ok, models: catalog.models, default_model: defaultModel };
      }

      if (name === "interaction.respond") {
        const settingsReply = await agentSettings.respond(payload);
        if (settingsReply) return settingsReply;
        const interactionId = String(payload.id || activePendingInteraction?.id || "").trim();
        const answerText = String(payload.text ?? payload.answer ?? "").trim();
        if (interactionId && !payload.cancelled) {
          daemonSend({
            type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
            operation: "resume",
            interaction_id: interactionId,
            answer: answerText,
          });
        }
        activePendingInteraction = null;
        publish("interaction.clear", { id: interactionId });
        publishProjectsTree();
        return { ok: true };
      }

      if (name === "workspace.changes") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const snap = loadWorkspaceChanges(root, payload);
        publish("workspace.changes.snapshot", snap);
        return { ok: true, data: snap };
      }

      if (name === "workspace.docs") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const snap = loadWorkspaceDocs(root, payload);
        publish("workspace.docs.snapshot", snap);
        return { ok: true, data: snap };
      }

      if (name === "workspace.context") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const snap = handleWorkspaceContext(root, payload);
        publish("workspace.context.snapshot", snap);
        return { ok: true, data: snap };
      }

      if (name === "handoff.to_cli") {
        const agentId = stageTarget.kind === "worker_single" ? stageTarget.agentId : (payload.agent_id || "");
        if (agentId) {
          const meta = getHandoffAgentMeta(agentId);
          if (!meta) return { ok: false, error: "Worker not found" };
          if (!isInternalAgentMeta(meta)) return focusExternalAgentHost(activeProjectRoot, meta);
        }
        const winMode = multiSession ? multiSession.getSnapshot().mode : "main";
        return launchCliHandoff({
          projectRoot: activeProjectRoot,
          windowMode: payload.window_mode || winMode,
          agentId,
          preferredTerminal: payload.terminal || "",
          dryRun: Boolean(payload.dryRun),
        });
      }

      if (name === "handoff.open_url") {
        const parsed = payload.url ? parseHandoffUrl(payload.url) : payload;
        return applyIncomingHandoff(parsed);
      }

      if (name === "cli.install_shims") {
        return installCliShims({
          coreRoot: payload.coreRoot || path.resolve(__dirname, "..", ".."),
          nodeExecutable: payload.nodeExecutable || process.execPath,
          tuiBinary: payload.tuiBinary || process.env.UFOO_TUI_BIN || "",
          targetDir: payload.targetDir || undefined,
          updateZshrc: Boolean(payload.updateZshrc),
        });
      }

      if (name === "cron.stop") {
        const id = String(payload.id || "").trim();
        if (!id) return { ok: false, error: "missing cron id" };
        daemonSend({ type: IPC_REQUEST_TYPES.CRON, operation: "stop", id });
        controller.requestDaemonStatus();
        return { ok: true };
      }

      if (name === "input.submit") {
        const text = String(payload.text || "");
        if (stageTarget.kind === "worker_single" && stageTarget.agentId && !text.trimStart().startsWith("/")) {
          const workerId = stageTarget.agentId;
          if (!text.trim()) return { ok: true, routed: "empty" };
          standaloneDrafts.set(workerId, { text: "", revision: (standaloneDrafts.get(workerId)?.revision || 0) + 1 });
          if (isInternalAgentMeta(controller.session.metaMap.get(workerId))) {
            ensureStandaloneSurface(workerId).surface.accept({ type: "task_submitted", message: text });
          }
          daemonSend({
            type: IPC_REQUEST_TYPES.BUS_SEND,
            request_id: `worker-submit-${crypto.randomUUID()}`,
            target: workerId,
            message: text,
            injection_mode: "immediate",
            source: "ufoo-desktop-worker",
          });
          publishStandaloneWorkerFrame(workerId);
          return { ok: true, routed: "worker", agent_id: workerId };
        }

        const routing = resolveSubmittedInputTarget(
          payload,
          controller.session.targetAgent,
          (id) => controller.session.agents.includes(String(id || "").trim())
        );
        if (!routing.ok) return routing;
        controller.session.targetAgent = routing.target;
        const beforeSubmit = mainSubmissionRev;
        await controller.submitInput(text);
        if (!routing.target && beforeSubmit === mainSubmissionRev) {
          publish("status.set", { text: "ready", busy: false });
        }
        return { ok: true, routed: text.trim() ? "submit" : "empty" };
      }

      return { ok: false, error: `Unsupported command: ${name}` };
    },
  });

  hostRef = host;
  await host.listen();

  const router = createDaemonMessageRouter({
    escapeBlessed: (v) => String(v || ""),
    resolveAgentDisplayName: getAgentLabel,
    stripBlessedTags: stripTags,
    isOwnRequestId: (id) => ownRequestIds.has(id),
    onInteractionRequest: (interaction) => {
      activePendingInteraction = interaction;
      publish("interaction.request", interaction);
      publishProjectsTree();
    },
    onInteractionClear: (info) => {
      activePendingInteraction = null;
      publish("interaction.clear", info || {});
      publishProjectsTree();
    },
    logMessage: (kind, text) => {
      const normalized = kind === "error" ? "error"
        : kind === "user" ? "user"
          : kind === "assistant" ? "assistant"
            : "system";
      appendLocal(normalized, stripTags(text));
    },
    renderScreen: () => {},
    updateDashboard: (data) => {
      controller.applyStatus(data);
      const payload = buildDashboardPublishPayload(controller, data);
      publish("agents.snapshot", {
        agents: payload.agents,
        footer: payload.footer,
      });
      if (multiSession) {
        try { multiSession.syncAgents(); } catch {}
      }
      reconcileInternalWatches();
      publish("cron.snapshot", {
        tasks: payload.cron,
        cron: payload.cron,
        loop: payload.loop,
        loop_summary: payload.loop_summary,
      });
      publishProjectsTree();
      if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
        publishStandaloneWorkerFrame(stageTarget.agentId);
      }
    },
    requestStatus: () => controller.requestDaemonStatus(),
    getPending: () => controller.session.pending,
    setPending: (value) => {
      controller.session.pending = value || null;
      publishProjectsTree();
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
    setTransientAgentState: (agentId, value, extra = {}) => {
      controller.patchAgentActivity(agentId, {
        activity_state: value,
        activity_detail: extra.detail || "",
      });
      publishProjectsTree();
    },
    clearTransientAgentState: (agentId) => {
      controller.patchAgentActivity(agentId, {
        activity_state: "",
        activity_detail: "",
      });
      publishProjectsTree();
    },
  });

  const daemonConnection = createDaemonConnection({
    connectClient: daemonTransport.connectClient.bind(daemonTransport),
    transformRequest: (request) => routeDaemonRequest(initialEndpoint, request),
    handleMessage: (msg) => {
      if (!msg || typeof msg !== "object") return;
      if ([IPC_RESPONSE_TYPES.BUS_SEND_OK, IPC_RESPONSE_TYPES.ERROR].includes(msg.type)) {
        const id = msg.request_id || (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK
          ? internalSubmissions.keys().next().value
          : "");
        const submission = internalSubmissions.get(id);
        if (submission) {
          internalSubmissions.delete(id);
          if (submission.projectRoot === activeProjectRoot && msg.type === IPC_RESPONSE_TYPES.ERROR) {
            multiSession.acceptEvent(submission.agentId, {
              type: "submission_failed",
              message: submission.message,
              error: `Message delivery failed: ${msg.error || "unknown error"}`,
            });
          }
          controller.requestDaemonStatus();
          return;
        }
      }
      if (msg.type === IPC_RESPONSE_TYPES.STATUS) {
        const root = msg.data && (msg.data.projectRoot || msg.data.project_root);
        if (root && canonicalProjectRoot(root) !== canonicalProjectRoot(activeProjectRoot)) return;
      }
      if (msg.type === IPC_RESPONSE_TYPES.BUS) {
        if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
          const evtData = msg.data || {};
          if (evtData.event === "agent_surface" && evtData.publisher === stageTarget.agentId) {
            const holder = ensureStandaloneSurface(stageTarget.agentId);
            holder.seq = Math.max(holder.seq, evtData.seq || 0);
            holder.surface.accept(evtData.data?.surface || {});
            publishStandaloneWorkerFrame(stageTarget.agentId);
          } else if (!isInternalAgentMeta(controller.session.metaMap.get(stageTarget.agentId))) {
            publishStandaloneWorkerFrame(stageTarget.agentId);
          }
        }
        if (!isInternalDashboardEvent(msg.data || {}, (id) => controller.session.metaMap.get(id))) return;
        try {
          writeMultiPaneBusEvent(msg.data || {}, {
            agentIds: multiSession.listInternalAgentIds?.() || [],
            getMeta: (id) => controller.session.metaMap.get(id) || {},
            writeToPane: (id, text) => multiSession.writeToPane(id, text),
            acceptEvent: (id, event, seq) => multiSession.acceptEvent(id, event, seq),
            hasStructuredEvents: (id) => multiSession.hasStructuredEvents(id),
          });
        } catch {
          // ignore mirror errors
        }
        if (msg.data?.event === "agent_surface") return;
      }
      if (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK) {
        controller.requestDaemonStatus();
        if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
          publishStandaloneWorkerFrame(stageTarget.agentId);
        }
        return;
      }
      router.handleMessage(msg);
    },
    queueStatusLine: (text) => publish("status.set", { text: stripTags(text) }),
    resolveStatusLine: (text) => publish("status.set", { text: stripTags(text || "ready") }),
    logMessage: (kind, text) => appendLocal(kind === "error" ? "error" : "system", stripTags(text)),
  });

  daemonCoordinator = createDaemonCoordinator({
    projectRoot: controllerRoot,
    daemonTransport,
    daemonConnection,
    stopDaemon,
    startDaemon,
    isDaemonRunning: isRunning,
    queueStatusLine: (text) => publish("status.set", { text: stripTags(text) }),
    resolveStatusLine: (text) => publish("status.set", { text: stripTags(text || "ready") }),
    logMessage: (kind, text) => appendLocal(kind === "error" ? "error" : "system", stripTags(text)),
  });

  await daemonConnection.connect();
  daemonSend = (req) => {
    const reqId = req && (req.request_id || req.id);
    if (reqId) {
      ownRequestIds.add(String(reqId));
      if (ownRequestIds.size > 500) ownRequestIds.delete(ownRequestIds.values().next().value);
    }
    if (req.type === IPC_REQUEST_TYPES.PROMPT) mainSubmissionRev += 1;
    return daemonConnection.send(req);
  };
  controller.setSend(daemonSend);
  controller.start({
    send: daemonSend,
    sendStatus: () => daemonSend({ type: IPC_REQUEST_TYPES.STATUS }),
    statusIntervalMs: 3000,
  });

  const archivedRoots = new Set(desktopArchive.read().projects.map(({ root }) => root));
  if (initialProjectRoot !== controllerRoot && !archivedRoots.has(initialProjectRoot) && fs.existsSync(initialProjectRoot)) {
    await switchToProjectRoot(initialProjectRoot);
  } else {
    const [firstProject] = listUnarchivedProjects();
    if (firstProject && options.autoSelectFirstProject !== false) {
      await switchToProjectRoot(firstProject.root);
    }
  }

  let handoffServer = null;
  if (options.enableHandoffServer !== false) {
    handoffServer = createDesktopHandoffServer({
      socketPath: options.handoffSocketPath,
      onHandoff: (parsed) => {
        void applyIncomingHandoff(parsed);
      },
    });
    await handoffServer.listen().catch(() => {});
  }

  standalonePollTimer = setInterval(pollStandaloneWorkerSurface, 350);
  standalonePollTimer.unref?.();
  treePollTimer = setInterval(() => {
    void refreshRecoverableForActiveProject().then(() => publishProjectsTree());
  }, 6000);
  treePollTimer.unref?.();

  async function close() {
    clearInterval(standalonePollTimer);
    clearInterval(treePollTimer);
    if (handoffServer) await handoffServer.close().catch(() => {});
    if (multiSession?.isActive()) {
      try { multiSession.stop(); } catch {}
    }
    controller.stop();
    daemonConnection.markExit();
    daemonConnection.close();
    await host.close();
  }

  return {
    socketPath: uiSocketPath,
    authToken: uiAuthToken,
    handoffSocketPath: handoffServer ? handoffServer.socketPath : "",
    getActiveProjectRoot: () => activeProjectRoot,
    getStageTarget: () => ({ ...stageTarget }),
    applyIncomingHandoff,
    close,
  };
}

module.exports = {
  startDesktopUiHost,
  rawHistoryToEntries,
  inspectDormantProjectSummary,
};
