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
const { execFileSync } = require("child_process");
const { createUiHostServer, createAuthToken } = require("./uiHostServer");
const { createRemoteRelayBridge } = require("./remoteRelayBridge");
const { createDesktopArchive } = require("./desktopArchive");
const { createDesktopSessionPrefs } = require("./desktopSessionPrefs");
const { createToolMergePublisher } = require("./toolMergeBridge");
const { createRustMultiSession } = require("./rustMultiSession");
const { createAgentSurface } = require("./agentSurface");
const { toolStatus, statusForAgentPhase } = require("./agentPresentation");
const fmt = require("./format");
const { writeMultiPaneBusEvent } = require("./multiPaneBusMirror");
const { buildSettingsSnapshot, applySettingsPatch } = require("./settingsBridge");
const { createAgentSettingsController } = require("./agentSettingsController");
const { listAgentModels, confirmAgentModel } = require("../agents/providers/modelSettings");
const { loadGlobalProjectRows, buildDashboardPublishPayload, formatLoopSummary } = require("./dashboardBridge");
const {
  loadWorkspaceChanges,
  loadWorkspaceDocs,
  handleWorkspaceContext,
  buildDecisionTidyPrompt,
  detectGitBranch,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitSuggestCommitMessage,
  gitCommit,
  gitPush,
  gitCreatePr,
} = require("./workspaceInspector");
const { detectInstalledAcpAgents } = require("../agents/providers/acpRegistry");
const { isAgyAvailable, listAgyCliModels } = require("../agents/providers/agyThreadProvider");
const { mergeManagedWorktree, removeManagedWorktree } = require("../runtime/worktree/worktreeManager");
const {
  probeOnboardingState,
  saveOnboardingState,
  launchLoginInTerminal,
  configureExternalHostMcp,
} = require("./onboardingProbe");
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
const { clearChatHistory } = require("../app/chat/historyStore");
const {
  readAgentSurfaceEvents,
  createAgentSurfaceReader,
  createAgentSurfacePublisher,
  resolveAgentLineageIds,
} = require("../coordination/history/agentSurface");
const { listReports } = require("../coordination/report/store");
const { getUfooPaths } = require("../coordination/state/paths");
const { loadAgentsData, updateAgentsData } = require("../coordination/state/agentsStore");
const { isAgentPidAlive } = require("../coordination/bus/utils");
const { closeAgent, getRecoverableAgents } = require("../runtime/daemon/ops");
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
  getLaunchdServiceStatus,
  installLaunchdService,
  uninstallLaunchdService,
  restartLaunchdService,
  readDaemonPid,
} = require("../runtime/daemon/launchdService");
const {
  canonicalProjectRoot,
  buildProjectId,
  upsertProjectRuntime,
  resolveGlobalControllerProjectRoot,
} = require("../runtime/projects");
const { loadConfig, saveConfig, normalizeAgentProvider, defaultAgentModelForProvider } = require("../config");
const { normalizeThinkingLevel } = require("../agents/providers/thinkingLevels");
const { configureInternalAgent, clearInternalAgent } = require("../agents/internal/taskControl");
const { persistAgentRuntimeMeta, clearProviderSessionId } = require("../agents/internal/internalRunner");
const {
  connectWorkflowEdge,
  disconnectWorkflowEdge,
  disbandAdhocGroup,
  renameAdhocGroup,
  getWorkflowSnapshot,
  saveNodePositions,
} = require("../orchestration/groups/workflowGraph");
const {
  stageAttachments,
  normalizeAttachmentList,
  formatAttachmentPromptSummary,
} = require("../runtime/attachments");
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

const REDUNDANT_ACTIVITY_DETAIL_RE = /^(?:runner|ucode|codex|claude|agy|kimi|grok|codex-cli|claude-cli|agy-cli|kimi-cli|grok-cli|acp[:_-][a-z0-9._-]+)$/i;

function sanitizeUiActivityDetail(detail) {
  const text = String(detail || "").trim();
  if (!text || REDUNDANT_ACTIVITY_DETAIL_RE.test(text)) return "";
  return text;
}

function buildProjectSpeakerIndex(projectRoot, liveMetaMap = null) {
  const index = new Map();
  index.set("ufoo", { id: "ufoo-agent", type: "ufoo" });
  index.set("ufoo-agent", { id: "ufoo-agent", type: "ufoo" });
  if (!projectRoot) return index;

  const projectPrefix = `${path.basename(projectRoot).toLowerCase()}-`;
  const register = (key, info) => {
    const clean = String(key || "").trim().toLowerCase();
    if (!clean || !info.type || index.has(clean)) return;
    index.set(clean, info);
  };

  const candidates = [];
  if (liveMetaMap && typeof liveMetaMap.entries === "function") {
    for (const [id, meta] of liveMetaMap.entries()) {
      if (!meta || typeof meta !== "object") continue;
      candidates.push({ id, meta, live: true });
    }
  }
  try {
    const { agentsFile } = getUfooPaths(projectRoot);
    if (fs.existsSync(agentsFile)) {
      const data = loadAgentsData(agentsFile);
      for (const [id, meta] of Object.entries(data?.agents || {})) {
        if (!meta || typeof meta !== "object") continue;
        candidates.push({ id, meta, live: meta.status === "active" });
      }
    }
  } catch {
    // ignore disk read errors
  }

  candidates.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    const aTime = String(a.meta.last_seen || a.meta.joined_at || "");
    const bTime = String(b.meta.last_seen || b.meta.joined_at || "");
    return bTime.localeCompare(aTime);
  });

  for (const { id, meta } of candidates) {
    if (!id || id === "ufoo-agent" || id.endsWith(":ufoo-agent")) continue;
    const type = String(meta.agent_type || meta.type || (id.includes(":") ? id.split(":")[0] : "") || "").trim();
    if (!type) continue;
    const label = String(meta.display_nickname || meta.nickname || meta.group_member_id || "").trim();
    const info = { id, type, label };
    register(id, info);
    register(meta.display_nickname, info);
    register(meta.nickname, info);
    register(meta.scoped_nickname, info);
    register(meta.group_member_id, info);
    for (const rawName of [meta.display_nickname, meta.nickname, meta.scoped_nickname]) {
      const lower = String(rawName || "").trim().toLowerCase();
      if (projectPrefix.length > 1 && lower.startsWith(projectPrefix) && lower.length > projectPrefix.length) {
        register(lower.slice(projectPrefix.length), info);
      }
    }
  }

  try {
    const { groupsDir } = getUfooPaths(projectRoot);
    if (fs.existsSync(groupsDir)) {
      const groupFiles = fs.readdirSync(groupsDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
          const fullPath = path.join(groupsDir, file);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(fullPath).mtimeMs || 0; } catch {}
          return { fullPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { fullPath } of groupFiles) {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        for (const member of Array.isArray(parsed?.members) ? parsed.members : []) {
          if (!member || typeof member !== "object") continue;
          const memberIds = [
            member.subscriber_id,
            member.previous_subscriber_id,
            member.bootstrapped_subscriber_id,
            ...(Array.isArray(member.launch?.subscriber_ids) ? member.launch.subscriber_ids : []),
            ...(Array.isArray(member.previous_subscriber_ids) ? member.previous_subscriber_ids : []),
          ].map((v) => String(v || "").trim()).filter(Boolean);
          const primaryId = memberIds[0] || "";
          const type = String(
            member.type
            || member.agent
            || (primaryId.includes(":") ? primaryId.split(":")[0] : "")
            || ""
          ).trim();
          if (!type) continue;
          const label = String(
            member.nickname
            || member.template_agent_id
            || member.member_id
            || member.scoped_nickname
            || ""
          ).trim();
          const info = { id: primaryId || type, type, label };
          for (const subId of memberIds) {
            register(subId, { ...info, id: subId });
          }
          register(member.member_id, info);
          register(member.template_agent_id, info);
          register(member.nickname, info);
          register(member.scoped_nickname, info);
        }
      }
    }
  } catch {
    // ignore group read errors
  }

  return index;
}

function rawHistoryToEntries(rows, speakerIndex = null) {
  const list = Array.isArray(rows) ? rows : [];
  const KINDS = new Set([
    "system", "user", "assistant", "error", "agent", "report",
    "thinking", "tool", "spacer", "meta", "bus", "success", "banner",
    "plan",
  ]);
  const mapped = list.map((row, index) => {
    const source = row && typeof row === "object" ? row : { text: row };
    const meta = source.meta && typeof source.meta === "object" ? source.meta : {};
    const sourceType = String(source.sourceType || source.type || source.kind || "system");
    const streamed = sourceType === "bus" && meta.stream_done === true;
    const kind = streamed || sourceType === "reply"
      ? "assistant"
      : KINDS.has(sourceType) ? sourceType : "system";
    let text = stripTags(source.text || source.content || "");
    let speaker = String(source.speaker || meta.speaker || "");
    let targetId = String(source.target_id || meta.target_id || "").trim();
    let targetLabel = String(source.target_label || meta.target_label || "").trim();
    let targetType = String(source.target_type || meta.target_type || "").trim();
    if (kind === "user") {
      const directMatch = text.match(/^(?:›\s+)?@([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63})\s+([\s\S]+)$/);
      if (directMatch) {
        const mentionToken = directMatch[1].trim();
        const hit = speakerIndex && typeof speakerIndex.get === "function"
          ? speakerIndex.get(mentionToken.toLowerCase())
          : null;
        if (targetLabel || hit) {
          if (!targetId && hit?.id) targetId = hit.id;
          if (!targetType && hit?.type) targetType = hit.type;
          if (!targetLabel) targetLabel = hit?.label || mentionToken;
          text = directMatch[2];
        }
      }
      if ((targetLabel || targetId) && speakerIndex && typeof speakerIndex.get === "function") {
        const hit = speakerIndex.get((targetLabel || targetId).toLowerCase())
          || (targetId ? speakerIndex.get(targetId.toLowerCase()) : null);
        if (hit) {
          if (!targetId && hit.id) targetId = hit.id;
          if (!targetType && hit.type) targetType = hit.type;
          if (hit.label && (!targetLabel || targetLabel.includes(":"))) {
            targetLabel = hit.label;
          }
        }
      }
    }
    if (streamed) {
      const match = text.match(/^([^\n]+?): ([\s\S]*)$/);
      if (match) {
        speaker = speaker || match[1];
        text = match[2];
      }
    } else if (kind === "assistant" && /^ufoo(?:-agent)?\s*·\s*/i.test(text)) {
      speaker = speaker || "ufoo";
      text = text.replace(/^ufoo(?:-agent)?\s*·\s*/i, "");
    }
    let senderId = String(source.sender_id || meta.sender_id || "");
    let senderType = String(source.sender_type || meta.sender_type || "");
    if (speakerIndex && typeof speakerIndex.get === "function") {
      let lookupName = speaker || senderId;
      if (!lookupName) {
        const attributed = text.match(/^([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,47})\s*·\s+[\s\S]+$/);
        if (attributed) lookupName = attributed[1];
      }
      const hit = lookupName ? speakerIndex.get(String(lookupName).trim().toLowerCase()) : null;
      if (hit) {
        if (!senderId && hit.id) senderId = hit.id;
        if (!senderType && hit.type) senderType = hit.type;
        if (hit.label && speaker && speaker.includes(":") && speaker !== hit.label) {
          speaker = hit.label;
        }
      }
    }
    return {
      id: String(source.id || `hist-${index}`),
      kind,
      text,
      speaker,
      ...(senderId ? { sender_id: senderId } : {}),
      ...(senderType ? { sender_type: senderType } : {}),
      ...(targetId ? { target_id: targetId } : {}),
      ...(targetLabel ? { target_label: targetLabel } : {}),
      ...(targetType ? { target_type: targetType } : {}),
      detail: stripTags(source.detail || source.expanded_text || meta.detail || meta.expanded_text || ""),
      expanded: false,
      ts: source.ts || "",
    };
  });

  // Drop legacy duplicate "ufoo · <same body>" bus echoes immediately following a direct @agent user send.
  const deduped = [];
  for (const item of mapped) {
    const prev = deduped[deduped.length - 1];
    if (
      prev
      && prev.kind === "user"
      && prev.target_label
      && (item.kind === "bus" || item.kind === "system")
    ) {
      const m = String(item.text || "").match(/^(?:ufoo(?:-agent)?)\s*·\s+([\s\S]+)$/i);
      const prevBody = String(prev.text || "").replace(/^›\s+/, "").trim();
      const echoBody = m
        ? m[1].trim()
        : (/^ufoo(?:-agent)?$/i.test(String(item.speaker || "")) ? String(item.text || "").trim() : "");
      if (prevBody && echoBody && echoBody === prevBody) {
        continue;
      }
    }
    deduped.push(item);
  }
  return deduped;
}

function resolveProviderForWorkerType(workerType, config = {}) {
  const raw = String(workerType || "").trim().toLowerCase();
  if (!raw || raw === "main" || raw === "ufoo-agent") {
    return normalizeAgentProvider(config.agentProvider || "codex-cli");
  }
  if (raw === "codex" || raw === "codex-cli") return "codex-cli";
  if (raw === "claude" || raw === "claude-code" || raw === "claude-cli") return "claude-cli";
  if (raw === "ucode") return normalizeAgentProvider(config.ucodeProvider || config.agentProvider || "codex-cli");
  if (raw === "acp-kimi" || raw === "acp:kimi" || raw === "kimi") return "kimi-cli";
  if (raw === "acp-grok" || raw === "acp:grok" || raw === "grok") return "grok-cli";
  if (raw === "agy" || raw === "agy-cli" || raw === "antigravity" || raw === "acp:agy" || raw === "acp-agy") return "agy-cli";
  return "";
}

function thinkingLevelsForProvider(provider = "") {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "claude-cli") return ["off", "low", "medium", "high", "max"];
  if (p === "codex-cli") return ["off", "low", "medium", "high", "xhigh"];
  if (p === "agy-cli" || p === "agy") return ["low", "medium", "high", "xhigh"];
  return ["off", "low", "medium", "high", "xhigh", "max"];
}

