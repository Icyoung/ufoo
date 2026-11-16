"use strict";

/**
 * Phase 4 Rust ucode host: Node owns runner/session; ufoo-tui owns TTY.
 * Opt-in via UFOO_TUI=rust or UFOO_TUI_UCODE_RUST=1.
 */

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { createUiHostServer, createAuthToken } = require("./uiHostServer");
const { resolveTuiLaunchPlan } = require("./tuiLauncher");
const { createToolMergePublisher } = require("./toolMergeBridge");
const {
  createUcodeController,
  createThinkingStatusPublisher,
} = require("../code/UcodeController");
const { createEnvelope, encodeMessage } = require("../runtime/contracts/uiProtocol");
const fmt = require("./format");
const { createAgentSurface, projectSurfaceEvent } = require("./agentSurface");
const { buildPlanSetPayload, statusForAgentPhase } = require("./agentPresentation");
const { countRunningBackgroundProcesses } = require("../code/tools/bash");
const PACKAGE_VERSION = require("../../package.json").version;

function stripTags(value) {
  return String(value || "").replace(/\{[^}]+\}/g, "");
}

function buildUcodeAgentsSnapshot(workspaceRoot, selfSubscriberId = "") {
  const list = fmt.filterSelectableAgents(
    fmt.loadActiveAgents(workspaceRoot),
    selfSubscriberId
  );
  const metadata = require("../coordination/state/agentsStore").loadAgentsData(require("../coordination/state/paths").getUfooPaths(workspaceRoot).agentsFile).agents || {};
  const agents = list.map((agent) => {
    const id = String((agent && (agent.fullId || agent.id)) || "").trim();
    const label = String(
      (agent && (agent.nickname || agent.fullId || agent.id)) || id
    ).trim() || id;
    return {
      id,
      label,
      internal: require("../runtime/contracts/agentMode").isInternalAgentMeta(metadata[id]),
      activity_state: String((agent && agent.status) || ""),
    };
  }).filter((agent) => agent.id);
  const labels = agents.map((agent) => agent.label).filter(Boolean);
  const footer = labels.length === 0
    ? "Agents: none"
    : labels.length <= 4
      ? `Agents: ${labels.join(" · ")}`
      : `Agents: ${labels.slice(0, 3).join(" · ")} +${labels.length - 3}`;
  return { agents, footer };
}

/**
 * Build ucode completion rows for the Rust TUI host.
 * Passes live agents for `@` and optional remote `/model` catalog.
 */
async function buildUcodeCompletionItems({
  text = "",
  workspaceRoot = process.cwd(),
  state = {},
  selfSubscriberId = "",
  remoteModels = [],
  limit = 20,
} = {}) {
  const { UCODE_COMMAND_REGISTRY, UCODE_COMMAND_TREE } = require("../code/commands");
  const { listSessionSummaries } = require("../code/sessionStore");
  const {
    suggestUcodeModels,
    suggestUcodeThinkingLevels,
  } = require("../code/modelCommand");
  let resumeSessions = [];
  try {
    resumeSessions = listSessionSummaries(workspaceRoot, { limit: 40 });
  } catch {
    resumeSessions = [];
  }
  const agentsSnap = buildUcodeAgentsSnapshot(workspaceRoot, selfSubscriberId);
  const agents = agentsSnap.agents.map((agent) => agent.id);
  const agentLabels = agentsSnap.agents.map((agent) => agent.label || agent.id);
  return fmt.buildCompletions({
    text: String(text || ""),
    agents,
    agentLabels,
    commands: UCODE_COMMAND_REGISTRY,
    commandTree: UCODE_COMMAND_TREE,
    argumentLists: {
      "/resume": resumeSessions,
      "/model": suggestUcodeModels(state || {}, {
        models: Array.isArray(remoteModels) ? remoteModels : [],
      }),
      "/model/thinking": suggestUcodeThinkingLevels(state || {}),
    },
    limit,
  });
}


function normalizeToolLogEntry(entry = {}) {
  const tool = String(entry.tool || "").trim().toLowerCase();
  if (!tool) return null;
  const resObj = entry.result && typeof entry.result === "object" ? entry.result : {};
  const phase = String(entry.phase || "").trim().toLowerCase();
  const isError = phase === "error" || resObj.ok === false;
  const detail = fmt.normalizeToolLogDetail(tool, entry.args, resObj);
  const errorText = String(entry.error || resObj.error || "").trim();
  return fmt.normalizeToolMergeEntry({ tool, detail, isError, errorText });
}

function splitUcodeBannerRow(line, index) {
  const row = String(line || "");
  const logo = String((fmt.UCODE_BANNER_LINES || [])[index] || "");
  if (logo && row.startsWith(logo)) {
    return { logo, metadata: row.slice(logo.length).trimStart() };
  }
  return { logo: "", metadata: row.trimStart() };
}

/**
 * Keep a model's reasoning in one mutable scrollback entry. The TUI owns the
 * collapsed/expanded presentation; the host only sends an initial row plus
 * append-only deltas for that row.
 */
function createThinkingLogPublisher(publish, thinkingStatus, streamId) {
  const id = `${String(streamId || "stream")}-thinking`;
  let started = false;

  function onThinkingDelta(delta) {
    const text = String(delta || "");
    if (!text) return;
    if (!started) {
      started = true;
      publish("thinking.start", { id });
    }
    publish("thinking.delta", { id, text });
    if (thinkingStatus && typeof thinkingStatus.onThinkingDelta === "function") {
      thinkingStatus.onThinkingDelta(text);
    }
  }

  function stop() {
    if (thinkingStatus && typeof thinkingStatus.reset === "function") {
      thinkingStatus.reset();
    }
  }

  return { id, onThinkingDelta, stop };
}

