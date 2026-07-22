"use strict";

const {
  loadTranscript,
  transcriptEventsToMessages,
  migrateNlMessagesToTranscript,
} = require("./transcript");
const { appendTranscriptMessagesForStorage } = require("./transcriptSync");
const { reduceToolResult } = require("./reducers");
const { saveArtifact } = require("./artifacts");
const { buildLayeredSystemPrompt } = require("./promptLayers");
const {
  buildProjectSnapshot,
  renderProjectSnapshotContext,
  isProjectSnapshotStale,
  invalidateProjectSnapshotIfPathTouched,
} = require("./projectSnapshot");
const {
  renderTaskContract,
  renderStateEpoch,
  applyStateCommit,
  applyValidatedStateCommit,
  buildDeterministicToolCommit,
  resolveCommitInterval,
  shouldCommitAfterToolCall,
  ensureStateEpoch,
} = require("./stateCommit");
const {
  applyWorkingSetPlan,
  renderWorkingSetContext,
  workingSetArtifactIds,
  pruneWorkingSetByRetention,
} = require("./workingSet");
const { renderExecutionSegmentContext } = require("./executionSegment");
const { renderPlanModeContext } = require("./planMode");
const { drainAgentMailboxForTurn } = require("../runtime/agentWakeup");
const { stripVisionBase64, degradeVisionContent } = require("../providers/visionBlocks");

const DEFAULT_TRANSCRIPT_WINDOW = 12;
const DEFAULT_RECENT_TOOL_EVENTS = 4;