function resolveWorkerDisplayModel(meta = {}, workerType = "", config = {}) {
  if (meta.model) return String(meta.model);
  const provider = resolveProviderForWorkerType(workerType, config);
  if (!provider) return "";
  if (workerType === "ucode" && config.ucodeModel) return String(config.ucodeModel);
  if (normalizeAgentProvider(config.agentProvider) === provider && config.agentModel) {
    return String(config.agentModel);
  }
  return defaultAgentModelForProvider(provider) || "";
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
      const cfg = loadConfig(projectRoot) || {};
      const data = loadAgentsData(paths.agentsFile) || {};
      for (const [id, meta] of Object.entries(data.agents || {})) {
        if (!meta || meta.status !== "active") continue;
        if (id === "ufoo-agent" || meta.agent_type === "ufoo-agent") continue;
        const pid = Number.parseInt(meta.pid, 10);
        const alive = meta.mcp_bridge === true || !pid || isAgentPidAlive(pid);
        if (!alive) continue;
        const internal = isInternalAgentMeta(meta);
        const workerType = String(meta.agent_type || meta.type || id.split(":")[0] || "worker");
        out.workers.push({
          id,
          label: String(meta.display_nickname || meta.nickname || id),
          type: workerType,
          internal,
          external: !internal,
          activity_state: String(meta.activity_state || "idle"),
          activity_detail: sanitizeUiActivityDetail(meta.activity_detail),
          group_id: String(meta.group_id || ""),
          group_member_id: String(meta.group_member_id || ""),
          group_template_alias: String(meta.group_template_alias || ""),
          host_name: String(meta.host_name || ""),
          launch_mode: String(meta.launch_mode || ""),
          worktree_root: String(meta.worktree_root || ""),
          worktree_branch: String(meta.worktree_branch || ""),
          model: resolveWorkerDisplayModel(meta, workerType, cfg),
          thinking_level: String(meta.thinking_level || cfg.agentThinking || "medium"),
          permission_mode: String(meta.permission_mode || cfg.permissionMode || "auto_edit"),
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
  const sessionPrefs = createDesktopSessionPrefs(controllerRoot);

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
  const stopDaemonFn = typeof options.stopDaemon === "function" ? options.stopDaemon : stopDaemon;

  const startDaemonForTransport = (root) => {
    if (
      !options.startDaemon
      && root === daemonRoot
      && process.platform === "darwin"
      && getLaunchdServiceStatus({ controllerRoot: daemonRoot }).loaded
    ) {
      const kick = restartLaunchdService({ controllerRoot: daemonRoot });
      if (kick.ok) return;
    }
    return startDaemonFn(root);
  };

  const daemonTransport = createDaemonTransport({
    projectRoot: controllerRoot,
    sockPath: initialEndpoint.socketPath,
    daemonRoot,
    isRunning: isDaemonRunning,
    startDaemon: startDaemonForTransport,
    stopDaemon: stopDaemonFn,
    connectWithRetry,
  });

  let entrySeq = 0;
  let mainSubmissionRev = 0;
  let hostRef = null;
  let remoteBridge = null;
  let daemonSend = () => {};
  let daemonCoordinator = null;
  let daemonConnectionState = "reconnecting";
  let activeProjectRoot = controllerRoot;
  let activeStatusSyncedRoot = "";
  let pendingSwitchRoot = "";
  let pendingSwitchStatus = null;
  let projectSwitchSeq = 0;
  let globalScope = "controller";
  let multiSession = null;
  let stageTarget = { kind: "project_main", agentId: "" };
  let routerRef = null;
  const pendingInteractions = new Map();
  const dismissedInteractions = new Map();
  const DISMISSED_INTERACTION_TTL_MS = 20000;
  let lastPublishedInteractionKey = "";

  // Host-owned outbound message queues per session target (main / worker).
  // Follow-up prompts submitted while an agent is busy wait here instead of
  // being prematurely appended into the live transcript history.
  const queuedMessageBuckets = new Map();
  const mainBusyByRoot = new Map();
  const activeMainTaskRunIdByRoot = new Map();
  const queueDrainTimers = new Map();

  function queueBucketKey(root, scope, agentId = "") {
    const normRoot = safeCanonicalRoot(root || activeProjectRoot) || String(root || activeProjectRoot || "");
    if (scope === "worker" && agentId) return `${normRoot}::worker::${String(agentId).trim()}`;
    return `${normRoot}::main`;
  }

  function getOrCreateQueueBucket(root, scope, agentId = "") {
    const key = queueBucketKey(root, scope, agentId);
    let bucket = queuedMessageBuckets.get(key);
    if (!bucket) {
      bucket = { paused: false, draining: false, items: [] };
      queuedMessageBuckets.set(key, bucket);
    }
    return bucket;
  }

  function serializeQueueBucket(bucket) {
    if (!bucket) return { items: [], paused: false };
    return {
      paused: Boolean(bucket.paused),
      items: bucket.items.map((item) => ({
        id: item.id,
        text: item.text,
        attachments: Array.isArray(item.attachments) ? item.attachments : [],
        created_at: item.created_at,
      })),
    };
  }

  function buildQueueSnapshotForProject(root = activeProjectRoot) {
    const normRoot = safeCanonicalRoot(root) || String(root || "");
    const mainKey = `${normRoot}::main`;
    const workerPrefix = `${normRoot}::worker::`;
    const workers = {};
    for (const [key, bucket] of queuedMessageBuckets.entries()) {
      if (!key.startsWith(workerPrefix)) continue;
      if (!bucket.items.length && !bucket.paused) continue;
      const agentId = key.slice(workerPrefix.length);
      if (agentId) workers[agentId] = serializeQueueBucket(bucket);
    }
    return {
      project_root: root,
      main: serializeQueueBucket(queuedMessageBuckets.get(mainKey)),
      workers,
    };
  }

  function publishQueueSnapshot(root = activeProjectRoot) {
    if (safeCanonicalRoot(root) !== safeCanonicalRoot(activeProjectRoot)) return;
    publish("queue.snapshot", buildQueueSnapshotForProject(activeProjectRoot));
  }

  function setMainBusyState(root, busy, taskRunId = undefined) {
    const normRoot = safeCanonicalRoot(root || activeProjectRoot) || String(root || activeProjectRoot || "");
    mainBusyByRoot.set(normRoot, Boolean(busy));
    if (taskRunId !== undefined) {
      if (taskRunId) activeMainTaskRunIdByRoot.set(normRoot, String(taskRunId));
      else activeMainTaskRunIdByRoot.delete(normRoot);
    } else if (!busy) {
      activeMainTaskRunIdByRoot.delete(normRoot);
    }
  }

  function isMainBusy(root = activeProjectRoot) {
    const normRoot = safeCanonicalRoot(root) || String(root || "");
    if (mainBusyByRoot.has(normRoot)) return Boolean(mainBusyByRoot.get(normRoot));
    if (safeCanonicalRoot(root) === safeCanonicalRoot(activeProjectRoot) && controller?.session?.pending) {
      return true;
    }
    return false;
  }

  function isWorkerWaitingReply(agentId) {
    const id = String(agentId || "").trim();
    if (!id) return false;
    const meta = controller.session.metaMap.get(id) || {};
    if (String(meta.activity_state || "").toLowerCase() === "waiting_input") return true;
    const standaloneSnap = standaloneSurfaces.get(id)?.surface?.snapshot?.();
    if (standaloneSnap && /^Waiting for reply/i.test(String(standaloneSnap.status || ""))) return true;
    const paneSnap = multiSession?.getPaneSnapshot?.(id);
    if (paneSnap && /^Waiting for reply/i.test(String(paneSnap.status || ""))) return true;
    return false;
  }

  function isWorkerBusy(agentId) {
    const id = String(agentId || "").trim();
    if (!id) return false;
    if (isWorkerWaitingReply(id)) return false;
    const meta = controller.session.metaMap.get(id) || {};
    if (String(meta.activity_state || "").toLowerCase() === "working") return true;
    const standaloneSnap = standaloneSurfaces.get(id)?.surface?.snapshot?.();
    if (standaloneSnap && standaloneSnap.busy) return true;
    const paneSnap = multiSession?.getPaneSnapshot?.(id);
    if (paneSnap && paneSnap.busy) return true;
    return false;
  }

  function enqueueQueuedMessage(root, scope, agentId, text, attachments = []) {
    const bucket = getOrCreateQueueBucket(root, scope, agentId);
    const item = {
      id: `q-${crypto.randomUUID().slice(0, 8)}`,
      text: String(text || ""),
      attachments: normalizeAttachmentList(attachments),
      created_at: new Date().toISOString(),
    };
    bucket.items.push(item);
    publishQueueSnapshot(root);
    return item;
  }

  function clearQueueBucket(root, scope, agentId = "") {
    const key = queueBucketKey(root, scope, agentId);
    const bucket = queuedMessageBuckets.get(key);
    if (!bucket) return 0;
    const count = bucket.items.length;
    bucket.items.length = 0;
    bucket.paused = false;
    queuedMessageBuckets.delete(key);
    publishQueueSnapshot(root);
    return count;
  }

  function pauseQueueIfNonEmpty(root, scope, agentId = "") {
    const key = queueBucketKey(root, scope, agentId);
    const bucket = queuedMessageBuckets.get(key);
    if (!bucket || bucket.items.length === 0) return;
    bucket.paused = true;
    publishQueueSnapshot(root);
  }

  function formatWorkerDisplayEcho(rawMsg, attachments = []) {
    const list = normalizeAttachmentList(attachments);
    if (list.length === 0) return String(rawMsg || "");
    const tags = list.map((att) => `[${att.kind === "image" ? "image" : "file"}: ${att.name}]`).join(" ");
    const trimmed = String(rawMsg || "").trim();
    return trimmed ? `${trimmed}\n${tags}` : tags;
  }

  function dispatchWorkerMessageNow(workerId, text, attachments = []) {
    const id = String(workerId || "").trim();
    const list = normalizeAttachmentList(attachments);
    const effectiveMsg = formatAttachmentPromptSummary(text, list);
    const echoMsg = formatWorkerDisplayEcho(text, list);
    if (isInternalChild(id)) {
      if (standaloneSurfaces.has(id) || (stageTarget.kind === "worker_single" && stageTarget.agentId === id)) {
        const holder = ensureStandaloneSurface(id);
        if (echoMsg) {
          holder.surface.apply("transcript.append", { kind: "user", text: echoMsg, sender_kind: "user" });
        }
        holder.surface.accept({ type: "task_submitted", message: effectiveMsg });
      }
      if (multiSession && multiSession.listInternalAgentIds?.().includes(id)) {
        if (echoMsg) {
          multiSession.acceptEvent(id, { type: "task_started", message: echoMsg, source: "ufoo-desktop-worker" });
        }
        multiSession.acceptEvent(id, { type: "task_submitted", message: effectiveMsg });
        multiSession.publishFrames();
      }
    }
    daemonSend({
      type: IPC_REQUEST_TYPES.BUS_SEND,
      request_id: `worker-send-${crypto.randomUUID()}`,
      target: id,
      message: effectiveMsg,
      ...(list.length > 0 ? { attachments: list } : {}),
      injection_mode: "immediate",
      source: "ufoo-desktop-worker",
    });
    if (stageTarget.kind === "worker_single" && stageTarget.agentId === id) {
      publishStandaloneWorkerFrame(id);
    }
  }

  async function dispatchMainMessageNow(text, attachments = []) {
    const list = normalizeAttachmentList(attachments);
    setMainBusyState(activeProjectRoot, true);
    publish("status.set", { text: "Thinking…", busy: true });
    const beforeSubmit = mainSubmissionRev;
    await controller.submitInput(text, { attachments: list });
    if (beforeSubmit === mainSubmissionRev) {
      setMainBusyState(activeProjectRoot, false);
      publish("status.set", { text: "ready", busy: false });
    }
  }

  function scheduleQueueDrain(key, fn, delayMs = 80) {
    const existing = queueDrainTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      queueDrainTimers.delete(key);
      Promise.resolve(fn()).catch(() => {});
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();
    queueDrainTimers.set(key, timer);
  }

  function drainWorkerQueue(root, agentId) {
    if (safeCanonicalRoot(root) !== safeCanonicalRoot(activeProjectRoot)) return false;
    const key = queueBucketKey(root, "worker", agentId);
    const bucket = queuedMessageBuckets.get(key);
    if (!bucket || bucket.draining || bucket.paused || bucket.items.length === 0) return false;
    if (!isInternalChild(agentId) || isWorkerBusy(agentId) || isWorkerWaitingReply(agentId)) return false;
    bucket.draining = true;
    try {
      const next = bucket.items.shift();
      if (!next) return false;
      if (bucket.items.length === 0) queuedMessageBuckets.delete(key);
      publishQueueSnapshot(root);
      dispatchWorkerMessageNow(agentId, next.text, next.attachments);
      return true;
    } finally {
      bucket.draining = false;
    }
  }

  async function drainMainQueue(root) {
    if (safeCanonicalRoot(root) !== safeCanonicalRoot(activeProjectRoot)) return false;
    const key = queueBucketKey(root, "main");
    const bucket = queuedMessageBuckets.get(key);
    if (!bucket || bucket.draining || bucket.paused || bucket.items.length === 0) return false;
    if (isMainBusy(root) || getActivePendingInteraction() || controller.session.pending?.disambiguate) return false;
    bucket.draining = true;
    try {
      const next = bucket.items.shift();
      if (!next) return false;
      if (bucket.items.length === 0) queuedMessageBuckets.delete(key);
      publishQueueSnapshot(root);
      await dispatchMainMessageNow(next.text, next.attachments);
      return true;
    } finally {
      bucket.draining = false;
    }
  }

  function scheduleDrainWorkerQueue(root, agentId, delayMs = 90) {
    const key = queueBucketKey(root, "worker", agentId);
    const bucket = queuedMessageBuckets.get(key);
    if (!bucket || bucket.paused || bucket.items.length === 0) return;
    scheduleQueueDrain(key, () => drainWorkerQueue(root, agentId), delayMs);
  }

  function scheduleDrainMainQueue(root, delayMs = 90) {
    const key = queueBucketKey(root, "main");
    const bucket = queuedMessageBuckets.get(key);
    if (!bucket || bucket.paused || bucket.items.length === 0) return;
    scheduleQueueDrain(key, () => drainMainQueue(root), delayMs);
  }

  function isDismissedInteraction(id) {
    if (!id) return false;
    const until = dismissedInteractions.get(id);
    if (!until) return false;
    if (Date.now() > until) {
      dismissedInteractions.delete(id);
      return false;
    }
    return true;
  }

  function markInteractionDismissed(id) {
    if (!id) return;
    dismissedInteractions.set(id, Date.now() + DISMISSED_INTERACTION_TTL_MS);
  }

  function getAllPendingInteractions() {
    const size = pendingInteractions.size;
    return [...pendingInteractions.values()].map((item) => ({
      ...item,
      projectRoot: item.projectRoot || activeProjectRoot,
      queue_count: size,
    }));
  }

  function getActivePendingInteraction() {
    const first = pendingInteractions.values().next().value || null;
    if (!first) return null;
    return {
      ...first,
      projectRoot: first.projectRoot || activeProjectRoot,
      queue_count: pendingInteractions.size,
    };
  }

  function syncPublishedInteraction(force = false) {
    const current = getActivePendingInteraction();
    const queue = getAllPendingInteractions();
    const nextKey = current ? `${current.id}:${current.queue_count || 1}` : "";
    if (!force && nextKey === lastPublishedInteractionKey) return;
    lastPublishedInteractionKey = nextKey;
    if (current) {
      publish("interaction.request", { ...current, queue });
    } else {
      publish("interaction.clear", { queue: [] });
    }
  }

  function enqueuePendingInteraction(interaction) {
    const id = String(interaction?.id || "").trim();
    if (!id || isDismissedInteraction(id)) return false;
    const existing = pendingInteractions.get(id) || {};
    pendingInteractions.set(id, { ...existing, ...interaction, id });
    syncPublishedInteraction();
    return true;
  }

  function removePendingInteraction({ id = "", taskRunId = "" } = {}, { markDismissed = false } = {}) {
    let removed = false;
    const targetId = String(id || "").trim();
    const targetTask = String(taskRunId || "").trim();
    if (targetId && pendingInteractions.has(targetId)) {
      pendingInteractions.delete(targetId);
      removed = true;
    }
    if (targetTask) {
      for (const [key, item] of pendingInteractions.entries()) {
        if (item?.taskRunId && item.taskRunId === targetTask) {
          pendingInteractions.delete(key);
          if (markDismissed) markInteractionDismissed(key);
          removed = true;
        }
      }
    }
    if (markDismissed && targetId) markInteractionDismissed(targetId);
    if (removed) syncPublishedInteraction();
    return removed;
  }

  function reconcilePendingInteractions(liveList = []) {
    const now = Date.now();
    for (const [id, until] of dismissedInteractions.entries()) {
      if (now > until) dismissedInteractions.delete(id);
    }
    const liveIds = new Set();
    let changed = false;
    for (const item of liveList) {
      const id = String(item?.id || "").trim();
      if (!id || isDismissedInteraction(id)) continue;
      liveIds.add(id);
      const existing = pendingInteractions.get(id);
      if (!existing || (!existing.taskRunId && item.taskRunId) || (!existing.sessionId && item.sessionId)) {
        pendingInteractions.set(id, { ...(existing || {}), ...item, id });
        changed = true;
      }
    }
    for (const [id] of pendingInteractions.entries()) {
      // Keep local settings picker interactions; prune daemon interactions no longer waiting_user
      if (id.startsWith("settings-")) continue;
      if (!liveIds.has(id)) {
        pendingInteractions.delete(id);
        changed = true;
      }
    }
    if (changed) {
      syncPublishedInteraction();
      publishProjectsTree();
    }
  }

  function clearAllPendingInteractionsLocal() {
    pendingInteractions.clear();
    dismissedInteractions.clear();
    lastPublishedInteractionKey = "";
    if (routerRef && typeof routerRef.resetSessionState === "function") {
      routerRef.resetSessionState();
    }
  }
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
  const deletedSessionGuard = new Map();
  const DELETED_SESSION_GUARD_MS = 10000;

  function isRecentlyDeletedSession(root, id) {
    const key = `${safeCanonicalRoot(root)}\0${id}`;
    const until = deletedSessionGuard.get(key);
    if (!until) return false;
    if (Date.now() > until) {
      deletedSessionGuard.delete(key);
      return false;
    }
    return true;
  }

  const settings = (() => {
    try {
      return loadConfig(activeProjectRoot) || {};
    } catch {
      return {};
    }
  })();

  const recentEvents = [];
  const MAX_RECENT_EVENTS = 250;

  function recordEvent(envelope) {
    if (!envelope || typeof envelope !== "object") return;
    recentEvents.push(envelope);
    if (recentEvents.length > MAX_RECENT_EVENTS) {
      recentEvents.splice(0, recentEvents.length - MAX_RECENT_EVENTS);
    }
  }

  function publish(name, payload) {
    if (!hostRef) return;
    const envelope = hostRef.createEvent(name, payload, {
      surface: "desktop",
      project_id: activeProjectRoot,
      view_id: stageTarget.kind === "worker_single" ? stageTarget.agentId : "main",
    });
    recordEvent(envelope);
    hostRef.broadcast(envelope);
    remoteBridge?.broadcast(envelope);
  }

  function publishLossy(name, payload) {
    if (!hostRef) return;
    const envelope = hostRef.createLossyEvent(name, payload, {
      surface: "desktop",
      project_id: activeProjectRoot,
      view_id: stageTarget.kind === "worker_single" ? stageTarget.agentId : "main",
    });
    hostRef.broadcast(envelope);
    remoteBridge?.broadcast(envelope);
  }

  function historyOptions() {
    const { chatHistoryOptionsForScope } = require("../app/chat/historyStore");
    return chatHistoryOptionsForScope({
      globalMode: true,
      globalScope,
    });
  }

  function appendLocal(kind, text, speakerOrMeta = "") {
    const raw = String(text == null ? "" : text);
    const meta = speakerOrMeta && typeof speakerOrMeta === "object"
      ? { ...speakerOrMeta }
      : { speaker: String(speakerOrMeta || "") };
    const speaker = String(meta.speaker || "");
    const { appendChatHistory, shouldSkipChatHistoryEntry } = require("../app/chat/historyStore");
    if (shouldSkipChatHistoryEntry(kind, raw, meta)) {
      const statusSummary = stripTags(raw).replace(/^ufoo(?:-agent)?\s*·\s*/i, "").trim();
      if (statusSummary) publish("status.set", { text: statusSummary, busy: false });
      return null;
    }
    const speakerIndex = buildProjectSpeakerIndex(activeProjectRoot, controller.session.metaMap);
    const entry = {
      ...rawHistoryToEntries([{ kind, text: raw, speaker, meta, ts: new Date().toISOString() }], speakerIndex)[0],
      id: `live-${++entrySeq}`,
    };
    publish("transcript.append", entry);
    try {
      appendChatHistory(activeProjectRoot, kind, raw, meta, historyOptions());
    } catch {
      // best-effort persistence
    }
    return entry;
  }

  function isInternalChild(agentId) {
    const id = String(agentId || "");
    if (!id || id === "ufoo-agent" || id.endsWith(":ufoo-agent")) return false;
    const meta = controller.session.metaMap.get(id) || readDiskAgentMeta(activeProjectRoot, id);
    return isInternalAgentMeta(meta);
  }

  function findSessionCustomLabel(root, id, prefs = sessionPrefs.read()) {
    const cleanRoot = safeCanonicalRoot(root);
    const hit = (prefs.labels || []).find((item) => safeCanonicalRoot(item.root) === cleanRoot && item.id === id);
    return hit ? String(hit.label || "").trim() : "";
  }

  function readDiskAgentMeta(root, id) {
    try {
      const { agentsFile } = getUfooPaths(root);
      if (!fs.existsSync(agentsFile)) return null;
      const data = loadAgentsData(agentsFile);
      return (data && data.agents && data.agents[id]) || null;
    } catch {
      return null;
    }
  }

  function resolveAgentMeta(root, id) {
    const liveMeta = root === activeProjectRoot ? controller.session.metaMap.get(id) : null;
    const diskMeta = readDiskAgentMeta(root, id);
    if (!liveMeta && !diskMeta) return null;
    if (!liveMeta) return diskMeta;
    if (!diskMeta) return liveMeta;
    const merged = { ...diskMeta, ...liveMeta };
    for (const key of [
      "agent_type",
      "model",
      "thinking_level",
      "permission_mode",
      "worktree_root",
      "worktree_branch",
      "group_id",
      "group_member_id",
      "group_template_alias",
      "provider_session_id",
    ]) {
      if (!merged[key] && diskMeta[key]) merged[key] = diskMeta[key];
    }
    return merged;
  }

  async function stopInternalWorkerForSession(root, id, metaHint = null) {
    const meta = metaHint || (root === activeProjectRoot ? controller.session.metaMap.get(id) : null) || readDiskAgentMeta(root, id);
    if (!meta || !isInternalAgentMeta(meta)) return false;
    const diskMeta = readDiskAgentMeta(root, id);
    const pid = Number.parseInt(diskMeta?.pid ?? meta.pid, 10);
    const activeOnDisk = diskMeta ? diskMeta.status === "active" : meta.status !== "inactive";
    let stopped = false;

    if (root === activeProjectRoot) {
      daemonSend({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: id });
      stopped = true;
    }

    // For dormant projects or direct process cleanup (never kill our own host/test process)
    if (diskMeta && (activeOnDisk || (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAgentPidAlive(pid)))) {
      if (!Number.isInteger(pid) || pid !== process.pid) {
        try {
          await closeAgent(root, id);
          stopped = true;
        } catch {
          // ignore closeAgent errors; fallback handled by daemon/cleanup
        }
      }
    }
    return stopped;
  }

  function isWorktreeClean(worktreePath) {
    try {
      const out = execFileSync("git", ["-C", worktreePath, "status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
      });
      return String(out || "").trim().length === 0;
    } catch {
      return false;
    }
  }

  function findAgentsUsingWorktree(root, worktreePath, { excludeAgentId = "", activeOnly = false } = {}) {
    const targetWt = safeCanonicalRoot(worktreePath);
    const projectNorm = safeCanonicalRoot(root);
    if (!targetWt || targetWt === projectNorm) return [];
    const excluded = String(excludeAgentId || "").trim();
    const users = new Map();

    const consider = (id, meta, forceActive = false) => {
      const agentId = String(id || "").trim();
      if (!agentId || agentId === excluded || agentId === "ufoo-agent" || agentId.endsWith(":ufoo-agent")) return;
      if (!meta || typeof meta !== "object") return;
      const wt = meta.worktree_root ? safeCanonicalRoot(meta.worktree_root) : "";
      if (!wt || wt !== targetWt) return;
      if (activeOnly && !forceActive) {
        if (meta.status !== "active") return;
        const pid = Number.parseInt(meta.pid, 10);
        if (Number.isInteger(pid) && pid > 0 && !isAgentPidAlive(pid)) return;
      }
      users.set(agentId, String(meta.display_nickname || meta.nickname || agentId));
    };

    if (projectNorm === activeProjectRoot) {
      for (const [id, meta] of controller.session.metaMap.entries()) {
        consider(id, meta, true);
      }
    }
    try {
      const { agentsFile, groupsDir } = getUfooPaths(root);
      if (fs.existsSync(agentsFile)) {
        const data = loadAgentsData(agentsFile);
        for (const [id, meta] of Object.entries(data?.agents || {})) {
          consider(id, meta, false);
        }
      }
      if (fs.existsSync(groupsDir)) {
        for (const file of fs.readdirSync(groupsDir)) {
          if (!file.endsWith(".json")) continue;
          const group = JSON.parse(fs.readFileSync(path.join(groupsDir, file), "utf8"));
          const groupWt = group?.worktree_root ? safeCanonicalRoot(group.worktree_root) : "";
          if (!groupWt || groupWt !== targetWt) continue;
          if (activeOnly && !["active", "partial"].includes(String(group.status || ""))) continue;
          for (const member of Array.isArray(group.members) ? group.members : []) {
            const mid = String(member?.subscriber_id || "").trim();
            if (!mid || mid === excluded) continue;
            if (activeOnly && member.status !== "active" && member.status !== "reused") continue;
            if (!users.has(mid)) {
              users.set(mid, String(member.nickname || member.member_id || mid));
            }
          }
        }
      }
    } catch {
      // ignore registry/group read errors
    }
    return [...users.values()];
  }

  function cleanupSessionPerAgentFiles(root, id) {
    try {
      const paths = getUfooPaths(root);
      const safeId = String(id || "").replace(/[^a-zA-Z0-9._-]/g, "_");
      const candidates = [
        path.join(paths.busQueuesDir, `${id}.jsonl`),
        path.join(paths.busQueuesDir, `${safeId}.jsonl`),
        path.join(paths.busOffsetsDir, `${id}.offset`),
        path.join(paths.busOffsetsDir, `${safeId}.offset`),
        path.join(paths.runDir, `task-control-${safeId}.sock`),
      ];
      for (const filePath of candidates) {
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
          // ignore individual cleanup errors
        }
      }
    } catch {
      // ignore path resolution errors
    }
  }

  function readGroupMemberInfo(root, id) {
    const targetId = String(id || "").trim();
    if (!root || !targetId) return null;
    try {
      const { groupsDir } = getUfooPaths(root);
      if (!fs.existsSync(groupsDir)) return null;
      const groupFiles = fs.readdirSync(groupsDir)
        .filter((file) => file.endsWith(".json"))
        .map((file) => {
          const fullPath = path.join(groupsDir, file);
          let mtimeMs = 0;
          try { mtimeMs = fs.statSync(fullPath).mtimeMs || 0; } catch {}
          return { fullPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { fullPath } of groupFiles) {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        } catch {
          continue;
        }
        const members = Array.isArray(parsed?.members) ? parsed.members : [];
        for (const member of members) {
          if (!member || typeof member !== "object") continue;
          const ids = [
            member.subscriber_id,
            member.previous_subscriber_id,
            member.bootstrapped_subscriber_id,
            ...(Array.isArray(member.launch?.subscriber_ids) ? member.launch.subscriber_ids : []),
            ...(Array.isArray(member.previous_subscriber_ids) ? member.previous_subscriber_ids : []),
          ].map((v) => String(v || "").trim()).filter(Boolean);
          if (!ids.includes(targetId)) continue;
          const label = String(
            member.nickname
            || member.template_agent_id
            || member.member_id
            || member.scoped_nickname
            || ""
          ).trim();
          const type = String(
            member.type
            || member.agent
            || (targetId.includes(":") ? targetId.split(":")[0] : "")
            || "worker"
          ).trim();
          return { label, type };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function getAgentLabel(agentId) {
    const custom = findSessionCustomLabel(activeProjectRoot, agentId);
    if (custom) return custom;
    const meta = controller.session.metaMap.get(agentId) || readDiskAgentMeta(activeProjectRoot, agentId) || {};
    const direct = String(meta.display_nickname || meta.nickname || "").trim();
    if (direct) return direct;
    const groupMember = readGroupMemberInfo(activeProjectRoot, agentId);
    if (groupMember?.label) return groupMember.label;
    return String(agentId);
  }

  function resolveSenderInfo(senderId, senderKind = "") {
    const id = String(senderId || "").trim();
    if (!id) return null;
    if (senderKind === "coordinator" || id === "ufoo-agent" || id.endsWith(":ufoo-agent")) {
      return {
        sender_id: "ufoo-agent",
        sender_kind: "coordinator",
        sender_label: "ufoo",
        sender_type: "ufoo",
      };
    }
    const liveMeta = controller.session.metaMap.get(id) || null;
    const diskMeta = liveMeta ? null : readDiskAgentMeta(activeProjectRoot, id);
    const meta = liveMeta || diskMeta || {};
    const groupMember = (!meta.display_nickname && !meta.nickname)
      ? readGroupMemberInfo(activeProjectRoot, id)
      : null;
    const custom = findSessionCustomLabel(activeProjectRoot, id);
    const label = custom
      || String(meta.display_nickname || meta.nickname || groupMember?.label || id);
    const type = String(
      meta.agent_type
      || meta.type
      || groupMember?.type
      || (id.includes(":") ? id.split(":")[0] : "")
      || "worker"
    );
    return {
      sender_id: id,
      sender_kind: senderKind || "peer",
      sender_label: label,
      sender_type: type,
    };
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
    const cfg = (() => {
      try { return loadConfig(activeProjectRoot) || {}; } catch { return {}; }
    })();
    for (const id of controller.session.agents) {
      if (id === "ufoo-agent" || id.endsWith(":ufoo-agent")) continue;
      const meta = resolveAgentMeta(activeProjectRoot, id) || {};
      const internal = isInternalAgentMeta(meta);
      const workerType = String(meta.agent_type || meta.type || id.split(":")[0] || "worker");
      list.push({
        id,
        label: getAgentLabel(id),
        type: workerType,
        internal,
        external: !internal,
        activity_state: String(meta.activity_state || "idle"),
        activity_detail: sanitizeUiActivityDetail(meta.activity_detail),
        group_id: String(meta.group_id || ""),
        group_member_id: String(meta.group_member_id || ""),
        group_template_alias: String(meta.group_template_alias || ""),
        host_name: String(meta.host_name || ""),
        launch_mode: String(meta.launch_mode || ""),
        worktree_root: String(meta.worktree_root || ""),
        worktree_branch: String(meta.worktree_branch || ""),
        model: resolveWorkerDisplayModel(meta, workerType, cfg),
        thinking_level: String(meta.thinking_level || cfg.agentThinking || "medium"),
        permission_mode: String(meta.permission_mode || cfg.permissionMode || "auto_edit"),
      });
    }
    return list;
  }

  function safeCanonicalRoot(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    try {
      return canonicalProjectRoot(text);
    } catch {
      return path.resolve(text);
    }
  }

  function listUnarchivedProjects(archive = desktopArchive.read()) {
    const archivedRoots = new Set((archive.projects || []).map(({ root }) => safeCanonicalRoot(root)).filter(Boolean));
    return loadGlobalProjectRows(activeProjectRoot).filter(({ root }) => !archivedRoots.has(safeCanonicalRoot(root)));
  }

  let lastProjectsTreeSignature = "";
  let lastWorkflowSignature = "";

  function publishWorkflowSnapshot(force = false) {
    if (globalScope !== "project") {
      if (force || lastWorkflowSignature !== "empty") {
        lastWorkflowSignature = "empty";
        publish("workflow.snapshot", { project_root: "", groups: [], edges: [], positions: {} });
      }
      return null;
    }
    const snap = getWorkflowSnapshot(activeProjectRoot);
    const sig = JSON.stringify({
      root: snap.project_root,
      groups: snap.groups,
      edges: snap.edges,
    });
    if (!force && sig === lastWorkflowSignature) return snap;
    lastWorkflowSignature = sig;
    publish("workflow.snapshot", snap);
    return snap;
  }
  const branchCache = new Map();
  const BRANCH_CACHE_TTL_MS = 10000;

  function detectGitBranchCached(root) {
    const now = Date.now();
    const hit = branchCache.get(root);
    if (hit && now - hit.ts < BRANCH_CACHE_TTL_MS) return hit.branch;
    const branch = detectGitBranch(root);
    branchCache.set(root, { branch, ts: now });
    return branch;
  }

  function buildProjectsTreePayload() {
    const archive = desktopArchive.read();
    const prefs = sessionPrefs.read();
    const archivedRoots = new Set((archive.projects || []).map(({ root }) => safeCanonicalRoot(root)).filter(Boolean));
    const byRoot = new Map();
    for (const row of listUnarchivedProjects(archive)) {
      const root = safeCanonicalRoot(row.root);
      if (!root || archivedRoots.has(root) || byRoot.has(root)) continue;
      byRoot.set(root, { ...row, root });
    }
    if (activeProjectRoot && activeProjectRoot !== controllerRoot
      && !archivedRoots.has(activeProjectRoot) && !byRoot.has(activeProjectRoot)) {
      byRoot.set(activeProjectRoot, {
        id: buildProjectId(activeProjectRoot),
        label: path.basename(activeProjectRoot) || activeProjectRoot,
        root: activeProjectRoot,
        status: "running",
        active: true,
      });
    }

    const rawProjects = Array.from(byRoot.values()).sort(
      (a, b) => String(a.label || "").localeCompare(String(b.label || ""), "en", { sensitivity: "base" })
        || a.root.localeCompare(b.root)
    );

    const projects = rawProjects.map((row) => {
      const isCurrent = row.root === activeProjectRoot && globalScope === "project";
      const dormant = inspectDormantProjectSummary(row.root);
      const hasLiveStatus = isCurrent && activeStatusSyncedRoot === row.root;
      const rawWorkers = hasLiveStatus
        ? buildActiveProjectWorkerRows()
        : (isCurrent && controller.session.agents.length > 0
          ? buildActiveProjectWorkerRows()
          : dormant.workers);
      const archivedEntries = (archive.sessions || []).filter(({ root }) => safeCanonicalRoot(root) === row.root);
      const archivedIds = new Set(archivedEntries.map(({ id }) => id));

      const labelsMap = new Map();
      for (const item of prefs.labels || []) {
        if (safeCanonicalRoot(item.root) === row.root && item.id && item.label) {
          labelsMap.set(item.id, item.label);
        }
      }
      const pinnedMap = new Map();
      for (const item of prefs.pinned || []) {
        if (safeCanonicalRoot(item.root) === row.root && item.id) {
          pinnedMap.set(item.id, item.pinnedAt || "");
        }
      }
      const archivedMetaMap = new Map();
      for (const item of prefs.archivedMeta || []) {
        if (safeCanonicalRoot(item.root) === row.root && item.id) {
          archivedMetaMap.set(item.id, item);
        }
      }

      const workers = rawWorkers
        .filter(({ id }) => !archivedIds.has(id) && !isRecentlyDeletedSession(row.root, id))
        .map((w, idx) => ({
          ...w,
          label: labelsMap.get(w.id) || w.label,
          pinned: pinnedMap.has(w.id),
          pinned_at: pinnedMap.get(w.id) || "",
          _idx: idx,
        }))
        .sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          if (a.pinned && b.pinned) {
            const cmp = String(a.pinned_at || "").localeCompare(String(b.pinned_at || ""));
            if (cmp !== 0) return cmp;
          }
          return a._idx - b._idx;
        })
        .map(({ _idx, ...rest }) => rest);

      const rawRecoverable = recoverableCache.get(row.root) || [];
      const recoverableById = new Map(rawRecoverable.map((r) => [r.id, r]));
      const recoverable = rawRecoverable
        .filter(({ id }) => !archivedIds.has(id) && !isRecentlyDeletedSession(row.root, id))
        .map((item) => ({
          ...item,
          label: labelsMap.get(item.id) || item.label || item.id,
          type: String(
            item.type
              || item.agent
              || (!String(item.id || "").startsWith("group:") && String(item.id || "").includes(":")
                ? String(item.id).split(":")[0]
                : "")
          ),
        }));

      const diskAgents = (() => {
        try {
          const { agentsFile } = getUfooPaths(row.root);
          return fs.existsSync(agentsFile) ? (loadAgentsData(agentsFile)?.agents || {}) : {};
        } catch {
          return {};
        }
      })();
      const liveWorkerById = new Map(rawWorkers.map((w) => [w.id, w]));

      const archived = archivedEntries
        .map(({ id }) => {
          const stored = archivedMetaMap.get(id);
          const diskMeta = diskAgents[id] || null;
          const live = liveWorkerById.get(id) || null;
          const rec = recoverableById.get(id) || null;
          const label = labelsMap.get(id)
            || live?.label
            || String(diskMeta?.display_nickname || diskMeta?.nickname || "")
            || stored?.label
            || rec?.label
            || id;
          const type = live?.type
            || String(diskMeta?.agent_type || diskMeta?.type || "")
            || stored?.type
            || id.split(":")[0]
            || "worker";
          const worktreeBranch = live?.worktree_branch
            || String(diskMeta?.worktree_branch || "")
            || stored?.worktreeBranch
            || "";
          const isRecoverable = Boolean(rec || diskMeta?.provider_session_id);
          return {
            id,
            label,
            type,
            archived_at: stored?.archivedAt || "",
            worktree_branch: worktreeBranch,
            recoverable: isRecoverable,
            active: Boolean(live),
            internal: stored !== undefined ? Boolean(stored.internal) : Boolean(live ? live.internal : isInternalAgentMeta(diskMeta)),
          };
        })
        .filter((item) => item.recoverable)
        .sort((a, b) => String(b.archived_at || "").localeCompare(String(a.archived_at || "")));

      return {
        id: row.id || buildProjectId(row.root),
        label: row.label || path.basename(row.root),
        root: row.root,
        branch: detectGitBranchCached(row.root),
        status: row.status || "running",
        active: isCurrent,
        selectedAsMain: isCurrent && stageTarget.kind === "project_main",
        selectedWorkerId: isCurrent && stageTarget.kind === "worker_single" ? stageTarget.agentId : "",
        mainBusy: isCurrent ? Boolean(controller.session.pending) || dormant.mainBusy : dormant.mainBusy,
        waitingUser: isCurrent ? Boolean(getActivePendingInteraction()) : dormant.waitingUser,
        conversationId: dormant.conversationId,
        workers,
        recoverable,
        archived,
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

  function publishProjectsTree(options = {}) {
    const tree = buildProjectsTreePayload();
    const signature = JSON.stringify(tree);
    if (!options.force && signature === lastProjectsTreeSignature) {
      return tree;
    }
    lastProjectsTreeSignature = signature;
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
      const surface = createAgentSurface({ rawMarkdown: true });
      const meta = resolveAgentMeta(activeProjectRoot, agentId) || null;
      const lineageIds = resolveAgentLineageIds(activeProjectRoot, agentId, meta);
      const initial = loadInternalAgentTranscript(activeProjectRoot, agentId, {
        maxEvents: 300,
        maxEntries: 300,
        lineageIds,
      });
      if (initial.length) {
        surface.apply("transcript.reset", { entries: initial });
      }
      const events = readAgentSurfaceEvents(
        activeProjectRoot,
        lineageIds.length ? lineageIds : [agentId],
        6 * 1024 * 1024,
      );
      let maxSeq = 0;
      if (events.length) {
        surface.apply("transcript.reset", { entries: [] });
        for (const evt of events) {
          const seq = Number(evt.seq) || 0;
          if (seq > 0 && seq <= maxSeq) continue;
          if (seq > 0) maxSeq = seq;
          surface.accept(evt.data.surface);
        }
      }
      standaloneSurfaces.set(agentId, { surface, seq: maxSeq });
    }
    return standaloneSurfaces.get(agentId);
  }

  function acceptStandaloneSurfaceEvent(agentId, surfaceEvent, seq = 0) {
    const holder = ensureStandaloneSurface(agentId);
    const numSeq = Number(seq) || 0;
    if (numSeq > 0 && numSeq <= holder.seq) return false;
    if (numSeq > 0) holder.seq = numSeq;
    const changed = holder.surface.accept(surfaceEvent || {});
    if (surfaceEvent && surfaceEvent.type === "task_completed") {
      scheduleDrainWorkerQueue(activeProjectRoot, agentId);
    }
    return changed;
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
    let dirty = false;
    for (const evt of standaloneReader.read([agentId])) {
      if (acceptStandaloneSurfaceEvent(agentId, evt.data?.surface, evt.seq)) {
        dirty = true;
      }
    }
    if (dirty) publishStandaloneWorkerFrame(agentId);
  }

  const worktreeChangesCache = new Map();
  const WORKTREE_CHANGES_TTL_MS = 2500;

  function normalizeSessionChangedFiles(rawList = [], worktreeRoot = "") {
    const projectNorm = safeCanonicalRoot(activeProjectRoot);
    const wtNorm = worktreeRoot ? safeCanonicalRoot(worktreeRoot) : projectNorm;
    const byKey = new Map();

    const addItem = (rawPath, kind = "modified", additions, deletions) => {
      const text = String(rawPath || "").trim();
      if (!text) return;
      let displayPath = text;
      let openPath = text;
      if (path.isAbsolute(text)) {
        const absDir = safeCanonicalRoot(path.dirname(text));
        const absFull = path.join(absDir, path.basename(text));
        if (wtNorm && (absFull === wtNorm || absFull.startsWith(`${wtNorm}${path.sep}`))) {
          displayPath = path.relative(wtNorm, absFull).split(path.sep).join("/");
          openPath = absFull;
        } else if (projectNorm && (absFull === projectNorm || absFull.startsWith(`${projectNorm}${path.sep}`))) {
          displayPath = path.relative(projectNorm, absFull).split(path.sep).join("/");
          openPath = absFull;
        }
      } else {
        displayPath = text.replace(/^\.\//, "");
        openPath = displayPath;
      }
      const prev = byKey.get(displayPath);
      byKey.set(displayPath, {
        path: displayPath,
        open_path: prev?.open_path || openPath,
        kind: prev?.kind === "added" && kind === "modified" ? "added" : (kind || prev?.kind || "modified"),
        ...(Number.isFinite(additions) ? { additions } : prev?.additions !== undefined ? { additions: prev.additions } : {}),
        ...(Number.isFinite(deletions) ? { deletions } : prev?.deletions !== undefined ? { deletions: prev.deletions } : {}),
      });
    };

    for (const item of rawList || []) {
      addItem(item.path, item.kind);
    }

    // If the worker owns a dedicated worktree, merge live git status & line stats (cached 2.5s)
    if (wtNorm && projectNorm && wtNorm !== projectNorm && fs.existsSync(wtNorm)) {
      const now = Date.now();
      let cached = worktreeChangesCache.get(wtNorm);
      if (!cached || now - cached.ts > WORKTREE_CHANGES_TTL_MS) {
        try {
          const snap = loadWorkspaceChanges(activeProjectRoot, { worktreeRoot: wtNorm });
          cached = { ts: now, files: Array.isArray(snap?.files) ? snap.files : [] };
        } catch {
          cached = { ts: now, files: [] };
        }
        worktreeChangesCache.set(wtNorm, cached);
      }
      for (const f of cached.files) {
        const k = f.kind === "untracked" ? "added" : f.kind;
        addItem(f.path, k, f.additions, f.deletions);
      }
    }

    return [...byKey.values()];
  }

  function buildStandaloneWorkerFrame(agentId) {
    const id = String(agentId || "").trim();
    const meta = resolveAgentMeta(activeProjectRoot, id) || {};
    const internal = isInternalAgentMeta(meta);
    const draft = standaloneDrafts.get(id) || { text: "", revision: 0 };
    const cfg = (() => {
      try { return loadConfig(activeProjectRoot) || {}; } catch { return {}; }
    })();
    const workerType = String(meta.agent_type || meta.type || id.split(":")[0] || (internal ? "worker" : "external"));

    if (internal) {
      const holder = ensureStandaloneSurface(id);
      const snap = holder.surface.snapshot();
      const wtRoot = String(meta.worktree_root || meta.cwd || activeProjectRoot);
      const sessionChanged = normalizeSessionChangedFiles(snap.changed_files || [], wtRoot);
      const statsByOpenPath = new Map();
      const statsByDisplayPath = new Map();
      for (const cf of sessionChanged) {
        statsByDisplayPath.set(cf.path, cf);
        if (cf.open_path) statsByOpenPath.set(cf.open_path, cf);
      }
      return {
        project_root: activeProjectRoot,
        agent_id: id,
        label: getAgentLabel(id),
        type: workerType,
        internal: true,
        external: false,
        entries: snap.entries.map((e) => {
          const senderInfo = e.sender_id ? resolveSenderInfo(e.sender_id, e.sender_kind) : null;
          return {
            ...e,
            ...(senderInfo || {}),
            text: stripTags(e.text || ""),
            detail: stripTags(e.detail || ""),
            ...(Array.isArray(e.changed_files) && e.changed_files.length > 0
              ? {
                changed_files: e.changed_files.map((item) => {
                  const normalized = normalizeSessionChangedFiles([item], "")[0] || item;
                  const enriched = statsByOpenPath.get(normalized.open_path)
                    || statsByDisplayPath.get(normalized.path);
                  return enriched ? { ...normalized, ...enriched } : normalized;
                }),
              }
              : {}),
          };
        }),
        status: snap.status || String(meta.activity_state || "ready"),
        busy: snap.pending_interaction ? false : Boolean(snap.busy || meta.activity_state === "working"),
        usage: snap.usage || "",
        plan: snap.plan || [],
        plan_items: snap.plan_items || [],
        pending_interaction: snap.pending_interaction || null,
        changed_files: sessionChanged,
        activity_detail: sanitizeUiActivityDetail(meta.activity_detail),
        group_id: String(meta.group_id || ""),
        group_template_alias: String(meta.group_template_alias || ""),
        worktree_root: wtRoot,
        model: resolveWorkerDisplayModel(meta, workerType, cfg),
        thinking_level: String(meta.thinking_level || cfg.agentThinking || "medium"),
        permission_mode: String(meta.permission_mode || cfg.permissionMode || "auto_edit"),
        input: draft.text,
        input_revision: draft.revision,
      };
    }

    const externalLineage = resolveAgentLineageIds(activeProjectRoot, id, meta);
    const entries = loadInternalAgentTranscript(activeProjectRoot, id, {
      maxEvents: 400,
      maxEntries: 300,
      lineageIds: externalLineage,
    }).map((e) => {
      const senderInfo = e.sender_id ? resolveSenderInfo(e.sender_id, e.sender_kind) : null;
      return senderInfo ? { ...e, ...senderInfo } : e;
    });
    const reports = listReports(activeProjectRoot, { agent: id, num: 25 });
    return {
      project_root: activeProjectRoot,
      agent_id: id,
      label: getAgentLabel(id),
      type: workerType,
      internal: false,
      external: true,
      entries,
      reports,
      status: String(meta.activity_state || "online"),
      busy: meta.activity_state === "working",
      usage: "",
      plan: [],
      plan_items: [],
      pending_interaction: null,
      activity_detail: sanitizeUiActivityDetail(meta.activity_detail),
      host_name: String(meta.host_name || meta.launch_mode || "terminal"),
      launch_mode: String(meta.launch_mode || "external"),
      worktree_root: String(meta.cwd || activeProjectRoot),
      model: resolveWorkerDisplayModel(meta, workerType, cfg),
      thinking_level: String(meta.thinking_level || cfg.agentThinking || "medium"),
      permission_mode: String(meta.permission_mode || cfg.permissionMode || "auto_edit"),
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

  function seedSessionAgentsFromDisk(root) {
    controller.session.agents = [];
    controller.session.metaMap.clear();
    controller.session.labelMap.clear();
    try {
      const { agentsFile } = getUfooPaths(root);
      if (!fs.existsSync(agentsFile)) return;
      const data = loadAgentsData(agentsFile) || {};
      const nextAgents = [];
      for (const [id, meta] of Object.entries(data.agents || {})) {
        if (!meta || meta.status !== "active") continue;
        if (id === "ufoo-agent" || id.endsWith(":ufoo-agent") || meta.agent_type === "ufoo-agent") continue;
        if (isRecentlyDeletedSession(root, id)) continue;
        const pid = Number.parseInt(meta.pid, 10);
        const alive = meta.mcp_bridge === true || !pid || isAgentPidAlive(pid);
        if (!alive) continue;
        nextAgents.push(id);
        controller.session.metaMap.set(id, { id, ...meta });
        const label = String(meta.display_nickname || meta.nickname || id);
        controller.session.labelMap.set(id, label);
      }
      controller.session.agents = nextAgents;
    } catch {
      // ignore disk seed errors; live STATUS will reconcile
    }
  }

  async function switchToProjectRoot(targetRoot, switchOpts = {}) {
    const root = canonicalProjectRoot(String(targetRoot || "").trim());
    const archived = desktopArchive.read().projects.some((item) => item.root === root);
    if (archived && !switchOpts.restoreArchived) {
      return { ok: false, error: "This folder is archived. Add it again to restore it." };
    }
    const switchSeq = ++projectSwitchSeq;
    pendingSwitchRoot = root;
    pendingSwitchStatus = null;

    if (!fs.existsSync(getUfooPaths(root).ufooDir)) {
      const repoRoot = path.join(__dirname, "..", "..");
      const init = new env.UfooInit(repoRoot);
      await init.init({ targets: "context,bus", project: root });
      if (switchSeq !== projectSwitchSeq) {
        return { ok: true, superseded: true, project_root: activeProjectRoot };
      }
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
    clearAllPendingInteractionsLocal();

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
      if (switchSeq !== projectSwitchSeq) {
        return { ok: true, superseded: true, project_root: activeProjectRoot };
      }
      if (!res || res.ok !== true) {
        pendingSwitchRoot = "";
        pendingSwitchStatus = null;
        return res || { ok: false, error: "switch failed" };
      }
    }

    if (archived) desktopArchive.restoreProject(root);
    const bufferedStatus = pendingSwitchStatus && pendingSwitchStatus.root === safeCanonicalRoot(root)
      ? pendingSwitchStatus.data
      : null;
    pendingSwitchRoot = "";
    pendingSwitchStatus = null;

    activeProjectRoot = root;
    globalScope = root === controllerRoot ? "controller" : "project";
    activeStatusSyncedRoot = "";
    const rawSwitchAgentId = String(switchOpts.agentId || "").trim();
    const normalizedSwitchAgentId = rawSwitchAgentId && rawSwitchAgentId !== "main" ? rawSwitchAgentId : "";
    stageTarget = normalizedSwitchAgentId
      ? { kind: "worker_single", agentId: normalizedSwitchAgentId }
      : { kind: "project_main", agentId: "" };

    Object.assign(settings, loadConfig(activeProjectRoot) || {});
    controller.session.targetAgent = null;
    controller.session.footer = "";

    if (bufferedStatus) {
      activeStatusSyncedRoot = safeCanonicalRoot(root);
      controller.applyStatus(bufferedStatus);
    } else {
      // Seed immediately from disk so live workers (e.g. ucode-3) never flicker
      // away while waiting for the first daemon STATUS round-trip.
      seedSessionAgentsFromDisk(root);
      try {
        daemonSend({ type: IPC_REQUEST_TYPES.STATUS });
      } catch {
        controller.requestDaemonStatus();
      }
    }

    publish("app.snapshot", buildSnapshot());
    publishProjectsTree();
    publishWorkflowSnapshot(true);
    publishRightInspectorAll();

    // Refresh recoverable sessions asynchronously so a slow daemon never stalls
    // project switching or blanks out active workers.
    void refreshRecoverableForActiveProject().then(() => {
      if (switchSeq === projectSwitchSeq && safeCanonicalRoot(activeProjectRoot) === safeCanonicalRoot(root)) {
        publishProjectsTree();
      }
    });

    if (switchOpts.windowMode && ["main", "side", "multi"].includes(switchOpts.windowMode) && stageTarget.kind === "project_main") {
      changeWindowLayout(switchOpts.windowMode);
    } else if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
      publishStandaloneWorkerFrame(stageTarget.agentId);
    }
    return { ok: true, project_root: root };
  }

  async function switchToControllerRoot() {
    const switchSeq = ++projectSwitchSeq;
    pendingSwitchRoot = controllerRoot;
    pendingSwitchStatus = null;
    if (multiSession) multiSession.stop({ clearDrafts: false });
    clearAllPendingInteractionsLocal();
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
      if (switchSeq !== projectSwitchSeq) {
        return { ok: true, superseded: true, project_root: activeProjectRoot };
      }
      if (!res || res.ok !== true) {
        pendingSwitchRoot = "";
        pendingSwitchStatus = null;
        return res || { ok: false, error: "switch to controller failed" };
      }
    }
    pendingSwitchRoot = "";
    pendingSwitchStatus = null;
    activeProjectRoot = controllerRoot;
    activeStatusSyncedRoot = "";
    globalScope = "controller";
    controller.session.targetAgent = null;
    controller.session.agents = [];
    controller.session.metaMap.clear();
    controller.session.labelMap.clear();
    publish("app.snapshot", buildSnapshot());
    publishProjectsTree();
    publishWorkflowSnapshot(true);
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
        const rawText = String(text == null ? "" : text);
        const directMatch = normalized === "user"
          ? rawText.match(/^›\s+\{magenta-fg\}@([^\s{]+)\{\/magenta-fg\}\s+([\s\S]+)$/)
          : null;
        if (directMatch) {
          const targetToken = directMatch[1].trim();
          const targetId = controller.resolveAgentId(targetToken) || "";
          const targetMeta = targetId ? resolveAgentMeta(activeProjectRoot, targetId) : null;
          const targetLabel = targetId ? getAgentLabel(targetId) : targetToken;
          const targetType = String(
            targetMeta?.agent_type
            || targetMeta?.type
            || (targetId.includes(":") ? targetId.split(":")[0] : "")
            || ""
          ).trim();
          appendLocal("user", stripTags(rawText), {
            target_id: targetId || targetToken,
            target_label: targetLabel,
            ...(targetType ? { target_type: targetType } : {}),
          });
          return;
        }
        appendLocal(normalized, stripTags(rawText));
      },
      setStatus: (text, opts = {}) => publish("status.set", {
        text: stripTags(text || "ready"),
        ...(typeof opts?.busy === "boolean" ? { busy: opts.busy } : {}),
      }),
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
          setMainBusyState(activeProjectRoot, true);
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
          setMainBusyState(activeProjectRoot, false);
          publish("status.set", { text: "ready", busy: false });
          scheduleDrainMainQueue(activeProjectRoot);
          if (globalScope === "project") {
            try {
              publish("workspace.context.snapshot", handleWorkspaceContext(activeProjectRoot, { operation: "snapshot" }));
            } catch {
              // ignore background refresh error
            }
          }
          return;
        }
        if (action.type === "log/clear") {
          clearChatHistory(activeProjectRoot, historyOptions());
          publish("transcript.reset", { entries: [] });
        }
      },
    },
  });

  multiSession = createRustMultiSession({
    getProjectRoot: () => activeProjectRoot,
    projectRoot: controllerRoot,
    getActiveAgents: () => [...controller.session.metaMap.keys()],
    getAgentMeta: (id) => controller.session.metaMap.get(id) || {},
    resolvePaneOptions: (agentId) => {
      const meta = resolveAgentMeta(activeProjectRoot, agentId) || null;
      const lineageIds = resolveAgentLineageIds(activeProjectRoot, agentId, meta);
      return {
        mode: "internal",
        initialEntries: loadInternalAgentTranscript(activeProjectRoot, agentId, {
          maxEvents: 250,
          maxEntries: 250,
          lineageIds,
        }),
      };
    },
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
    resolveSenderInfo,
    rawMarkdown: true,
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

  function buildEngineCatalog() {
    const builtin = [
      { id: "codex", agentType: "codex", label: "Codex", kind: "sdk", available: true, description: "OpenAI Codex SDK" },
      { id: "claude", agentType: "claude", label: "Claude Code", kind: "sdk", available: true, description: "Anthropic Claude Agent SDK" },
      { id: "agy", agentType: "agy", label: "Antigravity", kind: "native", available: isAgyAvailable(), description: "Google Antigravity (agy)" },
      { id: "ucode", agentType: "ucode", label: "ucode", kind: "native", available: true, description: "ufoo Native Coding Engine" },
    ];
    let acp = [];
    try {
      acp = detectInstalledAcpAgents(activeProjectRoot).map((item) => ({
        id: item.agentType,
        agentType: item.agentType,
        label: item.label,
        kind: "acp",
        available: Boolean(item.available),
        command: item.command,
        description: item.description || "ACP Agent",
      }));
    } catch {
      acp = [];
    }
    return [...builtin, ...acp];
  }

  function buildSnapshot() {
    const { loadChatHistory, loadInputHistory } = require("../app/chat/historyStore");
    const history = loadChatHistory(activeProjectRoot, 250, historyOptions());
    const inputHistory = loadInputHistory(activeProjectRoot, 200, historyOptions());
    const agents = controller.getAgentsSnapshot();
    const settingsSnap = buildSettingsSnapshot(loadConfig(activeProjectRoot) || settings);
    const tree = buildProjectsTreePayload();
    const activeNode = tree.projects.find((p) => p.active);
    const mainBusy = Boolean(isMainBusy(activeProjectRoot) || controller.session.pending || activeNode?.mainBusy);
    return {
      status: mainBusy ? "Thinking…" : "ready",
      busy: mainBusy,
      package_version: PACKAGE_VERSION,
      daemon_connected: daemonConnectionState === "connected",
      daemon_state: daemonConnectionState,
      footer: agents.footer || "",
      entries: rawHistoryToEntries(history, buildProjectSpeakerIndex(activeProjectRoot, controller.session.metaMap)),
      input_history: Array.isArray(inputHistory) ? inputHistory.filter(Boolean) : [],
      agents: agents.agents,
      engine_catalog: buildEngineCatalog(),
      settings: settingsSnap,
      agent_provider: settingsSnap.agent_provider,
      provider_options: settingsSnap.provider_options,
      global_mode: true,
      controller_root: controllerRoot,
      active_root: activeProjectRoot,
      scope: globalScope,
      stage_target: { ...stageTarget },
      pending_interaction: getActivePendingInteraction(),
      pending_interactions: getAllPendingInteractions(),
      queued_messages: buildQueueSnapshotForProject(activeProjectRoot),
      projects: tree.projects,
      workflow: globalScope === "project"
        ? getWorkflowSnapshot(activeProjectRoot)
        : { project_root: "", groups: [], edges: [], positions: {} },
      onboarding_needed: !require("./onboardingProbe").readOnboardingState(controllerRoot).completed && tree.projects.length === 0,
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

  function buildInitialClientEnvelopes() {
    if (!hostRef) return [];
    const envelopes = [
      createEnvelope({
        kind: "snapshot",
        name: "app.snapshot",
        seq: hostRef.nextSeq(),
        scope: { surface: "desktop", project_id: activeProjectRoot },
        payload: buildSnapshot(),
      }),
      createEnvelope({
        kind: "event",
        name: "projects.tree",
        seq: hostRef.nextSeq(),
        scope: { surface: "desktop", project_id: activeProjectRoot },
        payload: buildProjectsTreePayload(),
      }),
    ];
    if (globalScope === "project" && activeProjectRoot) {
      try {
        envelopes.push(createEnvelope({
          kind: "event",
          name: "workspace.changes.snapshot",
          seq: hostRef.nextSeq(),
          scope: { surface: "desktop", project_id: activeProjectRoot },
          payload: loadWorkspaceChanges(activeProjectRoot),
        }));
      } catch {
        // ignore inspector error on initial sync
      }
      try {
        envelopes.push(createEnvelope({
          kind: "event",
          name: "workspace.context.snapshot",
          seq: hostRef.nextSeq(),
          scope: { surface: "desktop", project_id: activeProjectRoot },
          payload: handleWorkspaceContext(activeProjectRoot),
        }));
      } catch {
        // ignore context error on initial sync
      }
    }
    return envelopes;
  }

  let commandHandlerRef = null;
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
      publishProjectsTree({ force: true });
      if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
        publishStandaloneWorkerFrame(stageTarget.agentId);
      }
      publishRightInspectorAll();
    },
    onCommand: (cmd) => commandHandlerRef(cmd),
  });

  commandHandlerRef = async function handleUiCommand(cmd) {
      const name = String(cmd.name || "");
      const payload = cmd.payload && typeof cmd.payload === "object" ? cmd.payload : {};

      if (name === "app.exit") return { ok: true };

      if (name === "remote.status") {
        if (!remoteBridge) return { ok: false, error: "Remote bridge is not enabled" };
        return remoteBridge.getStatus();
      }
      if (name === "remote.enable") {
        if (!remoteBridge) return { ok: false, error: "Remote bridge is not enabled" };
        return remoteBridge.enable({
          ...(payload.relay_url !== undefined ? { relay_url: payload.relay_url } : {}),
          ...(payload.web_base_url !== undefined ? { web_base_url: payload.web_base_url } : {}),
          ...(payload.auth_token !== undefined ? { auth_token: payload.auth_token } : {}),
          ...(payload.allow_insecure_ws !== undefined ? { allow_insecure_ws: Boolean(payload.allow_insecure_ws) } : {}),
        });
      }
      if (name === "remote.disable") {
        if (!remoteBridge) return { ok: false, error: "Remote bridge is not enabled" };
        return remoteBridge.disable();
      }
      if (name === "remote.pair.create") {
        if (!remoteBridge) return { ok: false, error: "Remote bridge is not enabled" };
        return remoteBridge.createPairing({
          ttlMs: payload.ttl_ms ?? payload.expires_in_ms,
          webBaseUrl: payload.web_base_url || "",
        });
      }
      if (name === "remote.devices.list") {
        if (!remoteBridge) return { ok: false, error: "Remote bridge is not enabled" };
        return remoteBridge.listDevices({ includeRevoked: Boolean(payload.include_revoked) });
      }
      if (name === "remote.devices.revoke") {
        if (!remoteBridge) return { ok: false, error: "Remote bridge is not enabled" };
        return remoteBridge.revokeDevice(payload.client_id || payload.clientId || "");
      }

      if (name === "ui.resync.request") {
        publish("app.snapshot", buildSnapshot());
        multiSession?.publishFrames();
        publishProjectsTree({ force: true });
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
          publishProjectsTree({ force: true });
          return missing ? { ok: true, silent: true } : { ok: true };
        }

        if (!id) return { ok: false, error: "Missing session ID" };
        const meta = (root === activeProjectRoot ? controller.session.metaMap.get(id) : null) || readDiskAgentMeta(root, id);
        const recItem = (recoverableCache.get(root) || []).find((r) => r.id === id);
        const customLabel = findSessionCustomLabel(root, id);
        const label = customLabel
          || String(meta?.display_nickname || meta?.nickname || "")
          || String(recItem?.label || "")
          || id;
        const workerType = String(meta?.agent_type || meta?.type || id.split(":")[0] || "worker");
        const worktreeBranch = String(meta?.worktree_branch || "");
        const internal = meta ? isInternalAgentMeta(meta) : true;

        const stopped = await stopInternalWorkerForSession(root, id, meta);
        const latestDiskMeta = readDiskAgentMeta(root, id);
        const isRecoverable = Boolean(
          recItem
          || meta?.provider_session_id
          || latestDiskMeta?.provider_session_id
        );
        sessionPrefs.setPinned(root, id, false);
        if (isRecoverable) {
          sessionPrefs.setArchivedMeta(root, id, {
            label,
            type: workerType,
            archivedAt: new Date().toISOString(),
            worktreeBranch,
            internal,
          });
        } else {
          sessionPrefs.clearArchivedMeta(root, id);
        }
        desktopArchive.archiveSession(root, id);
        if (activeProjectRoot === root && stageTarget.kind === "worker_single" && stageTarget.agentId === id) {
          changeWindowLayout("main");
        }
        publishProjectsTree({ force: true });
        return { ok: true, stopped, recoverable: isRecoverable };
      }

      if (name === "session.unarchive") {
        const target = String(payload.root || activeProjectRoot).trim();
        const id = String(payload.session_id || "").trim();
        if (!target) return { ok: false, error: "Missing project root" };
        if (!id) return { ok: false, error: "Missing session ID" };
        const root = safeCanonicalRoot(target);
        desktopArchive.restoreSession(root, id);
        sessionPrefs.clearArchivedMeta(root, id);

        const isLive = root === activeProjectRoot
          ? controller.session.agents.includes(id)
          : inspectDormantProjectSummary(root).workers.some((w) => w.id === id);

        let resumed = false;
        if (!isLive && payload.resume !== false) {
          let canResume = false;
          try {
            const rec = getRecoverableAgents(root, id);
            canResume = Boolean(rec && Array.isArray(rec.recoverable) && rec.recoverable.length > 0);
          } catch {
            canResume = false;
          }
          if (canResume) {
            if (activeProjectRoot !== root) {
              await switchToProjectRoot(root);
            }
            await controller.submitInput(`/resume ${id}`);
            await refreshRecoverableForActiveProject();
            resumed = true;
          }
        }
        publishProjectsTree({ force: true });
        return { ok: true, id, active: isLive, resumed };
      }

      if (name === "session.rename") {
        const target = String(payload.root || activeProjectRoot).trim();
        const id = String(payload.session_id || "").trim();
        const label = String(payload.label || "").trim().slice(0, 80);
        if (!target) return { ok: false, error: "Missing project root" };
        if (!id) return { ok: false, error: "Missing session ID" };
        if (!label) return { ok: false, error: "Session name cannot be empty" };
        const root = safeCanonicalRoot(target);

        sessionPrefs.setLabel(root, id, label);
        try {
          const { agentsFile } = getUfooPaths(root);
          if (fs.existsSync(agentsFile)) {
            updateAgentsData(agentsFile, (data) => {
              if (!data.agents || !data.agents[id]) return false;
              data.agents[id].nickname = label;
              data.agents[id].display_nickname = label;
              return true;
            }, { source: "desktop.session.rename" });
          }
        } catch {
          // ignore disk registry write error; UI label pref is still persisted
        }
        if (root === activeProjectRoot) {
          const meta = controller.session.metaMap.get(id);
          if (meta) {
            meta.nickname = label;
            meta.display_nickname = label;
          }
          controller.session.labelMap.set(id, label);
        }
        publishProjectsTree({ force: true });
        if (root === activeProjectRoot && stageTarget.kind === "worker_single" && stageTarget.agentId === id) {
          publishStandaloneWorkerFrame(id);
        }
        return { ok: true, id, label };
      }

      if (name === "session.pin") {
        const target = String(payload.root || activeProjectRoot).trim();
        const id = String(payload.session_id || "").trim();
        if (!target) return { ok: false, error: "Missing project root" };
        if (!id) return { ok: false, error: "Missing session ID" };
        const root = safeCanonicalRoot(target);
        const currentlyPinned = (sessionPrefs.read().pinned || []).some(
          (item) => safeCanonicalRoot(item.root) === root && item.id === id
        );
        const nextPinned = payload.pinned !== undefined ? Boolean(payload.pinned) : !currentlyPinned;
        sessionPrefs.setPinned(root, id, nextPinned);
        publishProjectsTree({ force: true });
        return { ok: true, id, pinned: nextPinned };
      }

      if (name === "session.delete") {
        const target = String(payload.root || activeProjectRoot).trim();
        const id = String(payload.session_id || "").trim();
        if (!target) return { ok: false, error: "Missing project root" };
        if (!id) return { ok: false, error: "Missing session ID" };
        const root = safeCanonicalRoot(target);
        const meta = (root === activeProjectRoot ? controller.session.metaMap.get(id) : null) || readDiskAgentMeta(root, id);
        deletedSessionGuard.set(`${root}\0${id}`, Date.now() + DELETED_SESSION_GUARD_MS);

        await stopInternalWorkerForSession(root, id, meta);

        try {
          const { agentsFile } = getUfooPaths(root);
          if (fs.existsSync(agentsFile)) {
            updateAgentsData(agentsFile, (data) => {
              if (!data.agents || !Object.prototype.hasOwnProperty.call(data.agents, id)) return false;
              delete data.agents[id];
              return true;
            }, { source: "desktop.session.delete" });
          }
        } catch {
          // ignore registry delete errors
        }

        cleanupSessionPerAgentFiles(root, id);
        desktopArchive.purgeSession(root, id);
        sessionPrefs.purgeSession(root, id);

        let worktreeRemoved = false;
        let worktreeKept = "";
        let worktreeSharedBy = [];
        const wtRoot = meta?.worktree_root ? safeCanonicalRoot(meta.worktree_root) : "";
        if (wtRoot && wtRoot !== root && fs.existsSync(wtRoot) && payload.remove_worktree !== false) {
          worktreeSharedBy = findAgentsUsingWorktree(root, wtRoot, { excludeAgentId: id, activeOnly: false });
          if (worktreeSharedBy.length > 0) {
            worktreeKept = wtRoot;
          } else if (payload.force_worktree === true || isWorktreeClean(wtRoot)) {
            try {
              const rmRes = removeManagedWorktree({
                projectRoot: root,
                worktreePath: wtRoot,
                force: Boolean(payload.force_worktree),
                deleteBranch: false,
              });
              if (rmRes?.ok) worktreeRemoved = true;
              else worktreeKept = wtRoot;
            } catch {
              worktreeKept = wtRoot;
            }
          } else {
            worktreeKept = wtRoot;
          }
        }

        if (recoverableCache.has(root)) {
          recoverableCache.set(root, (recoverableCache.get(root) || []).filter((item) => item.id !== id));
        }
        if (root === activeProjectRoot) {
          controller.session.agents = controller.session.agents.filter((agentId) => agentId !== id);
          controller.session.metaMap.delete(id);
          controller.session.labelMap.delete(id);
          standaloneSurfaces.delete(id);
          standaloneDrafts.delete(id);
          if (stageTarget.kind === "worker_single" && stageTarget.agentId === id) {
            changeWindowLayout("main");
          }
          controller.requestDaemonStatus();
        }
        publishProjectsTree({ force: true });
        return {
          ok: true,
          id,
          deleted: true,
          worktree_removed: worktreeRemoved,
          worktree_kept: worktreeKept,
          ...(worktreeSharedBy.length > 0 ? { worktree_shared_by: worktreeSharedBy } : {}),
        };
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
        const rawAgentId = String(payload.agent_id || payload.agentId || "").trim();
        const agentId = rawAgentId === "main" ? "" : rawAgentId;
        if (targetRoot && safeCanonicalRoot(targetRoot) !== activeProjectRoot) {
          return switchToProjectRoot(targetRoot, { agentId });
        }
        if (!agentId) {
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
        // Auto-sync Changes inspector to the worker's worktree if it owns one
        try {
          const wtRoot = frame?.worktree_root || controller.session.metaMap.get(agentId)?.worktree_root || "";
          if (wtRoot && wtRoot !== activeProjectRoot) {
            publish("workspace.changes.snapshot", loadWorkspaceChanges(activeProjectRoot, { worktreeRoot: wtRoot }));
          }
        } catch {
          // ignore inspector sync error
        }
        return { ok: true, stage_target: stageTarget, frame };
      }

      if (name === "chat.clear") {
        const nextConversationId = `main-${crypto.randomUUID()}`;
        try {
          saveConfig(activeProjectRoot, { agentConversationId: nextConversationId });
        } catch {
          // ignore config write error on read-only root
        }
        controller.session.runtimeSessionId = nextConversationId;
        controller.session.pending = null;
        setMainBusyState(activeProjectRoot, false);
        clearQueueBucket(activeProjectRoot, "main");
        streamIds.clear();
        streamLabels.clear();
        clearChatHistory(activeProjectRoot, historyOptions());
        publish("transcript.reset", { entries: [] });
        publish("plan.set", { lines: [] });
        publish("status.set", { text: "ready", busy: false });
        publishProjectsTree();
        return { ok: true, conversation_id: nextConversationId };
      }

      if (name === "worker.clear") {
        const agentId = String(payload.agent_id || payload.agentId || (stageTarget.kind === "worker_single" ? stageTarget.agentId : "")).trim();
        if (!agentId) return { ok: false, error: "agent_id required" };
        const meta = controller.session.metaMap.get(agentId) || {};
        if (!isInternalAgentMeta(meta)) {
          return { ok: false, error: "Clear is only available for internal agents" };
        }
        const liveRes = await clearInternalAgent(activeProjectRoot, agentId)
          .catch((err) => ({ ok: false, error: err && err.message ? err.message : "clear failed" }));
        const contextReset = Boolean(liveRes && liveRes.ok);
        if (!contextReset) {
          clearProviderSessionId(activeProjectRoot, agentId);
        }
        if (!liveRes?.cleared_surface) {
          try {
            const pub = createAgentSurfacePublisher(activeProjectRoot, agentId);
            pub.enqueue({ type: "surface_cleared", agentId });
            await pub.flush();
          } catch {
            // ignore surface log write failure
          }
        }
        if (stageTarget.kind === "worker_single" && stageTarget.agentId === agentId) {
          pollStandaloneWorkerSurface();
        }
        const holder = ensureStandaloneSurface(agentId);
        holder.surface.accept({ type: "surface_cleared" });
        clearQueueBucket(activeProjectRoot, "worker", agentId);
        if (multiSession && typeof multiSession.clearPane === "function") {
          multiSession.clearPane(agentId);
        }
        if (stageTarget.kind === "worker_single" && stageTarget.agentId === agentId) {
          publishStandaloneWorkerFrame(agentId);
        }
        publishProjectsTree();
        return {
          ok: true,
          agent_id: agentId,
          context_reset: contextReset,
          ...(contextReset ? {} : { warning: liveRes?.error || "Worker runner predates live clear; view cleared" }),
        };
      }

      if (name === "workflow.snapshot") {
        const snap = publishWorkflowSnapshot(true);
        return { ok: true, ...(snap || { project_root: "", groups: [], edges: [], positions: {} }) };
      }

      if (name === "workflow.connect") {
        if (globalScope !== "project") return { ok: false, error: "Select a project first" };
        const res = connectWorkflowEdge(activeProjectRoot, {
          from: payload.from,
          to: payload.to,
          kind: payload.kind || "handoff",
        });
        if (res.ok) {
          if (res.snapshot) {
            lastWorkflowSignature = JSON.stringify({
              root: res.snapshot.project_root,
              groups: res.snapshot.groups,
              edges: res.snapshot.edges,
            });
            publish("workflow.snapshot", res.snapshot);
          }
          controller.requestDaemonStatus();
          publishProjectsTree({ force: true });
        }
        return res;
      }

      if (name === "workflow.disconnect") {
        if (globalScope !== "project") return { ok: false, error: "Select a project first" };
        const res = disconnectWorkflowEdge(activeProjectRoot, {
          edgeId: payload.edge_id || payload.edgeId || "",
          from: payload.from || "",
          to: payload.to || "",
        });
        if (res.ok) {
          if (res.snapshot) {
            lastWorkflowSignature = JSON.stringify({
              root: res.snapshot.project_root,
              groups: res.snapshot.groups,
              edges: res.snapshot.edges,
            });
            publish("workflow.snapshot", res.snapshot);
          }
          controller.requestDaemonStatus();
          publishProjectsTree({ force: true });
        }
        return res;
      }

      if (name === "workflow.disband") {
        if (globalScope !== "project") return { ok: false, error: "Select a project first" };
        const res = disbandAdhocGroup(activeProjectRoot);
        if (res.ok && res.snapshot) {
          lastWorkflowSignature = JSON.stringify({
            root: res.snapshot.project_root,
            groups: res.snapshot.groups,
            edges: res.snapshot.edges,
          });
          publish("workflow.snapshot", res.snapshot);
        }
        controller.requestDaemonStatus();
        publishProjectsTree({ force: true });
        return res;
      }

      if (name === "workflow.rename") {
        if (globalScope !== "project") return { ok: false, error: "Select a project first" };
        const res = renameAdhocGroup(activeProjectRoot, payload.name);
        if (res.ok && res.snapshot) {
          lastWorkflowSignature = JSON.stringify({
            root: res.snapshot.project_root,
            groups: res.snapshot.groups,
            edges: res.snapshot.edges,
          });
          publish("workflow.snapshot", res.snapshot);
        }
        return res;
      }

      if (name === "workflow.layout") {
        if (globalScope !== "project") return { ok: false, error: "Select a project first" };
        const positions = saveNodePositions(activeProjectRoot, payload.positions || {});
        return { ok: true, positions };
      }

      if (name === "attachment.stage") {
        const targetRoot = activeProjectRoot || controllerRoot;
        if (!targetRoot) return { ok: false, error: "No active workspace" };
        return stageAttachments(targetRoot, {
          paths: Array.isArray(payload.paths) ? payload.paths : [],
          uploads: Array.isArray(payload.uploads) ? payload.uploads : [],
        });
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
        const attachments = normalizeAttachmentList(payload.attachments || []);
        const forceSend = payload.force_send === true;
        if (stageTarget.kind === "worker_single" && payload.agent_id === stageTarget.agentId) {
          const id = stageTarget.agentId;
          const text = String(payload.input ?? "");
          const rev = Number(payload.input_revision) || 0;
          standaloneDrafts.set(id, { text: payload.submit ? "" : text, revision: rev });
          if (payload.submit && (text.trim() || attachments.length > 0)) {
            const existingBucket = queuedMessageBuckets.get(queueBucketKey(activeProjectRoot, "worker", id));
            const shouldQueue = !forceSend
              && isInternalChild(id)
              && !isWorkerWaitingReply(id)
              && (isWorkerBusy(id) || Boolean(existingBucket && existingBucket.items.length > 0));
            if (shouldQueue) {
              const queued = enqueueQueuedMessage(activeProjectRoot, "worker", id, text, attachments);
              publishStandaloneWorkerFrame(id);
              return { ok: true, queued: true, queue_id: queued.id, input_revision: rev };
            }
            if (forceSend && isInternalChild(id) && isWorkerBusy(id)) {
              const { cancelInternalTask } = require("../agents/internal/taskControl");
              await Promise.resolve(cancelInternalTask(activeProjectRoot, id)).catch(() => {});
              await new Promise((resolve) => setTimeout(resolve, 140));
            }
            dispatchWorkerMessageNow(id, text, attachments);
            return { ok: true, input_revision: rev };
          }
          publishStandaloneWorkerFrame(id);
          return { ok: true, input_revision: rev };
        }
        if (payload.submit === true) {
          const id = String(payload.agent_id || "").trim();
          const text = String(payload.input ?? "");
          if (id && (text.trim() || attachments.length > 0) && isInternalChild(id)) {
            const existingBucket = queuedMessageBuckets.get(queueBucketKey(activeProjectRoot, "worker", id));
            const shouldQueue = !forceSend
              && !isWorkerWaitingReply(id)
              && (isWorkerBusy(id) || Boolean(existingBucket && existingBucket.items.length > 0));
            if (shouldQueue) {
              const queued = enqueueQueuedMessage(activeProjectRoot, "worker", id, text, attachments);
              multiSession.handleRaw({
                agent_id: id,
                input: "",
                cursor: 0,
                input_revision: Number(payload.input_revision) || 0,
                submit: false,
              });
              return { ok: true, queued: true, queue_id: queued.id, agent_id: id, input_revision: Number(payload.input_revision) || 0 };
            }
            if (attachments.length > 0 || forceSend) {
              if (forceSend && isWorkerBusy(id)) {
                const { cancelInternalTask } = require("../agents/internal/taskControl");
                await Promise.resolve(cancelInternalTask(activeProjectRoot, id)).catch(() => {});
                await new Promise((resolve) => setTimeout(resolve, 140));
              }
              dispatchWorkerMessageNow(id, text, attachments);
              return { ok: true, agent_id: id, input_revision: Number(payload.input_revision) || 0 };
            }
          }
        }
        return multiSession.handleRaw(payload);
      }

      if (name === "multi.cancel" || (name === "task.cancel" && payload.agent_id)) {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (agentId) pauseQueueIfNonEmpty(activeProjectRoot, "worker", agentId);
        if (agentId && isInternalAgentMeta(controller.session.metaMap.get(agentId))) {
          const { cancelInternalTask } = require("../agents/internal/taskControl");
          await Promise.resolve(cancelInternalTask(activeProjectRoot, agentId)).catch(() => {});
          return { ok: true, cancelled_agent: agentId };
        }
        return multiSession.handleCancel(payload);
      }

      if (name === "task.cancel") {
        const normRoot = safeCanonicalRoot(activeProjectRoot) || activeProjectRoot;
        const cancelRunId = String(payload.task_run_id || activeMainTaskRunIdByRoot.get(normRoot) || "").trim();
        if (cancelRunId) {
          daemonSend({
            type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
            operation: "cancel",
            task_run_id: cancelRunId,
          });
        }
        setMainBusyState(activeProjectRoot, false);
        pauseQueueIfNonEmpty(activeProjectRoot, "main");
        publish("status.set", { text: "cancel requested", busy: false });
        publish("stream.done", { id: "cancel" });
        return { ok: true };
      }

      if (name === "queue.remove") {
        const scope = payload.scope === "worker" ? "worker" : "main";
        const agentId = scope === "worker" ? String(payload.agent_id || payload.agentId || "").trim() : "";
        const id = String(payload.id || "").trim();
        if (!id) return { ok: false, error: "queue item id required" };
        const key = queueBucketKey(activeProjectRoot, scope, agentId);
        const bucket = queuedMessageBuckets.get(key);
        if (!bucket) return { ok: true, removed: null };
        const idx = bucket.items.findIndex((item) => item.id === id);
        if (idx < 0) return { ok: true, removed: null };
        const [removed] = bucket.items.splice(idx, 1);
        if (bucket.items.length === 0) queuedMessageBuckets.delete(key);
        publishQueueSnapshot(activeProjectRoot);
        return { ok: true, removed };
      }

      if (name === "queue.clear") {
        const scope = payload.scope === "worker" ? "worker" : "main";
        const agentId = scope === "worker" ? String(payload.agent_id || payload.agentId || "").trim() : "";
        const cleared = clearQueueBucket(activeProjectRoot, scope, agentId);
        return { ok: true, cleared };
      }

      if (name === "queue.send_now") {
        const scope = payload.scope === "worker" ? "worker" : "main";
        const agentId = scope === "worker" ? String(payload.agent_id || payload.agentId || "").trim() : "";
        const id = String(payload.id || "").trim();
        const key = queueBucketKey(activeProjectRoot, scope, agentId);
        const bucket = queuedMessageBuckets.get(key);
        if (!bucket || bucket.items.length === 0) {
          return { ok: false, error: "queue is empty" };
        }
        const idx = id ? bucket.items.findIndex((item) => item.id === id) : 0;
        if (idx < 0) return { ok: false, error: "queue item not found" };
        const [item] = bucket.items.splice(idx, 1);
        bucket.paused = false;
        if (bucket.items.length === 0) queuedMessageBuckets.delete(key);
        publishQueueSnapshot(activeProjectRoot);

        if (scope === "worker" && agentId) {
          if (isInternalChild(agentId) && isWorkerBusy(agentId)) {
            const { cancelInternalTask } = require("../agents/internal/taskControl");
            await Promise.resolve(cancelInternalTask(activeProjectRoot, agentId)).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 140));
          }
          dispatchWorkerMessageNow(agentId, item.text, item.attachments);
          return { ok: true, dispatched: item.id, scope: "worker", agent_id: agentId };
        }

        if (isMainBusy(activeProjectRoot)) {
          const normRoot = safeCanonicalRoot(activeProjectRoot) || activeProjectRoot;
          const cancelRunId = String(activeMainTaskRunIdByRoot.get(normRoot) || "").trim();
          if (cancelRunId) {
            daemonSend({
              type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
              operation: "cancel",
              task_run_id: cancelRunId,
            });
          }
          setMainBusyState(activeProjectRoot, false);
          publish("stream.done", { id: "cancel" });
          await new Promise((resolve) => setTimeout(resolve, 140));
        }
        await dispatchMainMessageNow(item.text, item.attachments);
        return { ok: true, dispatched: item.id, scope: "main" };
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
        daemonSend({ type: IPC_REQUEST_TYPES.RESUME_AGENTS, target: targetId, internal_only: true });
        controller.requestDaemonStatus();
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
        if (payload.dismiss_all === true) {
          const allItems = [...pendingInteractions.values()];
          for (const item of allItems) {
            if (!item || !item.id || item.id.startsWith("settings-")) continue;
            markInteractionDismissed(item.id);
            pendingInteractions.delete(item.id);
            daemonSend({
              type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
              operation: "cancel",
              interaction_id: item.id,
              task_run_id: item.taskRunId || "",
              session_id: item.sessionId || "",
              reason: "interaction_dismissed",
            });
          }
          syncPublishedInteraction(true);
          publishProjectsTree();
          controller.requestDaemonStatus();
          return { ok: true, dismissed: allItems.length };
        }
        const currentHead = getActivePendingInteraction();
        const interactionId = String(payload.id || currentHead?.id || "").trim();
        const target = (interactionId && pendingInteractions.get(interactionId)) || currentHead || null;
        const answerText = String(payload.text ?? payload.answer ?? "").trim();
        if (interactionId) {
          if (payload.cancelled) {
            daemonSend({
              type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
              operation: "cancel",
              interaction_id: interactionId,
              task_run_id: target?.taskRunId || "",
              session_id: target?.sessionId || "",
              reason: "interaction_dismissed",
            });
          } else {
            daemonSend({
              type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
              operation: "resume",
              interaction_id: interactionId,
              task_run_id: target?.taskRunId || "",
              session_id: target?.sessionId || "",
              answer: answerText,
            });
          }
          removePendingInteraction(
            { id: interactionId, taskRunId: target?.taskRunId || "" },
            { markDismissed: true }
          );
        }
        syncPublishedInteraction(true);
        publishProjectsTree();
        controller.requestDaemonStatus();
        return { ok: true };
      }

      if (name === "agents.catalog") {
        return { ok: true, engines: buildEngineCatalog() };
      }

      if (name === "onboarding.probe") {
        const tree = buildProjectsTreePayload();
        const data = await probeOnboardingState({
          controllerRoot,
          projectRoot: activeProjectRoot,
          existingProjectsCount: tree.projects.length,
        });
        publish("onboarding.state", data);
        return { ok: true, data };
      }

      if (name === "onboarding.complete") {
        if (payload.agent_provider) {
          await applyAgentSettings({ agent_provider: String(payload.agent_provider) }).catch(() => {});
        }
        const saved = saveOnboardingState(controllerRoot, {
          completed: true,
          skipped: Boolean(payload.skipped),
        });
        return { ok: true, state: saved };
      }

      if (name === "onboarding.open_login") {
        return launchLoginInTerminal(payload.engine || payload.id || "", {
          dryRun: Boolean(payload.dryRun),
        });
      }

      if (name === "onboarding.configure_mcp") {
        return configureExternalHostMcp(payload.host || "codex", { controllerRoot });
      }

      if (name === "ui.events.since") {
        const sinceSeq = Number(payload.seq || 0);
        const oldestSeq = recentEvents.length ? Number(recentEvents[0].seq || 0) : 0;
        const resyncRequired = Boolean(
          sinceSeq > 0 && recentEvents.length >= MAX_RECENT_EVENTS && oldestSeq > sinceSeq + 1
        );
        const events = resyncRequired ? [] : recentEvents.filter((evt) => Number(evt.seq || 0) > sinceSeq);
        return {
          ok: true,
          events,
          resync_required: resyncRequired,
          latest_seq: recentEvents.length ? recentEvents[recentEvents.length - 1].seq : sinceSeq,
        };
      }

      if (name === "worker.models") {
        const root = activeProjectRoot;
        const current = loadConfig(root);
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        const isMain = !agentId || agentId === "main";
        const meta = isMain ? {} : (resolveAgentMeta(root, agentId) || {});
        const workerType = isMain
          ? "main"
          : String(payload.agent_type || meta.agent_type || meta.type || agentId.split(":")[0] || "worker");
        const resolvedProvider = resolveProviderForWorkerType(workerType, current);
        const currentModel = isMain
          ? String(current.agentModel || defaultAgentModelForProvider(resolvedProvider) || "")
          : resolveWorkerDisplayModel(meta, workerType, current);
        const currentThinking = isMain
          ? String(current.agentThinking || "medium")
          : String(meta.thinking_level || current.agentThinking || "medium");
        const levels = thinkingLevelsForProvider(resolvedProvider);

        if (!resolvedProvider) {
          return {
            ok: true,
            agent_id: agentId || "main",
            provider: workerType,
            models: currentModel ? [currentModel] : [],
            default_model: currentModel,
            current_model: currentModel,
            current_thinking: currentThinking,
            thinking_levels: levels,
            allow_custom: true,
          };
        }

        const defaultModel = defaultAgentModelForProvider(resolvedProvider) || "";
        let catalog = { ok: false, models: [], allowUnlistedModels: resolvedProvider === "custom" };
        if (resolvedProvider === "agy-cli" && !isMain) {
          const cliCatalog = await listAgyCliModels().catch(() => ({ ok: false, models: [] }));
          if (cliCatalog.ok && Array.isArray(cliCatalog.models) && cliCatalog.models.length > 0) {
            catalog = { ok: true, models: cliCatalog.models, allowUnlistedModels: false };
          }
        }
        if (!catalog.ok || !Array.isArray(catalog.models) || catalog.models.length === 0) {
          catalog = await listAgentModels(root, {
            config: { ...current, agentProvider: resolvedProvider, agentModel: currentModel || defaultModel },
          }).catch(() => ({ ok: false, models: [], allowUnlistedModels: resolvedProvider === "custom" }));
        }
        if (resolvedProvider === "agy-cli" && (!catalog.ok || !Array.isArray(catalog.models) || catalog.models.length === 0)) {
          const cliCatalog = await listAgyCliModels().catch(() => ({ ok: false, models: [] }));
          if (cliCatalog.ok && Array.isArray(cliCatalog.models) && cliCatalog.models.length > 0) {
            catalog = { ok: true, models: cliCatalog.models, allowUnlistedModels: false };
          }
        }
        const catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
        const models = Array.from(new Set([
          ...catalogModels,
          ...(defaultModel ? [defaultModel] : []),
          ...(currentModel ? [currentModel] : []),
        ].filter(Boolean)));
        return {
          ok: true,
          agent_id: agentId || "main",
          provider: resolvedProvider,
          models,
          default_model: defaultModel,
          current_model: currentModel || defaultModel,
          current_thinking: currentThinking,
          thinking_levels: levels,
          allow_custom: Boolean(catalog.allowUnlistedModels || resolvedProvider === "custom"),
        };
      }

      if (name === "worker.configure") {
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        const modelRaw = payload.model !== undefined ? String(payload.model || "").trim() : undefined;
        const thinkingRaw = (payload.thinking_level ?? payload.thinkingLevel) !== undefined
          ? String(payload.thinking_level ?? payload.thinkingLevel ?? "").trim()
          : undefined;
        const permRaw = (payload.permission_mode ?? payload.permissionMode) !== undefined
          ? String(payload.permission_mode ?? payload.permissionMode ?? "").trim().toLowerCase()
          : undefined;

        let normalizedThinking;
        if (thinkingRaw !== undefined) {
          normalizedThinking = normalizeThinkingLevel(thinkingRaw);
          if (!normalizedThinking) {
            return { ok: false, error: "Thinking effort must be off, low, medium, high, xhigh, or max" };
          }
        }
        if (permRaw !== undefined && !["supervised", "auto_edit", "full_access"].includes(permRaw)) {
          return { ok: false, error: "Permission mode must be supervised, auto_edit, or full_access" };
        }

        if (!agentId || agentId === "main") {
          const patch = {};
          if (modelRaw !== undefined) patch.agent_model = modelRaw;
          if (normalizedThinking !== undefined) patch.agent_thinking = normalizedThinking;
          if (permRaw !== undefined) patch.permission_mode = permRaw;
          return applyAgentSettings(patch);
        }

        const meta = resolveAgentMeta(activeProjectRoot, agentId) || getHandoffAgentMeta(agentId);
        if (!meta) return { ok: false, error: "Worker not found" };
        if (!isInternalAgentMeta(meta)) {
          return { ok: false, error: "External agents manage their own model and permissions" };
        }

        const cfg = (() => {
          try { return loadConfig(activeProjectRoot) || {}; } catch { return {}; }
        })();
        const workerType = String(meta.agent_type || meta.type || agentId.split(":")[0] || "worker");
        const resolvedProvider = resolveProviderForWorkerType(workerType, cfg);

        let effectiveModel = modelRaw;
        let effectiveThinking = normalizedThinking;
        if (resolvedProvider === "agy-cli") {
          if (effectiveModel !== undefined && effectiveThinking === undefined) {
            const tierMatch = effectiveModel.match(/-(low|medium|high|xhigh)$/i);
            if (tierMatch) effectiveThinking = tierMatch[1].toLowerCase();
          } else if (effectiveModel === undefined && effectiveThinking !== undefined) {
            const existingModel = resolveWorkerDisplayModel(meta, workerType, cfg);
            const baseMatch = existingModel.match(/^(.+)-(low|medium|high|xhigh)$/i);
            if (baseMatch) {
              const candidate = `${baseMatch[1]}-${effectiveThinking}`;
              const cliCatalog = await listAgyCliModels().catch(() => ({ ok: false, models: [] }));
              if (cliCatalog.ok && Array.isArray(cliCatalog.models) && cliCatalog.models.includes(candidate)) {
                effectiveModel = candidate;
              }
            }
          }
        }

        const runtimePatch = {};
        if (effectiveModel !== undefined) runtimePatch.model = effectiveModel;
        if (effectiveThinking !== undefined) runtimePatch.thinking_level = effectiveThinking;
        if (permRaw !== undefined) runtimePatch.permission_mode = permRaw;

        const liveRes = await configureInternalAgent(activeProjectRoot, agentId, runtimePatch);
        const persistedFields = {
          ...(effectiveModel !== undefined ? { model: liveRes?.model || effectiveModel } : {}),
          ...(effectiveThinking !== undefined ? { thinking_level: liveRes?.thinking_level || effectiveThinking } : {}),
          ...(permRaw !== undefined ? { permission_mode: liveRes?.permission_mode || permRaw } : {}),
        };
        persistAgentRuntimeMeta(activeProjectRoot, agentId, persistedFields);
        const existingMeta = resolveAgentMeta(activeProjectRoot, agentId) || {};
        controller.session.metaMap.set(agentId, { ...existingMeta, ...persistedFields });
        publishProjectsTree({ force: true });
        if (stageTarget.kind === "worker_single" && stageTarget.agentId === agentId) {
          publishStandaloneWorkerFrame(agentId);
        }
        if (multiSession?.isActive()) {
          multiSession.publishFrames();
        }
        return {
          ok: true,
          agent_id: agentId,
          live: Boolean(liveRes?.ok),
          ...persistedFields,
          ...(liveRes?.ok ? {} : { warning: "Saved to worker metadata; restart worker if live control is unavailable." }),
        };
      }

      if (name === "session.set_permission") {
        const mode = String(payload.mode || payload.permission_mode || "").trim().toLowerCase();
        const agentId = String(payload.agent_id || payload.agentId || "").trim();
        if (agentId && agentId !== "main") {
          const meta = resolveAgentMeta(activeProjectRoot, agentId) || getHandoffAgentMeta(agentId);
          if (meta && isInternalAgentMeta(meta)) {
            const liveRes = await configureInternalAgent(activeProjectRoot, agentId, { permission_mode: mode });
            persistAgentRuntimeMeta(activeProjectRoot, agentId, { permission_mode: mode });
            const existingMeta = resolveAgentMeta(activeProjectRoot, agentId) || {};
            controller.session.metaMap.set(agentId, { ...existingMeta, permission_mode: mode });
            publishProjectsTree({ force: true });
            if (stageTarget.kind === "worker_single" && stageTarget.agentId === agentId) {
              publishStandaloneWorkerFrame(agentId);
            }
            return { ok: true, agent_id: agentId, permission_mode: mode, live: Boolean(liveRes?.ok) };
          }
        }
        return applyAgentSettings({ permission_mode: mode });
      }

      if (name === "worker.handoff") {
        const sourceId = String(payload.source_agent_id || stageTarget.agentId || "").trim();
        const targetEngine = String(payload.target_engine || payload.agent || "").trim();
        if (!targetEngine) return { ok: false, error: "Target engine is required" };
        const sourceMeta = sourceId ? (controller.session.metaMap.get(sourceId) || {}) : {};
        const worktreeRoot = String(sourceMeta.worktree_root || activeProjectRoot);
        const sourceEntries = sourceId && standaloneSurfaces.has(sourceId)
          ? standaloneSurfaces.get(sourceId).surface.getSnapshot().entries.slice(-8)
          : [];
        const digest = sourceEntries
          .map((entry) => `[${entry.kind}] ${String(entry.text || "").slice(0, 260)}`)
          .join("\n");
        const handoffPrompt = [
          `[Mid-Thread Handoff from ${sourceMeta.display_nickname || sourceId || "previous session"}]`,
          worktreeRoot !== activeProjectRoot ? `Workspace/Worktree: ${worktreeRoot}` : "",
          payload.note ? `User Note: ${String(payload.note)}` : "",
          digest ? `Recent Context:\n${digest}` : "",
          "Continue seamlessly from this state without repeating already completed work.",
        ].filter(Boolean).join("\n\n");

        const launchResp = await requestDaemon(activeProjectRoot, {
          type: IPC_REQUEST_TYPES.LAUNCH_AGENT,
          agent: targetEngine,
          count: 1,
          internal_only: true,
          worktreeMode: "none",
          groupWorktreeRoot: worktreeRoot,
        }, { controllerRoot, fullResponse: true, timeoutMs: 30000 });
        const launch = launchResp?.opsResults?.find(({ action }) => action === "launch");
        if (launch?.ok === false) return { ok: false, error: launch.error || "Handoff launch failed" };
        const newId = Array.isArray(launch?.subscriber_ids) ? launch.subscriber_ids[0] : "";
        if (newId) {
          daemonSend({
            type: IPC_REQUEST_TYPES.BUS_SEND,
            request_id: `handoff-${crypto.randomUUID()}`,
            target: newId,
            message: handoffPrompt,
            injection_mode: "immediate",
            source: "ufoo-desktop-handoff",
          });
          stageTarget = { kind: "worker_single", agentId: newId };
          publishProjectsTree({ force: true });
        }
        return { ok: true, agent_id: newId, target_engine: targetEngine };
      }

      if (name === "workspace.changes") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const snap = loadWorkspaceChanges(root, payload);
        publish("workspace.changes.snapshot", snap);
        return { ok: true, data: snap };
      }

      if (name === "workspace.git.stage") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const res = gitStage(root, payload);
        if (res.ok) publish("workspace.changes.snapshot", loadWorkspaceChanges(root, { worktreeRoot: payload.worktreeRoot }));
        return res;
      }

      if (name === "workspace.git.unstage") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const res = gitUnstage(root, payload);
        if (res.ok) publish("workspace.changes.snapshot", loadWorkspaceChanges(root, { worktreeRoot: payload.worktreeRoot }));
        return res;
      }

      if (name === "workspace.git.discard") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const res = gitDiscard(root, payload);
        if (res.ok) publish("workspace.changes.snapshot", loadWorkspaceChanges(root, { worktreeRoot: payload.worktreeRoot }));
        return res;
      }

      if (name === "workspace.git.suggest_commit") {
        const root = String(payload.projectRoot || activeProjectRoot);
        return gitSuggestCommitMessage(root, payload);
      }

      if (name === "workspace.git.commit") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const res = gitCommit(root, payload);
        if (res.ok) publish("workspace.changes.snapshot", loadWorkspaceChanges(root, { worktreeRoot: payload.worktreeRoot }));
        return res;
      }

      if (name === "workspace.git.push") {
        const root = String(payload.projectRoot || activeProjectRoot);
        return gitPush(root, payload);
      }

      if (name === "workspace.git.create_pr") {
        const root = String(payload.projectRoot || activeProjectRoot);
        return gitCreatePr(root, payload);
      }

      if (name === "workspace.worktree.merge") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const activeUsers = payload.worktreePath
          ? findAgentsUsingWorktree(root, payload.worktreePath, { activeOnly: true })
          : [];
        const res = mergeManagedWorktree({
          projectRoot: root,
          branch: payload.branch,
          targetBranch: payload.targetBranch || "",
          squash: Boolean(payload.squash),
          worktreePath: payload.worktreePath || "",
          removeAfter: Boolean(payload.removeAfter) && activeUsers.length === 0,
        });
        if (res.ok) publish("workspace.changes.snapshot", loadWorkspaceChanges(root, {}));
        return activeUsers.length > 0 && payload.removeAfter
          ? { ...res, worktree_kept: payload.worktreePath, worktree_shared_by: activeUsers }
          : res;
      }

      if (name === "workspace.worktree.remove") {
        const root = String(payload.projectRoot || activeProjectRoot);
        const wtPath = String(payload.worktreePath || "").trim();
        if (wtPath) {
          const activeUsers = findAgentsUsingWorktree(root, wtPath, { activeOnly: true });
          if (activeUsers.length > 0) {
            return {
              ok: false,
              in_use: true,
              error: `Worktree is still in use by active worker(s): ${activeUsers.join(", ")}`,
            };
          }
          if (payload.force !== true && fs.existsSync(wtPath) && !isWorktreeClean(wtPath)) {
            return {
              ok: false,
              dirty: true,
              error: "Worktree has uncommitted changes. Commit, revert, or confirm force removal.",
            };
          }
        }
        const res = removeManagedWorktree({
          projectRoot: root,
          worktreePath: wtPath,
          branch: payload.branch || "",
          force: Boolean(payload.force),
          deleteBranch: Boolean(payload.deleteBranch),
        });
        if (res.ok) publish("workspace.changes.snapshot", loadWorkspaceChanges(root, {}));
        return res;
      }

      if (name === "workspace.docs") {
        const root = String(payload.projectRoot || activeProjectRoot);
        let fallbackWorktree = String(payload.worktreeRoot || "").trim();
        if (!fallbackWorktree && stageTarget.kind === "worker_single" && stageTarget.agentId) {
          const wt = controller.session.metaMap.get(stageTarget.agentId)?.worktree_root;
          if (wt) fallbackWorktree = String(wt);
        }
        const snap = loadWorkspaceDocs(root, {
          ...payload,
          ...(fallbackWorktree ? { worktreeRoot: fallbackWorktree } : {}),
        });
        publish("workspace.docs.snapshot", snap);
        return { ok: true, data: snap };
      }

      if (name === "workspace.context") {
        const root = String(payload.projectRoot || activeProjectRoot);
        if (String(payload.operation || "").trim() === "decision.tidy") {
          if (safeCanonicalRoot(root) === controllerRoot) {
            return { ok: false, error: "Select a project workspace before tidying decisions" };
          }
          const plan = buildDecisionTidyPrompt(root);
          if (plan.openCount === 0) {
            return { ok: false, error: "No open decisions to tidy" };
          }
          if (safeCanonicalRoot(root) !== activeProjectRoot) {
            const sw = await switchToProjectRoot(root);
            if (!sw?.ok) return sw || { ok: false, error: "Could not switch project" };
          }
          if (stageTarget.kind !== "project_main") {
            stageTarget = { kind: "project_main", agentId: "" };
            reconcileInternalWatches();
            publishProjectsTree({ force: true });
            publish("window.set", multiSession.getSnapshot());
            multiSession.publishFrames();
          }
          controller.session.targetAgent = null;
          await controller.submitInput(plan.prompt);
          const snap = handleWorkspaceContext(activeProjectRoot, { operation: "snapshot" });
          publish("workspace.context.snapshot", snap);
          return { ok: true, started: true, openCount: plan.openCount, files: plan.files, data: snap };
        }
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

      if (name === "daemon.service.status") {
        const launchd = getLaunchdServiceStatus({ controllerRoot: daemonRoot });
        return {
          ok: true,
          supported: Boolean(launchd.supported),
          daemon_running: Boolean(isDaemonRunning(daemonRoot)),
          daemon_pid: readDaemonPid(daemonRoot),
          daemon_state: daemonConnectionState,
          daemon_connected: daemonConnectionState === "connected",
          launchd,
        };
      }

      if (name === "daemon.service.install") {
        const res = installLaunchdService({
          controllerRoot: daemonRoot,
          isRunning: isDaemonRunning,
          stopDaemon: stopDaemonFn,
          dryRun: Boolean(payload.dryRun),
        });
        if (!res.ok) return res;
        if (!payload.dryRun) {
          daemonConnection.close();
          await new Promise((r) => setTimeout(r, 350));
          await daemonConnection.connect();
          controller.requestDaemonStatus();
        }
        const launchd = getLaunchdServiceStatus({ controllerRoot: daemonRoot });
        return {
          ok: true,
          supported: Boolean(launchd.supported),
          daemon_running: Boolean(isDaemonRunning(daemonRoot)),
          daemon_pid: readDaemonPid(daemonRoot),
          daemon_state: daemonConnectionState,
          daemon_connected: daemonConnectionState === "connected",
          launchd,
        };
      }

      if (name === "daemon.service.uninstall") {
        const res = uninstallLaunchdService({
          controllerRoot: daemonRoot,
          dryRun: Boolean(payload.dryRun),
        });
        if (!res.ok) return res;
        if (!payload.dryRun) {
          daemonConnection.close();
          if (!isDaemonRunning(daemonRoot)) {
            startDaemonFn(controllerRoot);
            await new Promise((r) => setTimeout(r, 400));
          }
          await daemonConnection.connect();
          controller.requestDaemonStatus();
        }
        const launchd = getLaunchdServiceStatus({ controllerRoot: daemonRoot });
        return {
          ok: true,
          supported: Boolean(launchd.supported),
          daemon_running: Boolean(isDaemonRunning(daemonRoot)),
          daemon_pid: readDaemonPid(daemonRoot),
          daemon_state: daemonConnectionState,
          daemon_connected: daemonConnectionState === "connected",
          launchd,
        };
      }

      if (name === "daemon.restart") {
        const launchdBefore = getLaunchdServiceStatus({ controllerRoot: daemonRoot });
        if (launchdBefore.loaded && process.platform === "darwin") {
          daemonConnection.close();
          const kick = restartLaunchdService({ controllerRoot: daemonRoot });
          await new Promise((r) => setTimeout(r, 450));
          await daemonConnection.connect();
          controller.requestDaemonStatus();
          const launchdAfter = getLaunchdServiceStatus({ controllerRoot: daemonRoot });
          return {
            ok: Boolean(kick.ok),
            via: "launchd",
            error: kick.error || undefined,
            daemon_running: Boolean(isDaemonRunning(daemonRoot)),
            daemon_pid: readDaemonPid(daemonRoot),
            daemon_state: daemonConnectionState,
            daemon_connected: daemonConnectionState === "connected",
            launchd: launchdAfter,
          };
        }
        await daemonCoordinator.restart();
        const launchdAfter = getLaunchdServiceStatus({ controllerRoot: daemonRoot });
        return {
          ok: daemonConnectionState === "connected" || Boolean(isDaemonRunning(daemonRoot)),
          via: "coordinator",
          daemon_running: Boolean(isDaemonRunning(daemonRoot)),
          daemon_pid: readDaemonPid(daemonRoot),
          daemon_state: daemonConnectionState,
          daemon_connected: daemonConnectionState === "connected",
          launchd: launchdAfter,
        };
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
        const attachments = normalizeAttachmentList(payload.attachments || []);
        const forceSend = payload.force_send === true;
        if (stageTarget.kind === "worker_single" && stageTarget.agentId && !text.trimStart().startsWith("/")) {
          const workerId = stageTarget.agentId;
          if (!text.trim() && attachments.length === 0) return { ok: true, routed: "empty" };
          standaloneDrafts.set(workerId, { text: "", revision: (standaloneDrafts.get(workerId)?.revision || 0) + 1 });
          const existingBucket = queuedMessageBuckets.get(queueBucketKey(activeProjectRoot, "worker", workerId));
          const shouldQueue = !forceSend
            && isInternalChild(workerId)
            && !isWorkerWaitingReply(workerId)
            && (isWorkerBusy(workerId) || Boolean(existingBucket && existingBucket.items.length > 0));
          if (shouldQueue) {
            const queued = enqueueQueuedMessage(activeProjectRoot, "worker", workerId, text, attachments);
            publishStandaloneWorkerFrame(workerId);
            return { ok: true, routed: "queued", queued: true, queue_id: queued.id, agent_id: workerId };
          }
          if (forceSend && isInternalChild(workerId) && isWorkerBusy(workerId)) {
            const { cancelInternalTask } = require("../agents/internal/taskControl");
            await Promise.resolve(cancelInternalTask(activeProjectRoot, workerId)).catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 140));
          }
          dispatchWorkerMessageNow(workerId, text, attachments);
          return { ok: true, routed: "worker", agent_id: workerId };
        }

        const routing = resolveSubmittedInputTarget(
          payload,
          controller.session.targetAgent,
          (id) => controller.session.agents.includes(String(id || "").trim())
        );
        if (!routing.ok) return routing;
        controller.session.targetAgent = routing.target;
        const trimmedStart = text.trimStart();
        const atMentionMatch = trimmedStart.match(/^@([^\s]+)/);
        const isDirectAtMention = Boolean(atMentionMatch && controller.resolveAgentId(atMentionMatch[1]));
        const isMainChatTurn = !routing.target
          && !trimmedStart.startsWith("/")
          && !trimmedStart.startsWith("!")
          && !isDirectAtMention;
        const mainBucket = queuedMessageBuckets.get(queueBucketKey(activeProjectRoot, "main"));
        const shouldQueueMain = isMainChatTurn
          && (text.trim() || attachments.length > 0)
          && !forceSend
          && !getActivePendingInteraction()
          && !controller.session.pending?.disambiguate
          && (isMainBusy(activeProjectRoot) || Boolean(mainBucket && mainBucket.items.length > 0));
        if (shouldQueueMain) {
          const queued = enqueueQueuedMessage(activeProjectRoot, "main", "", text, attachments);
          return { ok: true, routed: "queued", queued: true, queue_id: queued.id };
        }
        if (isMainChatTurn && (text.trim() || attachments.length > 0)) {
          if (forceSend && isMainBusy(activeProjectRoot)) {
            const normRoot = safeCanonicalRoot(activeProjectRoot) || activeProjectRoot;
            const cancelRunId = String(activeMainTaskRunIdByRoot.get(normRoot) || "").trim();
            if (cancelRunId) {
              daemonSend({
                type: IPC_REQUEST_TYPES.AGENT_RUNTIME,
                operation: "cancel",
                task_run_id: cancelRunId,
              });
            }
            setMainBusyState(activeProjectRoot, false);
            publish("stream.done", { id: "cancel" });
            await new Promise((resolve) => setTimeout(resolve, 140));
          }
          setMainBusyState(activeProjectRoot, true);
          publish("status.set", { text: "Thinking…", busy: true });
        }
        const beforeSubmit = mainSubmissionRev;
        await controller.submitInput(text, { attachments });
        if (!routing.target && beforeSubmit === mainSubmissionRev) {
          setMainBusyState(activeProjectRoot, false);
          publish("status.set", { text: "ready", busy: false });
        }
        return { ok: true, routed: (text.trim() || attachments.length > 0) ? "submit" : "empty" };
      }

      return { ok: false, error: `Unsupported command: ${name}` };
  };

  hostRef = host;
  await host.listen();

  const mainRuntimeToolSummaries = new Map();
  const router = createDaemonMessageRouter({
    escapeBlessed: (v) => String(v || ""),
    resolveAgentDisplayName: getAgentLabel,
    stripBlessedTags: stripTags,
    suppressLifecycleLog: true,
    isOwnRequestId: (id) => ownRequestIds.has(id),
    onRuntimeEvent: (event) => {
      if (!event || event.agentId !== "ufoo-agent") return;
      if (event.projectRoot && safeCanonicalRoot(event.projectRoot) !== safeCanonicalRoot(activeProjectRoot)) return;
      const type = String(event.type || "");
      const runId = String(event.taskRunId || "main");
      if (type === "request.accepted" || type === "task.started" || type === "model.started") {
        setMainBusyState(activeProjectRoot, true, event.taskRunId || undefined);
        publish("status.set", { text: "Thinking…", busy: true });
        return;
      }
      if (type === "model.phase") {
        const phaseText = statusForAgentPhase(event.phase || {});
        if (phaseText) publish("status.set", { text: phaseText, busy: true });
        return;
      }
      if (type === "thinking.delta" && event.text) {
        publish("thinking.delta", {
          id: `main-thinking-${runId}`,
          text: String(event.text),
        });
        publish("status.set", { text: "Thinking…", busy: true });
        return;
      }
      if (type === "tool.started") {
        const callId = String(event.toolCallId || `${runId}-${Date.now()}`);
        const name = String(event.toolName || "tool");
        const summary = String(event.toolSummary || `• ${fmt.formatToolDisplayName(name)}`);
        mainRuntimeToolSummaries.set(callId, summary);
        if (mainRuntimeToolSummaries.size > 200) {
          mainRuntimeToolSummaries.delete(mainRuntimeToolSummaries.keys().next().value);
        }
        publish("tool.start", {
          id: `main-tool-${callId}`,
          tool_name: name,
          tool_status: "running",
          summary,
        });
        publish("status.set", { text: toolStatus(name), busy: true });
        return;
      }
      if (type === "tool.completed" || type === "tool.failed" || type === "tool.rejected") {
        const callId = String(event.toolCallId || "");
        const name = String(event.toolName || "tool");
        const baseSummary = mainRuntimeToolSummaries.get(callId) || `• ${fmt.formatToolDisplayName(name)}`;
        const isError = type !== "tool.completed" || event.result?.ok === false;
        const summary = isError && !baseSummary.startsWith("• Failed: ")
          ? baseSummary.replace(/^• /, "• Failed: ")
          : baseSummary;
        const errorDetail = String(event.error || event.result?.error || "").trim();
        publish("tool.result", {
          id: `main-tool-${callId || `${runId}-${Date.now()}`}`,
          tool_name: name,
          tool_status: isError ? "error" : "done",
          summary,
          ...(errorDetail ? { detail: errorDetail } : {}),
        });
        publish("status.set", { text: "Thinking…", busy: true });
        return;
      }
      if (["task.completed", "task.failed", "task.cancelled", "task.paused", "task.interrupted"].includes(type)) {
        setMainBusyState(activeProjectRoot, false);
        publish("status.set", {
          text: type === "task.paused" ? "Waiting for reply…" : "ready",
          busy: false,
        });
        if (type === "task.completed") {
          scheduleDrainMainQueue(activeProjectRoot);
        }
      }
    },
    onInteractionRequest: (interaction) => {
      if (!enqueuePendingInteraction(interaction)) return;
      publishProjectsTree();
      if (globalScope === "project") {
        try {
          publish("workspace.context.snapshot", handleWorkspaceContext(activeProjectRoot, { operation: "snapshot" }));
        } catch {
          // ignore background refresh error
        }
      }
    },
    onInteractionClear: (info) => {
      const removed = removePendingInteraction(
        { id: info?.id || "", taskRunId: info?.taskRunId || "" },
        { markDismissed: Boolean(info?.id) }
      );
      if (removed) publishProjectsTree();
    },
    onInteractionsSync: (liveInteractions) => {
      reconcilePendingInteractions(liveInteractions);
    },
    logMessage: (kind, text) => {
      const normalized = kind === "error" ? "error"
        : kind === "user" ? "user"
          : (kind === "assistant" || kind === "reply") ? "assistant"
            : "system";
      appendLocal(normalized, stripTags(text));
    },
    renderScreen: () => {},
    updateDashboard: (data) => {
      const statusRoot = data && (data.projectRoot || data.project_root);
      const normStatusRoot = statusRoot ? safeCanonicalRoot(statusRoot) : "";
      const normActiveRoot = safeCanonicalRoot(activeProjectRoot);
      if (normStatusRoot && normStatusRoot !== normActiveRoot) return;
      activeStatusSyncedRoot = normActiveRoot;
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
      publishWorkflowSnapshot();
      if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
        publishStandaloneWorkerFrame(stageTarget.agentId);
      }
      const normRoot = safeCanonicalRoot(activeProjectRoot) || activeProjectRoot;
      const workerPrefix = `${normRoot}::worker::`;
      for (const [qKey, bucket] of queuedMessageBuckets.entries()) {
        if (!qKey.startsWith(workerPrefix) || bucket.paused || bucket.items.length === 0) continue;
        const wId = qKey.slice(workerPrefix.length);
        if (wId && !isWorkerBusy(wId) && !isWorkerWaitingReply(wId)) {
          scheduleDrainWorkerQueue(activeProjectRoot, wId);
        }
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
  routerRef = router;

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
        const normMsgRoot = root ? safeCanonicalRoot(root) : "";
        const normActive = safeCanonicalRoot(activeProjectRoot);
        if (normMsgRoot && normMsgRoot !== normActive) {
          if (pendingSwitchRoot && typeof msg.data?.phase !== "string" && normMsgRoot === safeCanonicalRoot(pendingSwitchRoot)) {
            pendingSwitchStatus = { root: normMsgRoot, data: msg.data };
          }
          return;
        }
      }
      if (msg.type === IPC_RESPONSE_TYPES.BUS) {
        const busEvt = msg.data || {};
        if (
          globalScope === "project"
          && (busEvt.event === "message" || (!busEvt.event && busEvt.data?.message))
          && busEvt.publisher
          && busEvt.target
          && busEvt.target !== "*"
          && busEvt.publisher !== busEvt.target
        ) {
          publish("workflow.pulse", {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            from: String(busEvt.publisher),
            to: String(busEvt.target),
            edge_id: String(busEvt.data?.workflow_edge_id || ""),
            group_id: String(busEvt.data?.workflow_group_id || ""),
            preview: String(busEvt.data?.message || "").slice(0, 80),
            ts: Date.now(),
          });
        }
        if (stageTarget.kind === "worker_single" && stageTarget.agentId) {
          const evtData = msg.data || {};
          if (evtData.event === "agent_surface" && evtData.publisher === stageTarget.agentId) {
            if (acceptStandaloneSurfaceEvent(stageTarget.agentId, evtData.data?.surface, evtData.seq)) {
              publishStandaloneWorkerFrame(stageTarget.agentId);
            }
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
        if (msg.data?.event === "agent_surface") {
          if (msg.data?.data?.surface?.type === "task_completed" && msg.data?.publisher) {
            scheduleDrainWorkerQueue(activeProjectRoot, String(msg.data.publisher));
          }
          return;
        }
        if (busEvt.event === "activity_state_changed") {
          const actAgent = String(busEvt.subscriber || busEvt.publisher || "").trim();
          const actState = String(busEvt.state || busEvt.activity_state || "").trim().toLowerCase();
          if (actAgent && (actState === "idle" || actState === "ready")) {
            scheduleDrainWorkerQueue(activeProjectRoot, actAgent);
          }
        }
        const busSource = String(busEvt.source || busEvt.data?.source || "").trim();
        // Direct UI submissions to a worker pane (or @agent sends from main chat)
        // belong to the user bubble / worker surface — never echo them back as a
        // duplicate "ufoo · ..." bubble in the main ufoo transcript.
        if ([
          "ufoo-desktop",
          "ufoo-desktop-worker",
          "ufoo-desktop-handoff",
          "rust-multi-window",
          "chat-internal-agent-view",
          "chat-direct",
          "chat-agent-view",
        ].includes(busSource)) {
          return;
        }
        // Internal worker stream chunks are rendered cleanly on the worker's own
        // surface; do not leak raw "\nTool: ..." stream deltas into ufoo main chat.
        if (busEvt.publisher && isInternalChild(busEvt.publisher)) {
          const rawMsg = typeof busEvt.message === "string"
            ? busEvt.message
            : (typeof busEvt.data?.message === "string" ? busEvt.data.message : "");
          if (rawMsg && rawMsg.trimStart().startsWith("{")) {
            try {
              const parsed = JSON.parse(rawMsg);
              if (parsed && parsed.stream) return;
            } catch {
              // not a stream envelope
            }
          }
        }
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
    logMessage: (_kind, text) => publish("status.set", { text: stripTags(text || "ready"), busy: false }),
    onConnectionStateChange: (nextState) => {
      daemonConnectionState = nextState;
      publish("host.connection", {
        source: "daemon",
        state: nextState,
        connected: nextState === "connected",
      });
    },
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
    logMessage: (_kind, text) => publish("status.set", { text: stripTags(text || "ready"), busy: false }),
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

  if (options.enableRemoteBridge !== false) {
    remoteBridge = createRemoteRelayBridge({
      remoteDir: options.remoteDir,
      deviceName: options.remoteDeviceName || "",
      dispatchCommand: (env) => commandHandlerRef(env),
      buildInitialEnvelopes: buildInitialClientEnvelopes,
      nextSeq: () => host.nextSeq(),
      rtcPeerConnectionFactory: options.rtcPeerConnectionFactory || null,
      onStatusChange: (status) => {
        publish("remote.status", status);
      },
    });
    if (options.remoteRelayUrl && options.enableRemote !== false) {
      await remoteBridge.enable({
        relay_url: options.remoteRelayUrl,
        ...(options.remoteWebBaseUrl ? { web_base_url: options.remoteWebBaseUrl } : {}),
        ...(options.remoteAuthToken ? { auth_token: options.remoteAuthToken } : {}),
        allow_insecure_ws: options.remoteAllowInsecureWs !== false,
      });
    } else {
      await remoteBridge.startIfEnabled().catch(() => {});
    }
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
    for (const timer of queueDrainTimers.values()) clearTimeout(timer);
    queueDrainTimers.clear();
    if (remoteBridge) await remoteBridge.close().catch(() => {});
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
    remoteBridge,
    getActiveProjectRoot: () => activeProjectRoot,
    getStageTarget: () => ({ ...stageTarget }),
    applyIncomingHandoff,
    close,
  };
}

module.exports = {
  startDesktopUiHost,
  rawHistoryToEntries,
  buildProjectSpeakerIndex,
  sanitizeUiActivityDetail,
  inspectDormantProjectSummary,
};