function createLeadingWhitespaceNormalizer() {
  let hasVisibleText = false;
  return (delta) => {
    const text = String(delta || "");
    if (hasVisibleText || !text) return text;
    const visible = text.replace(/^\s+/u, "");
    if (!visible) return "";
    hasVisibleText = true;
    return visible;
  };
}

/**
 * Keep a single assistant bubble and a single accumulating tool group per user
 * prompt. When a new model step emits commentary after tool calls or thinking,
 * replace the bubble text in-place so only the latest message is shown above
 * the accumulating tool tree.
 */
function createSegmentedStreamSession({
  baseId = "stream",
  publish,
  tools = null,
  thinking = null,
  onToolEntry = null,
} = {}) {
  const currentId = String(baseId || "stream");
  let replaceOnNextDelta = false;
  let hasStreamedAnyText = false;
  let responseStarted = false;
  const thinkingLog = createThinkingLogPublisher(publish, thinking, currentId);
  let normalizeStreamDelta = createLeadingWhitespaceNormalizer();

  if (tools && typeof tools.beginScope === "function") tools.beginScope();
  if (thinking && typeof thinking.reset === "function") thinking.reset();
  publish("stream.start", { id: currentId });

  function beginResponse() {
    if (responseStarted) return;
    responseStarted = true;
    thinkingLog.stop();
    publish("status.set", { text: "Generating response…", busy: true });
  }

  function onTextPhase(event = {}) {
    if (String(event.text || "").trim()) {
      beginResponse();
    }
  }

  function onDelta(delta) {
    if (replaceOnNextDelta) {
      const freshNormalizer = createLeadingWhitespaceNormalizer();
      const visibleDelta = freshNormalizer(delta);
      if (!visibleDelta) return;
      normalizeStreamDelta = freshNormalizer;
      replaceOnNextDelta = false;
      hasStreamedAnyText = true;
      beginResponse();
      publish("stream.delta", { id: currentId, text: visibleDelta, reset: true, aboveTools: true });
      return;
    }
    const visibleDelta = normalizeStreamDelta(delta);
    if (!visibleDelta) return;
    hasStreamedAnyText = true;
    beginResponse();
    publish("stream.delta", { id: currentId, text: visibleDelta, aboveTools: true });
  }

  function onThinkingDelta(delta) {
    if (hasStreamedAnyText) {
      replaceOnNextDelta = true;
    }
    if (!responseStarted) thinkingLog.onThinkingDelta(delta);
  }

  function onToolLog(entry) {
    if (!entry || typeof entry !== "object") return;
    thinkingLog.stop();
    if (hasStreamedAnyText) {
      replaceOnNextDelta = true;
    }
    if (typeof onToolEntry === "function") onToolEntry(entry);
  }

  function finish() {
    if (tools && typeof tools.flush === "function") tools.flush();
    thinkingLog.stop();
    publish("stream.done", { id: currentId });
  }

  return {
    get currentId() { return currentId; },
    beginResponse,
    onTextPhase,
    onDelta,
    onThinkingDelta,
    onToolLog,
    finish,
  };
}

function appendNaturalLanguageResult(nlResult, formatNlResult, appendLog) {
  if (typeof formatNlResult !== "function" || typeof appendLog !== "function" || !nlResult) {
    return false;
  }
  // Successful streamed text is already present in the mutable stream entry.
  // Appending summary + formatted summary here duplicated the same answer.
  if (nlResult.ok !== false && nlResult.streamed) return false;
  const formatted = String(formatNlResult(nlResult) || "").trim();
  if (!formatted) return false;
  appendLog(formatted, nlResult.ok === false ? "error" : "assistant");
  return true;
}