function resolveTranscriptWindow(env = process.env) {
  const parsed = Number.parseInt(String(env.UFOO_UCODE_TRANSCRIPT_WINDOW || ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return DEFAULT_TRANSCRIPT_WINDOW;
}

function defaultContextPolicy(env = process.env) {
  return {
    transcriptWindow: resolveTranscriptWindow(env),
    commitInterval: resolveCommitInterval(env),
  };
}

function isToolTranscriptEvent(event = {}) {
  if (!event || typeof event !== "object") return false;
  if (event.artifactId) return true;
  const role = String(event.role || "").trim().toLowerCase();
  return role === "tool";
}

function eventToModelMessage(event = {}, options = {}) {
  const preferArtifact = options.preferArtifact !== false;
  if (!event || typeof event !== "object") return null;

  if (preferArtifact && event.artifactId) {
    return {
      role: event.role || "tool",
      content: JSON.stringify({
        artifactId: event.artifactId,
        preview: event.preview || "",
      }),
      tool_call_id: event.toolCallId,
    };
  }

  if (!preferArtifact && event.rawMessage && typeof event.rawMessage === "object") {
    return event.rawMessage;
  }

  const message = { role: event.role };
  if (event.content !== undefined) message.content = event.content;
  if (event.toolCalls) message.tool_calls = event.toolCalls;
  if (event.toolCallId) message.tool_call_id = event.toolCallId;
  return message;
}

function buildRollingSummary(transcriptEvents = [], existingSummary = "", session = null) {
  const events = Array.isArray(transcriptEvents) ? transcriptEvents : [];
  const window = resolveTranscriptWindow();
  const parts = [];

  const contract = session && session.taskContract && typeof session.taskContract === "object"
    ? session.taskContract
    : null;
  if (contract && contract.objective) {
    parts.push(`Objective: ${String(contract.objective).slice(0, 200)}`);
  }

  const epoch = session && session.stateEpoch && session.stateEpoch.snapshot
    ? session.stateEpoch.snapshot
    : null;
  if (epoch) {
    if (epoch.currentObjective) {
      parts.push(`Current objective: ${String(epoch.currentObjective).slice(0, 160)}`);
    }
    if (Array.isArray(epoch.facts) && epoch.facts.length > 0) {
      parts.push(`Facts: ${epoch.facts.slice(-4).map((f) => String(f).slice(0, 120)).join(" | ")}`);
    }
    if (Array.isArray(epoch.decisions) && epoch.decisions.length > 0) {
      parts.push(`Decisions: ${epoch.decisions.slice(-3).map((d) => String(d).slice(0, 120)).join(" | ")}`);
    }
  }

  const modified = session
    && session.executionState
    && Array.isArray(session.executionState.modifiedFiles)
    ? session.executionState.modifiedFiles.slice(-8)
    : [];
  if (modified.length > 0) {
    parts.push(`Modified files: ${modified.join(", ")}`);
  }

  if (events.length > window) {
    const omitted = events.length - window;
    parts.push(`Earlier transcript (${omitted} events omitted from model input).`);
    const userGoals = events
      .filter((e) => e.role === "user")
      .map((e) => {
        const text = typeof e.content === "string" ? e.content : "";
        return text.split(/\r?\n/)[0].trim();
      })
      .filter(Boolean)
      .slice(-3);
    const toolErrors = events
      .filter((e) => e.preview && /error|failed/i.test(e.preview))
      .slice(-2)
      .map((e) => String(e.preview).slice(0, 160));
    if (userGoals.length > 0) parts.push(`Recent goals: ${userGoals.join(" | ")}`);
    if (toolErrors.length > 0) parts.push(`Recent errors: ${toolErrors.join(" | ")}`);
  }

  const prior = String(existingSummary || "").trim();
  // Keep a short prior digest only when it adds distinct content.
  if (prior && !parts.some((part) => prior.includes(part.slice(0, 40)))) {
    parts.unshift(prior.split(/\n/).slice(0, 3).join("\n").slice(0, 400));
  }

  return parts.join("\n").slice(0, 1800);
}

function selectRecentToolArtifactIds(events = [], limit = DEFAULT_RECENT_TOOL_EVENTS) {
  const list = Array.isArray(events) ? events : [];
  const ids = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const event = list[i];
    if (!isToolTranscriptEvent(event)) continue;
    const id = String(event.artifactId || "").trim();
    if (!id || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return new Set(ids);
}

function toolCallIdsFromAssistantEvent(event = {}) {
  const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
  return calls
    .map((call) => String((call && (call.id || call.tool_call_id)) || "").trim())
    .filter(Boolean);
}

function isAssistantToolCallEvent(event = {}) {
  if (!event || typeof event !== "object") return false;
  if (String(event.role || "").trim().toLowerCase() !== "assistant") return false;
  return toolCallIdsFromAssistantEvent(event).length > 0;
}

/**
 * OpenAI-compatible APIs reject history that contains assistant.tool_calls
 * without a matching tool message for every call id. Working-set filtering
 * must never break that pairing.
 */
function ensureToolCallPairs(selectedEvents = [], allEvents = []) {
  const selected = Array.isArray(selectedEvents) ? selectedEvents.slice() : [];
  const all = Array.isArray(allEvents) ? allEvents : [];
  if (selected.length === 0) return selected;

  const indexInAll = new Map();
  all.forEach((event, index) => {
    if (event) indexInAll.set(event, index);
  });

  const toolsByCallId = new Map();
  for (const event of all) {
    if (!isToolTranscriptEvent(event)) continue;
    const callId = String(event.toolCallId || "").trim();
    if (callId) toolsByCallId.set(callId, event);
  }

  const selectedSet = new Set(selected);
  for (const event of selected) {
    if (!isAssistantToolCallEvent(event)) continue;
    for (const callId of toolCallIdsFromAssistantEvent(event)) {
      const toolEvent = toolsByCallId.get(callId);
      if (toolEvent && !selectedSet.has(toolEvent)) {
        selected.push(toolEvent);
        selectedSet.add(toolEvent);
      }
    }
  }

  selected.sort((a, b) => {
    const ai = indexInAll.has(a) ? indexInAll.get(a) : Number.MAX_SAFE_INTEGER;
    const bi = indexInAll.has(b) ? indexInAll.get(b) : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  const selectedToolIds = new Set(
    selected
      .filter((event) => isToolTranscriptEvent(event))
      .map((event) => String(event.toolCallId || "").trim())
      .filter(Boolean),
  );

  const keepAssistant = new Set();
  const keepToolIds = new Set();
  for (const event of selected) {
    if (!isAssistantToolCallEvent(event)) continue;
    const callIds = toolCallIdsFromAssistantEvent(event);
    if (callIds.length === 0) continue;
    if (!callIds.every((id) => selectedToolIds.has(id))) continue;
    keepAssistant.add(event);
    for (const id of callIds) keepToolIds.add(id);
  }

  return selected.filter((event) => {
    if (isAssistantToolCallEvent(event)) return keepAssistant.has(event);
    if (isToolTranscriptEvent(event)) {
      const callId = String(event.toolCallId || "").trim();
      return Boolean(callId) && keepToolIds.has(callId);
    }
    return true;
  });
}

function sanitizeModelMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const message = list[i];
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "").trim().toLowerCase();

    if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const callIds = message.tool_calls
        .map((call) => String((call && call.id) || "").trim())
        .filter(Boolean);
      const following = [];
      let j = i + 1;
      while (j < list.length && String(list[j].role || "").trim().toLowerCase() === "tool") {
        following.push(list[j]);
        j += 1;
      }
      const followingIds = new Set(
        following.map((entry) => String(entry.tool_call_id || "").trim()).filter(Boolean),
      );
      if (callIds.length === 0 || !callIds.every((id) => followingIds.has(id))) {
        i = j - 1;
        continue;
      }
      out.push({
        role: "assistant",
        content: message.content == null ? null : message.content,
        tool_calls: message.tool_calls,
      });
      for (const toolMessage of following) {
        const toolCallId = String(toolMessage.tool_call_id || "").trim();
        if (!toolCallId || !callIds.includes(toolCallId)) continue;
        out.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: toolMessage.content == null ? "" : toolMessage.content,
        });
      }
      i = j - 1;
      continue;
    }

    if (role === "tool") {
      // Orphan tool rows are skipped; valid ones are consumed with their assistant.
      continue;
    }

    // Drop ephemeral OpenAI vision companion user messages (image_url data URIs)
    // when rebuilding history so base64 does not re-enter later turns.
    if (role === "user" && Array.isArray(message.content)) {
      const hasImageUrl = message.content.some((block) => (
        block && String(block.type || "").trim().toLowerCase() === "image_url"
      ));
      if (hasImageUrl) {
        const degraded = degradeVisionContent(message.content);
        out.push({ role: "user", content: degraded });
        continue;
      }
    }

    out.push(message);
  }
  return out;
}

function buildModelMessagesFromTranscript(transcriptEvents = [], session = {}, windowSize = DEFAULT_TRANSCRIPT_WINDOW) {
  const events = Array.isArray(transcriptEvents) ? transcriptEvents : [];
  const wsIds = workingSetArtifactIds(session.workingSet);
  const recentToolIds = selectRecentToolArtifactIds(events, DEFAULT_RECENT_TOOL_EVENTS);
  const allowedToolIds = new Set([...wsIds, ...recentToolIds]);

  const toolsByCallId = new Map();
  for (const event of events) {
    if (!isToolTranscriptEvent(event)) continue;
    const callId = String(event.toolCallId || "").trim();
    if (callId) toolsByCallId.set(callId, event);
  }

  function assistantGroupAllowed(event) {
    const callIds = toolCallIdsFromAssistantEvent(event);
    if (callIds.length === 0) return true;
    return callIds.every((callId) => {
      const toolEvent = toolsByCallId.get(callId);
      if (!toolEvent) return false;
      const artifactId = String(toolEvent.artifactId || "").trim();
      if (!artifactId) return true;
      return allowedToolIds.has(artifactId);
    });
  }

  const selected = [];
  for (let i = events.length - 1; i >= 0 && selected.length < windowSize; i -= 1) {
    const event = events[i];
    if (isAssistantToolCallEvent(event) && !assistantGroupAllowed(event)) {
      continue;
    }
    if (isToolTranscriptEvent(event)) {
      const artifactId = String(event.artifactId || "").trim();
      if (artifactId && !allowedToolIds.has(artifactId)) continue;
      if (!artifactId && !event.preview && !event.toolCallId) continue;
    }
    selected.unshift(event);
  }

  const paired = ensureToolCallPairs(selected, events);
  return sanitizeModelMessages(
    paired.map((event) => eventToModelMessage(event, { preferArtifact: true })).filter(Boolean),
  );
}

function buildRecentMessages(transcriptEvents = [], windowSize = DEFAULT_TRANSCRIPT_WINDOW, session = null) {
  if (session) {
    return buildModelMessagesFromTranscript(transcriptEvents, session, windowSize);
  }
  const recent = eventsSliceWindow(transcriptEvents, windowSize);
  return recent.map((event) => eventToModelMessage(event, { preferArtifact: true })).filter(Boolean);
}

function eventsSliceWindow(events = [], windowSize = DEFAULT_TRANSCRIPT_WINDOW) {
  const list = Array.isArray(events) ? events : [];
  if (list.length <= windowSize) return list.slice();
  return list.slice(-windowSize);
}