async function runUcodeRust(props = {}) {
  const plan = resolveTuiLaunchPlan({
    mode: props.tuiMode || process.env.UFOO_TUI || "rust",
    requireRust: true,
    surface: "ucode",
  });
  if (plan.mode !== "rust" || !plan.binary) {
    const err = new Error(`Rust TUI unavailable (${plan.reason || "unknown"})`);
    err.code = "UFOO_TUI_UNAVAILABLE";
    err.plan = plan;
    throw err;
  }

  const workspaceRoot = props.workspaceRoot || process.cwd();
  const uiSocketPath = path.join(
    os.tmpdir(),
    `ufoo-ui-ucode-${process.pid}-${Date.now()}.sock`
  );
  const uiAuthToken = createAuthToken();

  let hostRef = null;
  let entrySeq = 0;
  let autoBusTimer = null;
  let agentsTimer = null;
  let autoBusQueued = false;
  let autoBusError = "";
  let closing = false;
  let pendingAttachments = [];
  let markdownState = { inCodeBlock: false };
  let remoteModels = [];
  let remoteModelsCacheKey = "";
  let remoteModelsInflight = null;
  const backgroundTasks = new Map();
  let backgroundSeq = 0;
  let requestExit = false;
  let clientReady = false;
  const MARKDOWN_LOG_KINDS = new Set(["assistant", "error"]);
  const surface = createAgentSurface({ maxEntries: 4000 });
  const controller = createUcodeController({
    projectRoot: workspaceRoot,
    ports: {
      onQueueChange: (snapshot) => publish("task.queue", snapshot),
    },
  });

  function publish(name, payload) {
    const projected = projectSurfaceEvent(surface, name, payload);
    if (!hostRef) return;
    hostRef.broadcast(hostRef.createEvent(projected.name, projected.payload, {
      surface: "ucode",
      project_id: workspaceRoot,
    }));
  }

  const agentSession = require("./ucodeAgentSession").createUcodeAgentSession({
    projectRoot: workspaceRoot,
    getSubscriber: () => String(props.autoBus?.subscriberId || process.env.UFOO_SUBSCRIBER_ID || "").trim(),
    publish,
  });

  function publishAgents() {
    const selfSubscriberId = String(
      (props.autoBus && props.autoBus.subscriberId)
      || process.env.UFOO_SUBSCRIBER_ID
      || ""
    ).trim();
    const snapshot = buildUcodeAgentsSnapshot(workspaceRoot, selfSubscriberId);
    publish("agents.snapshot", snapshot);
    agentSession.refresh();
    return snapshot;
  }

  function remoteModelsKey() {
    const provider = String((props.state && props.state.provider) || "").trim();
    const model = String((props.state && props.state.model) || "").trim();
    return `${workspaceRoot}|${provider}|${model}`;
  }

  async function ensureRemoteModels() {
    const key = remoteModelsKey();
    if (remoteModelsCacheKey === key && remoteModels.length > 0) {
      return remoteModels;
    }
    if (remoteModelsInflight && remoteModelsCacheKey === key) {
      return remoteModelsInflight;
    }
    remoteModelsCacheKey = key;
    const { listUcodeModels } = require("../code/modelCommand");
    remoteModelsInflight = (async () => {
      try {
        const listed = await listUcodeModels(props.state || {}, { workspaceRoot });
        if (listed && listed.ok) {
          remoteModels = Array.isArray(listed.models) ? listed.models : [];
        }
      } catch {
        // keep prior cache on network/provider errors
      } finally {
        remoteModelsInflight = null;
      }
      return remoteModels;
    })();
    return remoteModelsInflight;
  }

  const tools = createToolMergePublisher((name, payload) => publish(name, payload));
  const thinking = createThinkingStatusPublisher(publish);

  function getBackgroundSuffix() {
    let running = countRunningBackgroundProcesses({ workspaceRoot });
    let done = 0;
    let failed = 0;
    for (const task of backgroundTasks.values()) {
      if (!task || typeof task !== "object") continue;
      if (task.status === "running") running += 1;
      else if (task.status === "done") done += 1;
      else if (task.status === "failed") failed += 1;
    }
    const parts = [];
    if (running) parts.push(`${running} running`);
    if (done) parts.push(`${done} done`);
    if (failed) parts.push(`${failed} failed`);
    return parts.length ? ` · BG ${parts.join("/")}` : "";
  }

  function publishStatus(text = "ready", busy = false) {
    const planPayload = buildPlanSetPayload(props.state && props.state.executionState, {});
    const idleHint = !busy && text === "ready"
      ? String(planPayload.idle_hint || "").trim()
      : "";
    const base = idleHint ? `ready · ${idleHint}` : text;
    publish("status.set", {
      text: `${base}${getBackgroundSuffix()}`,
      busy: Boolean(busy),
    });
  }

  function formatQueueSnapshot(snapshot = controller.getQueueSnapshot()) {
    const active = snapshot && snapshot.active;
    const queued = Array.isArray(snapshot && snapshot.queued) ? snapshot.queued : [];
    const activeText = active
      ? `active #${active.id} ${active.label || active.kind || "task"}`
      : "active none";
    const lines = [`Queue: ${activeText} · pending ${queued.length}`];
    for (const task of queued.slice(0, 8)) {
      lines.push(`  ${task.position}. #${task.id} ${task.label || task.kind || "task"}`);
    }
    if (queued.length > 8) lines.push(`  … ${queued.length - 8} more`);
    return lines.join("\n");
  }

  function publishPlan(activityMessage = "") {
    const payload = buildPlanSetPayload(props.state && props.state.executionState, {
      activityMessage,
    });
    publish("plan.set", payload);
    return payload;
  }

  function ingestToolLog(entry) {
    if (!entry || typeof entry !== "object") return;
    const normalized = normalizeToolLogEntry(entry);
    if (normalized) tools.pushTool(normalized);
    if (
      entry.tool === "plan_graph"
      || entry.tool === "task_run"
      || entry.phase === "end"
      || entry.phase === "result"
    ) {
      publishPlan();
    }
  }

  function appendLog(text, kind = "assistant") {
    const raw = String(text == null ? "" : text);
    let lines = [raw];
    if (MARKDOWN_LOG_KINDS.has(kind)) {
      try {
        const rendered = fmt.renderLogLinesWithMarkdownAnsi(raw, markdownState);
        if (Array.isArray(rendered) && rendered.length > 0) {
          lines = rendered.map((line) => String(line || ""));
        }
      } catch {
        lines = raw.split(/\r?\n/);
      }
    } else {
      lines = raw.split(/\r?\n/);
    }
    const block = lines.map((line) => String(line || "")).join("\n");
    entrySeq += 1;
    const entry = {
      id: `u-${entrySeq}`,
      kind,
      text: stripTags(block),
      // Keep ANSI in a parallel field if strip removes styling; prefer the
      // rendered block for Rust when it contains escape sequences.
      ansi: block,
      speaker: "",
    };
    if (/\x1b\[/.test(block)) {
      entry.text = block;
    }
    publish("transcript.append", entry);
    return entry;
  }

  function replaceTranscript(entries = []) {
    markdownState = { inCodeBlock: false };
    const normalized = (Array.isArray(entries) ? entries : []).map((entry, idx) => {
      const text = String((entry && entry.text) || "");
      return {
        id: String((entry && entry.id) || `r-${idx}`),
        kind: String((entry && entry.kind) || "system"),
        text,
        speaker: String((entry && entry.speaker) || ""),
        detail: String((entry && entry.detail) || ""),
        expanded: Boolean(entry && entry.expanded),
      };
    });
    entrySeq = Math.max(entrySeq, normalized.length);
    publish("transcript.reset", { entries: normalized });
    tools.reset && tools.reset();
  }

  function publishUsageFromResult(result) {
    const meter = (result && result.contextMeter)
      || (props.state && props.state.contextMeter)
      || null;
    const label = String((meter && meter.label) || "").trim();
    if (label) {
      if (props.state) props.state.contextMeter = meter;
      publish("usage.set", { text: label, label });
    }
  }

  function clearAttachments() {
    pendingAttachments = [];
    publish("attachments.set", { count: 0, labels: [] });
  }

  function handlePasteCommand(payload = {}) {
    const {
      handleImagePaste,
      formatImageLogLabel,
    } = require("../code/imageIngest");
    const outcome = handleImagePaste(String(payload.text || ""), {
      workspaceRoot,
      sessionId: (props.state && props.state.sessionId) || "",
      tryClipboard: true,
    });
    if (Array.isArray(outcome.attachments) && outcome.attachments.length > 0) {
      for (const item of outcome.attachments) {
        if (!item || typeof item !== "object") continue;
        const relPath = String(item.relPath || "").trim();
        if (relPath && pendingAttachments.some((existing) => existing && existing.relPath === relPath)) {
          continue;
        }
        pendingAttachments.push(item);
      }
    }
    if (Array.isArray(outcome.errors) && outcome.errors.length > 0 && pendingAttachments.length === 0) {
      appendLog(`Image paste: ${outcome.errors[0]}`, "system");
    }
    const labels = pendingAttachments.map((item, index) => formatImageLogLabel(item, index));
    publish("attachments.set", {
      count: pendingAttachments.length,
      labels,
    });
    publish("prompt.apply_paste", { text: String(outcome.text || "") });
    return {
      ok: true,
      text: outcome.text || "",
      count: pendingAttachments.length,
    };
  }

  function composeSubmitText(rawText = "") {
    const {
      buildAttachedImagesPromptPrefix,
      formatUserLogWithAttachments,
    } = require("../code/imageIngest");
    const attachments = pendingAttachments.slice();
    const trimmed = String(rawText || "").trim();
    const modelText = `${buildAttachedImagesPromptPrefix(attachments)}${trimmed}`.trim();
    const logText = formatUserLogWithAttachments(trimmed, attachments) || trimmed;
    return { modelText, logText, attachments };
  }

  function persistIfNeeded() {
    if (typeof props.persistSessionState !== "function" || !props.state) return;
    try {
      const persisted = props.persistSessionState(props.state);
      if (persisted && persisted.ok === false) {
        appendLog(
          `Error: failed to persist session ${props.state.sessionId || ""}: ${persisted.error || "unknown"}`,
          "error"
        );
      }
    } catch (err) {
      appendLog(`Error: persist failed: ${err && err.message ? err.message : err}`, "error");
    }
  }

  const banner = fmt.buildUcodeBannerLines({
    model: (props.state && props.state.model) || process.env.UFOO_UCODE_MODEL || "",
    engine: (props.state && props.state.engine) || "ufoo-core",
    workspaceRoot,
    sessionId: (props.state && props.state.sessionId) || "",
    planMode: Boolean(
      props.state
      && props.state.executionState
      && props.state.executionState.planMode
    ),
  });

  surface.apply("transcript.reset", {
    entries: banner.map((line, idx) => {
      const { logo, metadata } = splitUcodeBannerRow(line, idx);
      return { id: `b-${idx}`, kind: "banner", text: logo, detail: metadata, speaker: "" };
    }).concat([{ id: `b-${banner.length}`, kind: "spacer", text: "", speaker: "" }]),
  });

  function buildSnapshot() {
    const meter = props.state && props.state.contextMeter;
    const view = surface.snapshot();
    const agentsSnap = buildUcodeAgentsSnapshot(
      workspaceRoot,
      String(
        (props.autoBus && props.autoBus.subscriberId)
        || process.env.UFOO_SUBSCRIBER_ID
        || ""
      ).trim()
    );
    return {
      status: view.status,
      busy: view.busy,
      package_version: PACKAGE_VERSION,
      footer: agentsSnap.footer,
      entries: view.entries,
      input_history: [],
      agents: agentsSnap.agents,
      attachment_count: pendingAttachments.length,
      usage: String((meter && meter.label) || view.usage || ""),
      task_queue: controller.getQueueSnapshot(),
      window: agentSession.getSnapshot(),
    };
  }

  function publishPendingInteraction() {
    try {
      const {
        hasPendingUserInteraction,
        getPendingUserInteraction,
        formatInteractionPromptLines,
      } = require("../code/context/userInteraction");
      if (!props.state || !hasPendingUserInteraction(props.state.executionState)) {
        return false;
      }
      const pending = getPendingUserInteraction(props.state.executionState);
      const lines = formatInteractionPromptLines(pending, { cols: 80 });
      publish("interaction.request", {
        id: String((pending && pending.id) || "ask"),
        kind: String((pending && pending.kind) || "ask_user"),
        prompt: String((pending && pending.prompt) || "Input required"),
        options: Array.isArray(pending && pending.options)
          ? pending.options.map((opt) => ({
            key: String((opt && opt.key) || ""),
            label: String((opt && opt.label) || ""),
          }))
          : [],
        allow_free_chat: pending ? pending.allowFreeChat !== false : true,
        lines: Array.isArray(lines) ? lines.map((line) => stripTags(line)) : [],
      });
      publish("status.set", { text: "waiting for reply…", busy: false });
      return true;
    } catch {
      return false;
    }
  }

  async function resumeInteraction(answerText, meta = {}) {
    return controller.runExclusive(async (abort) => {
      const submit = typeof props.submitUserInteractionAnswer === "function"
        ? props.submitUserInteractionAnswer
        : require("../code/protocol").submitUserInteractionAnswer;
      const streamSession = createSegmentedStreamSession({
        baseId: `resume-${Date.now()}`,
        publish,
        tools,
        thinking,
        onToolEntry: ingestToolLog,
      });
      try {
        const result = await submit(answerText, props.state, {
          signal: abort.signal,
          onDelta: streamSession.onDelta,
          onThinkingDelta: streamSession.onThinkingDelta,
          onToolLog: streamSession.onToolLog,
        });
        streamSession.finish();
        if (!result || result.ok === false) {
          appendLog(`Error: ${(result && result.error) || "resume failed"}`, "error");
        } else if (result.shouldEchoSummary) {
          appendLog(result.echoSummaryText || result.summary || "", "assistant");
        }
        persistIfNeeded();
        publishPlan();
        publishUsageFromResult(result);
        if (publishPendingInteraction()) {
          controller.pauseQueue("waiting for reply");
          return { ok: true, waiting: true };
        }
        controller.resumeQueue();
        return { ok: true, waiting: false };
      } catch (err) {
        streamSession.finish();
        if (abort.signal.aborted) {
          appendLog("Task cancelled.", "system");
          return { ok: false, cancelled: true };
        }
        appendLog(`Error: ${err && err.message ? err.message : err}`, "error");
        return { ok: false };
      }
    }, {
      kind: "interaction",
      label: "reply",
      priority: meta.priority === true,
    });
  }

  async function runNaturalLanguage(text, meta = {}) {
    const label = String(meta.label || text || "prompt").trim().replace(/\s+/g, " ");
    return controller.runExclusive(async (abort) => {
      if (meta.runtimeEvent) {
        const { hasPendingUserInteraction } = require("../code/context/userInteraction");
        if (hasPendingUserInteraction(props.state.executionState) || !meta.claim()) return false;
      }
      if (typeof props.runNaturalLanguageTask !== "function") {
        appendLog("runNaturalLanguageTask unavailable", "error");
        return { ok: false };
      }
      const streamSession = createSegmentedStreamSession({
        baseId: `nl-${Date.now()}`,
        publish,
        tools,
        thinking,
        onToolEntry: ingestToolLog,
      });
      try {
        const nlResult = await props.runNaturalLanguageTask(text, props.state, {
          ...(meta.runtimeEvent ? { runtimeContext: { requestKind: "system_wake", parentTaskRunId: meta.runtimeEvent.ownerTaskRunId } } : {}),
          signal: abort.signal,
          onDelta: streamSession.onDelta,
          onThinkingDelta: streamSession.onThinkingDelta,
          onToolLog: streamSession.onToolLog,
          onPhase: (event) => {
            if (!event || typeof event !== "object") return;
            if (event.type === "text_delta") streamSession.onTextPhase(event);
            else {
              const text = statusForAgentPhase(event);
              if (text) publish("status.set", { text, busy: true });
            }
          },
        });
        streamSession.finish();
        appendNaturalLanguageResult(nlResult, props.formatNlResult, appendLog);
        persistIfNeeded();
        publishPlan();
        publishUsageFromResult(nlResult);
        if (publishPendingInteraction()) {
          controller.pauseQueue("waiting for reply");
          return { ok: true, waiting: true };
        }
        controller.resumeQueue();
        return { ok: true, waiting: false, result: nlResult };
      } catch (err) {
        streamSession.finish();
        if (abort.signal.aborted) {
          appendLog("Task cancelled.", "system");
          return { ok: false, cancelled: true };
        }
        appendLog(`Error: ${err && err.message ? err.message : err}`, "error");
        return { ok: false };
      }
    }, {
      kind: String(meta.kind || "prompt").trim() || "prompt",
      label: label.length > 80 ? `${label.slice(0, 77)}…` : label,
      promptText: String(text || ""),
    });
  }

  async function runAutoBusOnce() {
    const autoBus = props.autoBus || {};
    if (!autoBus.enabled || closing) return;
    const getPendingCount = typeof autoBus.getPendingCount === "function"
      ? autoBus.getPendingCount
      : () => 0;
    if (Number(getPendingCount()) <= 0) {
      autoBusError = "";
      return;
    }
    if (typeof props.runUbusCommand !== "function") return;

    await controller.runExclusive(async (abort) => {
      publish("status.set", { text: "Processing bus messages…", busy: true });
      try {
        const { extractAgentNickname } = require("../code/agent");
        const ubusResult = await props.runUbusCommand(props.state, {
          workspaceRoot,
          subscriberId: autoBus.subscriberId,
          signal: abort.signal,
          onMessageReceived: (msg) => {
            const nickname = extractAgentNickname(msg && msg.from) || (msg && msg.from) || "bus";
            appendLog(`${nickname}: ${(msg && msg.task) || ""}`, "bus");
            publish("status.set", { text: "Working on bus task…", busy: true });
          },
        });
        if (!ubusResult || !ubusResult.ok) {
          const nextError = String((ubusResult && ubusResult.error) || "ubus failed");
          if (nextError !== autoBusError) {
            autoBusError = nextError;
            appendLog(`Error: ${nextError}`, "error");
          }
          return;
        }
        autoBusError = "";
        const exchanges = Array.isArray(ubusResult.messageExchanges)
          ? ubusResult.messageExchanges
          : [];
        for (const exchange of exchanges) {
          const nickname = extractAgentNickname(exchange && exchange.from)
            || (exchange && exchange.from)
            || "bus";
          appendLog(`@${nickname} ${(exchange && exchange.reply) || ""}`, "bus");
        }
        if (Number(ubusResult.handled) > 0) persistIfNeeded();
        publishPlan();
      } finally {
        if (!publishPendingInteraction()) {
          publish("status.set", { text: "ready", busy: false });
        }
      }
    }, { kind: "bus", label: "bus messages" });
  }

  function scheduleAutoBus() {
    const autoBus = props.autoBus || {};
    if (!autoBus.enabled || closing || autoBusQueued || controller.isBusy()) return;
    const getPendingCount = typeof autoBus.getPendingCount === "function"
      ? autoBus.getPendingCount
      : () => 0;
    if (Number(getPendingCount()) <= 0) return;
    autoBusQueued = true;
    Promise.resolve()
      .then(() => runAutoBusOnce())
      .catch((err) => {
        appendLog(`Error: ${err && err.message ? err.message : "ubus failed"}`, "error");
      })
      .finally(() => {
        autoBusQueued = false;
      });
  }

  const host = createUiHostServer({
    socketPath: uiSocketPath,
    authToken: uiAuthToken,
    capabilities: ["ucode", "scrollback", "prompt", "interaction", "auto-bus", "window-modes-v1"],
    onClientReady(socket) {
      const snap = createEnvelope({
        kind: "snapshot",
        name: "app.snapshot",
        seq: host.nextSeq(),
        scope: { surface: "ucode", project_id: workspaceRoot },
        payload: buildSnapshot(),
      });
      socket.write(encodeMessage(snap));
      agentSession.publishFrames();
      publishPendingInteraction();
      publishPlan();
      ensureRemoteModels().catch(() => {});
      if (!clientReady) {
        clientReady = true;
        if (typeof props.onReady === "function") props.onReady();
      }
    },
    async onCommand(cmd) {
      const name = String(cmd.name || "");
      const payload = cmd.payload && typeof cmd.payload === "object" ? cmd.payload : {};

      if (name === "app.exit") {
        closing = true;
        controller.stop();
        return { ok: true };
      }
      if (name === "task.cancel") {
        controller.cancelTask("user");
        publish("status.set", { text: "cancelling…", busy: true });
        appendLog("• Cancellation requested. Stopping the current task...", "system");
        return { ok: true };
      }
      if (name === "completion.request") {
        const text = String(payload.text || "");
        if (/^\s*\/m/i.test(text)) {
          ensureRemoteModels().catch(() => {});
        }
        if (/^\s*\/model(\s|$)/i.test(text)) {
          await ensureRemoteModels();
        }
        const selfSubscriberId = String(
          (props.autoBus && props.autoBus.subscriberId)
          || process.env.UFOO_SUBSCRIBER_ID
          || ""
        ).trim();
        const items = await buildUcodeCompletionItems({
          text,
          workspaceRoot,
          state: props.state || {},
          selfSubscriberId,
          remoteModels,
          limit: Math.max(20, remoteModels.length + 1),
        });
        publish("completions.set", { items });
        return { ok: true, count: items.length };
      }
      if (name === "ui.resync.request") {
        publish("app.snapshot", buildSnapshot());
        agentSession.publishFrames();
        publishAgents();
        publishPlan();
        return { ok: true };
      }
      const agentCommand = await agentSession.handleCommand(name, payload);
      if (agentCommand) {
        if (name === "agent.close") {
          if (agentCommand.ok) publishAgents();
          else appendLog(agentCommand.error || "Agent close failed", "error");
        }
        return agentCommand;
      }
      if (name === "input.paste") {
        return handlePasteCommand(payload);
      }
      if (name === "queue.inject") {
        const rawText = String(payload.text || "");
        const { modelText, logText, attachments } = composeSubmitText(rawText);
        if (modelText || attachments.length > 0) {
          clearAttachments();
          appendLog(`› ${logText || rawText}`, "user");
        }
        const drained = typeof controller.drainQueuedPrompts === "function"
          ? controller.drainQueuedPrompts()
          : [];
        const texts = drained
          .map((item) => String((item && item.text) || "").trim())
          .filter(Boolean);
        if (modelText) texts.push(modelText);
        if (texts.length === 0) {
          return { ok: true, injected: 0 };
        }
        if (controller.isBusy()) {
          const { enqueueUserPrompt } = require("../code/context/userNudge");
          const { emptyExecutionState } = require("../code/context/executionSegment");
          if (props.state) {
            if (!props.state.executionState || typeof props.state.executionState !== "object") {
              props.state.executionState = emptyExecutionState();
            }
            for (const itemText of texts) {
              enqueueUserPrompt(props.state.executionState, itemText);
            }
          }
          publishStatus("injected into current turn…", true);
          return { ok: true, injected: texts.length };
        }
        publishStatus("working…", true);
        const combined = texts.join("\n\n");
        const result = await runNaturalLanguage(combined);
        if (result && result.waiting) {
          return { ok: true, routed: "ucode", waiting: true, injected: texts.length };
        }
        if (!controller.isBusy()) {
          publishStatus("ready", false);
        }
        return { ok: true, routed: "ucode", injected: texts.length };
      }
      if (name === "interaction.respond") {
        if (payload.cancelled) {
          appendLog("interaction cancelled", "system");
          publish("interaction.clear", {});
          controller.resumeQueue();
          publish("status.set", { text: "ready", busy: false });
          return { ok: true, cancelled: true };
        }
        publish("interaction.clear", {});
        const replyText = String(payload.text || "").trim();
        const replyLabel = String(payload.label || "").trim();
        if (replyLabel && replyText && replyLabel !== replyText) {
          appendLog(`› [${replyText}] ${replyLabel}`, "user");
        } else if (replyText) {
          appendLog(`› ${replyText}`, "user");
        }
        publish("status.set", { text: "applying reply…", busy: true });
        const resume = resumeInteraction(String(payload.text || ""), { priority: true });
        controller.resumeQueue();
        const result = await resume;
        if (!result.waiting) {
          publish("status.set", { text: "ready", busy: false });
        }
        return { ok: true, ...result };
      }
      if (name === "input.submit") {
        const rawText = String(payload.text || "");
        const { modelText, logText, attachments } = composeSubmitText(rawText);
        const agentResult = await agentSession.submit({ ...payload, text: modelText });
        if (agentResult) {
          if (agentResult.ok && agentResult.routed === "agent") {
            clearAttachments();
            appendLog(`› @${agentResult.agent_id} ${logText || rawText}`, "user");
          }
          if (!agentResult.ok) appendLog(agentResult.error, "error");
          return agentResult;
        }
        if (!modelText && attachments.length === 0) return { ok: true, empty: true };
        clearAttachments();

        try {
          const { hasPendingUserInteraction } = require("../code/context/userInteraction");
          if (props.state && hasPendingUserInteraction(props.state.executionState)) {
            appendLog(`› ${logText || rawText}`, "user");
            publishStatus("applying reply…", true);
            const resume = resumeInteraction(modelText || rawText, { priority: true });
            controller.resumeQueue();
            const result = await resume;
            if (!result.waiting) publishStatus("ready", false);
            return { ok: true, routed: "interaction" };
          }
        } catch {
          // fall through
        }

        const trimmedSubmit = String(rawText || "").trim();
        if (attachments.length === 0 && /^\/model$/i.test(trimmedSubmit)) {
          await ensureRemoteModels();
          const selfSubscriberId = String(
            (props.autoBus && props.autoBus.subscriberId)
            || process.env.UFOO_SUBSCRIBER_ID
            || ""
          ).trim();
          const items = await buildUcodeCompletionItems({
            text: "/model ",
            workspaceRoot,
            state: props.state || {},
            selfSubscriberId,
            remoteModels,
            limit: Math.max(20, remoteModels.length + 1),
          });
          publish("completions.set", { items });
          publishStatus("ready", false);
          return { ok: true, routed: "completions" };
        }

        appendLog(`› ${logText || rawText}`, "user");
        publishStatus("working…", true);

        try {
          const trimmed = String(rawText || "").trim();
          if (trimmed.startsWith("/") && attachments.length === 0) {
            if (typeof props.runSingleCommand !== "function") {
              appendLog("slash commands unavailable", "error");
            } else {
              const { dispatchUcodeSlashCommand } = require("../code/ucodeSlashDispatch");
              let parsed;
              try {
                parsed = props.runSingleCommand(trimmed, workspaceRoot);
              } catch (err) {
                appendLog(`Error: ${err && err.message ? err.message : "command parse failed"}`, "error");
                parsed = null;
              }
              if (parsed) {
                if (parsed.kind === "tool") tools.beginScope();
                const dispatched = await dispatchUcodeSlashCommand(parsed, {
                  state: props.state,
                  workspaceRoot,
                  appendLog,
                  persist: persistIfNeeded,
                  publishPlan,
                  publishUsage: (meter) => {
                    const label = String((meter && meter.label) || "").trim();
                    if (label) publish("usage.set", { text: label, label });
                  },
                  onExit: () => {
                    requestExit = true;
                    closing = true;
                    publish("app.exit", { reason: "slash_exit" });
                  },
                  bannerLines: banner,
                  resumeSession: (sessionId) => {
                    if (typeof props.resumeSessionState !== "function") {
                      return { ok: false, error: "resume unsupported" };
                    }
                    return props.resumeSessionState(props.state, sessionId, workspaceRoot);
                  },
                  replaceTranscript: (entries) => {
                    tools.flush();
                    replaceTranscript(entries);
                  },
                  onTool: (tool, args, payload) => {
                    ingestToolLog({
                      tool,
                      args,
                      phase: payload && payload.ok === false ? "error" : "end",
                      error: (payload && payload.error) || "",
                      result: payload,
                    });
                    tools.flush();
                  },
                  onBackground: async (task) => {
                    backgroundSeq += 1;
                    const jobId = `bg-${Date.now().toString(36)}-${backgroundSeq.toString(36)}`;
                    const taskRecord = {
                      id: jobId,
                      task,
                      status: "running",
                      startedAt: Date.now(),
                      summary: "",
                    };
                    backgroundTasks.set(jobId, taskRecord);
                    publishStatus("ready", false);
                    appendLog(`[${jobId}] started in background.`, "system");
                    const bgState = {
                      workspaceRoot: props.state && props.state.workspaceRoot,
                      provider: props.state && props.state.provider,
                      model: props.state && props.state.model,
                      engine: props.state && props.state.engine,
                      context: props.state && props.state.context,
                      nlMessages: Array.isArray(props.state && props.state.nlMessages)
                        ? props.state.nlMessages.slice()
                        : [],
                      sessionId: "",
                      timeoutMs: props.state && props.state.timeoutMs,
                      maxToolCalls: props.state ? props.state.maxToolCalls : undefined,
                      jsonOutput: false,
                    };
                    Promise.resolve()
                      .then(() => {
                        if (typeof props.runNaturalLanguageTask !== "function") {
                          throw new Error("runNaturalLanguageTask unavailable");
                        }
                        return props.runNaturalLanguageTask(task, bgState);
                      })
                      .then((nlResult) => {
                        taskRecord.status = nlResult && nlResult.ok ? "done" : "failed";
                        taskRecord.finishedAt = Date.now();
                        const formatted = typeof props.formatNlResult === "function"
                          ? props.formatNlResult(nlResult, false)
                          : "";
                        taskRecord.summary = String(formatted || "").trim();
                        appendLog(
                          `[${jobId}] ${taskRecord.status}: ${taskRecord.summary || "no summary"}`,
                          "system"
                        );
                      })
                      .catch((err) => {
                        taskRecord.status = "failed";
                        taskRecord.finishedAt = Date.now();
                        taskRecord.summary = err && err.message
                          ? String(err.message)
                          : "background task failed";
                        appendLog(`[${jobId}] failed: ${taskRecord.summary}`, "error");
                      })
                      .finally(() => {
                        publishStatus("ready", false);
                      });
                  },
                  onNaturalLanguage: async (task) => runNaturalLanguage(task),
                  onQueueCommand: (action) => {
                    const normalized = String(action || "status").trim().toLowerCase();
                    if (normalized === "status") {
                      return { ok: true, output: formatQueueSnapshot() };
                    }
                    if (normalized === "cancel") {
                      const snapshot = controller.getQueueSnapshot();
                      if (!snapshot.active) {
                        return { ok: true, output: "Queue: no active task." };
                      }
                      controller.cancelTask("queue cancel");
                      publishStatus("cancelling…", true);
                      return { ok: true, output: `Cancellation requested for #${snapshot.active.id}.` };
                    }
                    if (normalized === "clear") {
                      const count = controller.clearQueue();
                      if (!controller.isBusy()) publishStatus("ready", false);
                      return { ok: true, output: count
                        ? `Cleared ${count} pending task${count === 1 ? "" : "s"}.`
                        : "Queue: no pending tasks." };
                    }
                    if (normalized === "stop") {
                      const snapshot = controller.getQueueSnapshot();
                      const cancelled = controller.cancelTask("queue stop");
                      const cleared = controller.clearQueue();
                      if (cancelled) publishStatus("cancelling…", true);
                      else if (!controller.isBusy()) publishStatus("ready", false);
                      return {
                        ok: true,
                        output: `Queue stopped: ${cancelled ? "active cancellation requested" : "no active task"}; cleared ${cleared} pending.`,
                        active: snapshot.active,
                        cleared,
                      };
                    }
                    return { ok: false, output: "usage: /queue [status|clear|cancel|stop]" };
                  },
                  runUbus: typeof props.runUbusCommand === "function"
                    ? (state, opts) => props.runUbusCommand(state, opts)
                    : null,
                  setBusyStatus: (msg) => publishStatus(msg || "working…", true),
                  clearBusyStatus: () => publishStatus("ready", false),
                });
                if (dispatched && dispatched.waiting) {
                  return { ok: true, routed: "ucode", waiting: true };
                }
                if (requestExit) {
                  return { ok: true, routed: "exit" };
                }
              }
            }
          } else {
            const result = await runNaturalLanguage(modelText);
            if (result && result.waiting) {
              return { ok: true, routed: "ucode", waiting: true };
            }
          }
        } finally {
          try {
            const { hasPendingUserInteraction } = require("../code/context/userInteraction");
            if (
              !(props.state && hasPendingUserInteraction(props.state.executionState))
              && !controller.isBusy()
            ) {
              publishStatus("ready", false);
            }
          } catch {
            publishStatus("ready", false);
          }
        }
        return { ok: true, routed: "ucode" };
      }
      return { ok: false, error: `unsupported command ${name}` };
    },
  });
  hostRef = host;
  await host.listen();
  controller.start();
  const wakeHost = props.state && require("../code/runtime/backgroundWakeHost").createUcodeWakeHost({
    state: props.state,
    canDeliver: () => !closing && !controller.isBusy() && !controller.getQueueSnapshot().paused,
    deliver: async (event, claim, text) => {
      const result = await runNaturalLanguage(text, { kind: "runtime-wake", label: event.type, runtimeEvent: event, claim });
      return result !== null && result !== false;
    },
    onError: error => appendLog(`Background notification: ${error.message}`, "error"),
  });
  wakeHost?.start();
  publishAgents();
  ensureRemoteModels().catch(() => {});
  agentsTimer = setInterval(publishAgents, 3000);
  if (typeof agentsTimer.unref === "function") agentsTimer.unref();

  if (props.autoBus && props.autoBus.enabled) {
    autoBusTimer = setInterval(scheduleAutoBus, 1500);
    if (typeof autoBusTimer.unref === "function") autoBusTimer.unref();
    scheduleAutoBus();
  }

  const child = spawn(plan.binary, [
    "--surface", "ucode",
    "--ui-socket", uiSocketPath,
  ], {
    stdio: "inherit",
    env: {
      ...process.env,
      UFOO_UI_PROTOCOL: plan.protocol,
      UFOO_UI_TOKEN: uiAuthToken,
    },
  });

  const exitCode = await new Promise((resolve) => {
    child.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("ufoo-tui spawn failed");
      resolve(1);
    });
    child.on("close", (code, signal) => {
      resolve(signal ? 1 : (code == null ? 0 : code));
    });
  });

  closing = true;
  wakeHost?.close();
  if (autoBusTimer) {
    clearInterval(autoBusTimer);
    autoBusTimer = null;
  }
  if (agentsTimer) {
    clearInterval(agentsTimer);
    agentsTimer = null;
  }
  thinking.reset();
  agentSession.stop();
  controller.stop();
  await host.close();
  return exitCode;
}

module.exports = {
  runUcodeRust,
  buildPlanSetPayload,
  normalizeToolLogEntry,
  splitUcodeBannerRow,
  createThinkingLogPublisher,
  createLeadingWhitespaceNormalizer,
  createSegmentedStreamSession,
  appendNaturalLanguageResult,
  buildUcodeAgentsSnapshot,
  buildUcodeCompletionItems,
};