function ensureTranscript(session = {}, workspaceRoot = process.cwd()) {
  const sessionId = String(session.sessionId || "").trim();
  if (!sessionId) return [];
  if (Array.isArray(session.transcriptEvents) && session.transcriptEvents.length > 0) {
    return session.transcriptEvents;
  }
  const loaded = loadTranscript(workspaceRoot, sessionId);
  if (loaded.events.length > 0) {
    session.transcriptEvents = loaded.events;
    return loaded.events;
  }
  if (Array.isArray(session.nlMessages) && session.nlMessages.length > 0) {
    session.transcriptEvents = migrateNlMessagesToTranscript(workspaceRoot, sessionId, session.nlMessages);
    return session.transcriptEvents;
  }
  session.transcriptEvents = [];
  return session.transcriptEvents;
}

function assembleModelContext(session = {}, request = {}, env = process.env) {
  const workspaceRoot = String(session.workspaceRoot || request.workspaceRoot || process.cwd());
  const policy = {
    ...defaultContextPolicy(env),
    ...(session.contextPolicy && typeof session.contextPolicy === "object" ? session.contextPolicy : {}),
  };
  session.workingSet = pruneWorkingSetByRetention(session.workingSet, session);
  const transcriptEvents = ensureTranscript(session, workspaceRoot);
  const windowSize = policy.transcriptWindow || DEFAULT_TRANSCRIPT_WINDOW;
  const summary = buildRollingSummary(transcriptEvents, session.summary, session);

  const layered = buildLayeredSystemPrompt({
    workspaceRoot,
    model: session.model || request.model || "",
    provider: session.provider || request.provider || "",
    appendSystemPrompt: request.appendSystemPrompt || "",
    overrideSystemPrompt: request.overrideSystemPrompt || "",
    epochDynamic: [
      renderTaskContract(session.taskContract),
      renderStateEpoch(session.stateEpoch),
    ].filter(Boolean).join("\n\n"),
    turnDynamic: [
      request.turnDynamic || "",
      (() => {
        try {
          const { MAX_CONCURRENT_WRITE_LEASES } = require("../runtime/workspaceLease");
          return `Current max concurrent writing TaskRuns: ${MAX_CONCURRENT_WRITE_LEASES}`;
        } catch {
          return "";
        }
      })(),
      renderPlanModeContext(session.executionState),
      drainAgentMailboxForTurn(session.executionState).text,
      renderProjectSnapshotContext(session.projectSnapshot),
      renderWorkingSetContext(session.workingSet, session),
      renderExecutionSegmentContext(session.executionState),
      summary ? `Session summary:\n${summary}` : "",
    ].filter(Boolean).join("\n\n"),
    sessionStableExtras: request.sessionStableExtras || "",
  });

  const recentMessages = buildRecentMessages(transcriptEvents, windowSize, session);

  return {
    systemPrompt: layered.flatText,
    systemBlocks: layered.blocks,
    messages: recentMessages,
    summary,
    transcriptEvents,
    policy,
  };
}

function persistToolResultToContext({
  workspaceRoot = process.cwd(),
  sessionId = "",
  tool = "",
  args = {},
  rawResult = {},
  segmentId = "",
} = {}) {
  const rawForStorage = stripVisionBase64(rawResult);
  const saved = saveArtifact(workspaceRoot, sessionId, {
    type: "tool_result",
    tool,
    args,
    raw: rawForStorage,
    createdBy: tool,
  });
  const artifactId = saved.artifact && saved.artifact.artifactId
    ? saved.artifact.artifactId
    : "";
  // Reduce from the live result so vision base64 stays available for this turn.
  const reduced = reduceToolResult(tool, rawResult, artifactId, args);
  return {
    artifactId,
    preview: reduced.preview,
    summary: reduced.summary,
    modelPayload: reduced.modelPayload,
    artifact: saved.artifact,
    segmentId,
    tool,
    args,
  };
}

function recordToolCallInSession(session = {}, persisted = {}, workspaceRoot = process.cwd()) {
  if (!session || typeof session !== "object") return;
  ensureStateEpoch(session);
  session.toolCallsSinceCommit = (Number(session.toolCallsSinceCommit) || 0) + 1;
  if (!Array.isArray(session.workingSet)) session.workingSet = [];
  if (!session.executionState || typeof session.executionState !== "object") {
    session.executionState = require("./executionSegment").emptyExecutionState();
  }
  const plan = require("./workingSet").defaultContextPlanFromToolEvent(
    persisted.tool,
    persisted.artifactId,
    persisted.args,
  );
  if (plan) {
    session.workingSet = applyWorkingSetPlan(session.workingSet, plan, session);
  }

  const payload = persisted.modelPayload && typeof persisted.modelPayload === "object"
    ? persisted.modelPayload
    : {};
  const exitCode = Number.isFinite(payload.exitCode)
    ? payload.exitCode
    : (Number.isFinite(persisted.exitCode) ? persisted.exitCode : null);
  if (exitCode !== null) {
    const codes = Array.isArray(session.executionState.lastExitCodes)
      ? session.executionState.lastExitCodes.slice()
      : [];
    codes.push({ tool: persisted.tool || "", exitCode, at: new Date().toISOString() });
    session.executionState.lastExitCodes = codes.slice(-20);
  }

  if (persisted.tool === "write" || persisted.tool === "edit") {
    const filePath = persisted.args && persisted.args.path ? String(persisted.args.path) : "";
    if (filePath) {
      const files = Array.isArray(session.executionState.modifiedFiles)
        ? session.executionState.modifiedFiles.slice()
        : [];
      if (!files.includes(filePath)) files.push(filePath);
      session.executionState.modifiedFiles = files;
      invalidateProjectSnapshotIfPathTouched(session, filePath);
    }
  }

  if (payload.kind === "git_diff" && Array.isArray(payload.files)) {
    const files = Array.isArray(session.executionState.modifiedFiles)
      ? session.executionState.modifiedFiles.slice()
      : [];
    for (const filePath of payload.files) {
      const text = String(filePath || "").trim();
      if (text && !files.includes(text)) files.push(text);
    }
    session.executionState.modifiedFiles = files.slice(0, 200);
  }

  const failed = payload.ok === false
    || (exitCode !== null && exitCode !== 0)
    || (Number.isFinite(payload.failed) && payload.failed > 0);
  if (failed) {
    const toolKey = String(persisted.tool || "tool");
    const retries = session.executionState.retries && typeof session.executionState.retries === "object"
      ? { ...session.executionState.retries }
      : {};
    retries[toolKey] = (Number(retries[toolKey]) || 0) + 1;
    session.executionState.retries = retries;
  }

  const interval = resolveCommitInterval();
  if (shouldCommitAfterToolCall(session, interval)) {
    const commit = buildDeterministicToolCommit(persisted);
    if (commit) {
      applyValidatedStateCommit(session, commit, workspaceRoot);
    } else {
      session.toolCallsSinceCommit = 0;
    }
  }
}

function syncMessagesToTranscript(session = {}, messages = [], workspaceRoot = process.cwd(), options = {}) {
  const sessionId = String(session.sessionId || "").trim();
  if (!sessionId) return [];
  const prior = ensureTranscript(session, workspaceRoot);
  const full = Array.isArray(messages) ? messages : [];
  if (full.length === 0) return prior;

  // `messages` is often a WINDOWED model view (plus this turn's delta), not the
  // full transcript. Comparing lengths to prior transcript events dropped every
  // new user turn once the transcript grew past the window — resume then lost
  // green › user rows. Prefer an explicit baseline, else suffix/prefix match.
  let baseline = Number.isFinite(options.baselineCount)
    ? Math.max(0, Math.floor(options.baselineCount))
    : null;
  if (baseline == null) {
    const existingMessages = transcriptEventsToMessages(prior, {
      preferArtifact: true,
    });
    baseline = matchTranscriptBaseline(existingMessages, full);
  }
  baseline = Math.max(0, Math.min(full.length, baseline));

  if (full.length <= baseline) {
    session.nlMessages = transcriptEventsToMessages(session.transcriptEvents, {
      preferArtifact: true,
    });
    return session.transcriptEvents || prior;
  }

  const delta = full.slice(baseline);
  const extra = {
    segmentId: session.executionState && session.executionState.currentSegmentId
      ? session.executionState.currentSegmentId
      : "",
  };
  appendTranscriptMessagesForStorage(workspaceRoot, sessionId, delta, extra);
  session.transcriptEvents = loadTranscript(workspaceRoot, sessionId).events;
  session.nlMessages = transcriptEventsToMessages(session.transcriptEvents, {
    preferArtifact: true,
  });
  session.summary = buildRollingSummary(session.transcriptEvents, session.summary, session);
  return session.transcriptEvents;
}

/**
 * Fingerprint a chat message for transcript alignment. Tool payloads are
 * compared by call id (content is often artifact-compressed on disk).
 */
function messageSyncFingerprint(message = {}) {
  if (!message || typeof message !== "object") return "";
  const role = String(message.role || "").trim().toLowerCase();
  if (role === "tool") {
    return `tool|${String(message.tool_call_id || "").trim()}`;
  }
  if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    const ids = message.tool_calls
      .map((call) => String((call && call.id) || "").trim())
      .filter(Boolean)
      .join(",");
    return `assistant_tools|${ids}`;
  }
  let content = "";
  if (typeof message.content === "string") content = message.content;
  else if (message.content != null) {
    try {
      content = JSON.stringify(message.content);
    } catch {
      content = String(message.content);
    }
  }
  const compact = content.replace(/\s+/g, " ").trim();
  return `${role}|${compact.length}|${compact.slice(0, 240)}`;
}

/**
 * How much of `next` is already covered by the end of `existing`.
 * Returns the length of the matched prefix of `next` (baseline for slicing).
 */
function matchTranscriptBaseline(existing = [], next = []) {
  const prior = Array.isArray(existing) ? existing : [];
  const incoming = Array.isArray(next) ? next : [];
  if (incoming.length === 0) return 0;
  const priorFingerprints = prior.map(messageSyncFingerprint);
  const nextFingerprints = incoming.map(messageSyncFingerprint);
  const max = Math.min(priorFingerprints.length, nextFingerprints.length);
  for (let k = max; k >= 0; k -= 1) {
    let matched = true;
    for (let i = 0; i < k; i += 1) {
      if (priorFingerprints[priorFingerprints.length - k + i] !== nextFingerprints[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return k;
  }
  return 0;
}

function applyContextSideEffects(session = {}, sideEffects = {}, workspaceRoot = process.cwd()) {
  const effects = sideEffects && typeof sideEffects === "object" ? sideEffects : {};
  if (effects.stateCommit) {
    applyValidatedStateCommit(session, effects.stateCommit, workspaceRoot);
  }
  if (effects.contextPlan) {
    session.workingSet = applyWorkingSetPlan(session.workingSet, effects.contextPlan, session);
    const summarize = Array.isArray(effects.contextPlan.summarize) ? effects.contextPlan.summarize : [];
    if (summarize.length > 0) {
      session.workingSet = applyWorkingSetPlan(session.workingSet, { summarize }, session);
    }
  }
  if (effects.projectSnapshot) {
    session.projectSnapshot = effects.projectSnapshot;
  }
  return session;
}

function commitAfterSegmentEnd(session = {}, segmentResult = {}, workspaceRoot = process.cwd()) {
  if (!session || typeof session !== "object") return null;
  const result = segmentResult && typeof segmentResult === "object" ? segmentResult : {};
  const commit = {
    factsAdd: [
      `segment:${result.segmentId || "unknown"} status=${result.ok === false ? "failed" : (result.stoppedAt || "success")}`,
    ],
    nextObjective: result.objective || "",
  };
  return applyValidatedStateCommit(session, commit, workspaceRoot);
}

function ensureProjectSnapshot(session = {}, workspaceRoot = process.cwd()) {
  const root = workspaceRoot || process.cwd();
  if (
    session.projectSnapshot
    && session.projectSnapshot.projectSnapshotId
    && !isProjectSnapshotStale(session.projectSnapshot, root)
  ) {
    return session.projectSnapshot;
  }
  session.projectSnapshot = buildProjectSnapshot({
    workspaceRoot: root,
    sessionId: session.sessionId,
    existing: null,
  });
  return session.projectSnapshot;
}

module.exports = {
  DEFAULT_TRANSCRIPT_WINDOW,
  DEFAULT_RECENT_TOOL_EVENTS,
  defaultContextPolicy,
  buildRollingSummary,
  buildRecentMessages,
  buildModelMessagesFromTranscript,
  selectRecentToolArtifactIds,
  ensureToolCallPairs,
  sanitizeModelMessages,
  ensureTranscript,
  assembleModelContext,
  persistToolResultToContext,
  recordToolCallInSession,
  syncMessagesToTranscript,
  applyContextSideEffects,
  commitAfterSegmentEnd,
  ensureProjectSnapshot,
  messageSyncFingerprint,
  matchTranscriptBaseline,
};
