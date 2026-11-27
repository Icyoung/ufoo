const fs = require("fs");
const { randomUUID } = require("crypto");
const { createAgentSurfacePublisher } = require("../../coordination/history/agentSurface");
const { contextMeterForUsage } = require("../../ui/agentPresentation");
const { updateAgentsData } = require("../../coordination/state/agentsStore");
const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");
const { spawnSync } = require("child_process");
const EventBus = require("../../coordination/bus");
const { normalizeInternalAgentType, isAcpAgentType, extractAcpAgentId } = require("../../runtime/contracts/agentMode");
const { createAcpThreadProvider } = require("../providers/acpThreadProvider");
const { buildAcpMcpServers, buildClaudeMcpServers, buildCodexMcpConfig } = require("../../runtime/daemon/workerMcpInjection");
const { readJSON } = require("../../coordination/bus/utils");
const { createActivityStatePublisher } = require("../activity/activityStatePublisher");
const { createActivityTracker } = require("../activity/activityTracker");
const { normalizeTraceContext } = require("../runtime/protocol/traceContext");
const { buildRunObservation, observationFingerprint } = require("../runtime/protocol/runObservation");
const { getTaskIdFromEvent } = require("../../coordination/bus/messageMeta");
const { enqueueAgentReport } = require("../../runtime/daemon/reportControlBus");
const { loadConfig, defaultAgentModelForProvider, sameModelProvider } = require("../../config");
const { createCodexThreadProvider } = require("../providers/codexThreadProvider");
const { createClaudeThreadProvider } = require("../providers/claudeThreadProvider");
const { createAgyThreadProvider } = require("../providers/agyThreadProvider");
const { resolveClaudeUpstreamCredentials } = require("../providers/credentials/claude");
const { buildUpstreamAuthFromCredential } = require("../providers/credentials");
const { listToolsForCallerTier, CALLER_TIERS } = require("../../tools");
const { redactToolCallPayload, redactSecrets } = require("../../runtime/privacy/redactor");
const { buildCachedMemoryPrefix } = require("../../coordination/memory");
const { normalizePublisher, shouldForwardStreamToPublisher } = require("../launch/publisherRouting");
const { appendAgentRegistryDiagnostic } = require("../../coordination/state/agentRegistryDiagnostics");
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");
const {
  buildDefaultStartupBootstrapPrompt,
  isValueForCodexOption,
} = require("../prompts/defaultBootstrap");
const {
  hasSharedUfooProtocolPrompt,
  INTERNAL_BUS_DELIVERY_GUIDANCE,
} = require("../prompts/groupBootstrap");
const { REPORTING_GUIDANCE } = require("../prompts/reporting");
const { RESPONSE_LANGUAGE_GUIDANCE } = require("../runtime/prompts/responseLanguage");
const { COOPERATION_GUIDANCE } = require("../prompts/cooperation");
const { buildPromptInjectionText } = require("../../coordination/bus/promptEnvelope");
const { normalizeAttachmentList, loadAttachmentModelContext } = require("../../runtime/attachments");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWorkerThreadToolMode(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "worker-tier01" || raw === "tier01" || raw === "enabled" || raw === "1" || raw === "true") {
    return "worker-tier01";
  }
  return "disabled";
}

function buildEnv(agentType, sessionId, publisher, nickname) {
  const env = { ...process.env };
  env.AI_BUS_PUBLISHER = publisher || env.AI_BUS_PUBLISHER || "";
  env.UFOO_NICKNAME = nickname || env.UFOO_NICKNAME || "";
  env.UFOO_PARENT_PID = String(process.pid);
  return env;
}

function parseSubscriberId() {
  // Daemon 已经注册，直接使用
  if (process.env.UFOO_SUBSCRIBER_ID) {
    const parts = process.env.UFOO_SUBSCRIBER_ID.split(":");
    if (parts.length === 2) {
      return {
        subscriber: process.env.UFOO_SUBSCRIBER_ID,
        agentType: parts[0],
        sessionId: parts[1],
      };
    }
  }

  throw new Error("Internal runner requires UFOO_SUBSCRIBER_ID set by daemon");
}

function safeSubscriber(subscriber) {
  return subscriber.replace(/:/g, "_");
}

function readFileSafe(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return "";
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

function hasPromptArg(args = []) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const lastIndex = args.length - 1;
  const lastItem = String(args[lastIndex] || "").trim();
  if (!lastItem || lastItem.startsWith("-")) return false;
  return !isValueForCodexOption(args, lastIndex);
}

function consumeClaudeAppendSystemPrompt(args = []) {
  const nextArgs = [];
  const promptSegments = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || "");
    if (item === "--append-system-prompt") {
      const filePath = String(args[index + 1] || "");
      const content = readFileSafe(filePath);
      if (content.trim()) promptSegments.push(content.trim());
      index += 1;
      continue;
    }
    if (item.startsWith("--append-system-prompt=")) {
      const filePath = item.slice("--append-system-prompt=".length);
      const content = readFileSafe(filePath);
      if (content.trim()) promptSegments.push(content.trim());
      continue;
    }
    nextArgs.push(item);
  }
  return {
    args: nextArgs,
    promptText: promptSegments.filter(Boolean).join("\n\n"),
  };
}

function consumeAgyPromptArgs(args = []) {
  const nextArgs = [];
  const promptSegments = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || "");
    if (item === "-i" || item === "--prompt-interactive") {
      const content = String(args[index + 1] || "").trim();
      if (content) promptSegments.push(content);
      index += 1;
      continue;
    }
    if (item.startsWith("--prompt-interactive=")) {
      const content = item.slice("--prompt-interactive=".length).trim();
      if (content) promptSegments.push(content);
      continue;
    }
    nextArgs.push(item);
  }
  return {
    args: nextArgs,
    promptText: promptSegments.filter(Boolean).join("\n\n"),
  };
}

function resolveInternalBootstrap({
  projectRoot = process.cwd(),
  agentType = "codex",
  extraArgs = [],
  env = process.env,
} = {}) {
  const normalizedAgent = String(agentType || "").trim().toLowerCase();
  const bootstrapAgentType = normalizedAgent === "claude" || normalizedAgent === "claude-code"
    ? "claude-code"
    : (normalizedAgent === "codex"
      ? "codex"
      : (normalizedAgent === "agy" || normalizedAgent === "antigravity" ? "agy" : ""));
  const args = Array.isArray(extraArgs) ? extraArgs.slice() : [];
  if (!bootstrapAgentType) {
    return { promptText: "", extraArgs: args };
  }

  let promptText = "";
  let nextArgs = args;

  if (bootstrapAgentType === "claude-code") {
    const consumed = consumeClaudeAppendSystemPrompt(args);
    promptText = consumed.promptText;
    nextArgs = consumed.args;
  } else if (bootstrapAgentType === "agy") {
    const consumed = consumeAgyPromptArgs(args);
    promptText = consumed.promptText || String(env.UFOO_STARTUP_BOOTSTRAP_TEXT || "").trim();
    nextArgs = consumed.args;
  } else if (hasPromptArg(args)) {
    promptText = String(args[args.length - 1] || "").trim();
    nextArgs = args.slice(0, -1);
  } else {
    promptText = String(env.UFOO_STARTUP_BOOTSTRAP_TEXT || "").trim();
  }

  if (!hasSharedUfooProtocolPrompt(promptText)) {
    const defaultPrompt = buildDefaultStartupBootstrapPrompt({
      agentType: bootstrapAgentType,
      projectRoot,
    }).trim();
    promptText = [defaultPrompt, promptText.trim()].filter(Boolean).join("\n\n");
  }

  // Stored group/resume bootstraps may predate current runtime guidance.
  if (!promptText.includes(REPORTING_GUIDANCE)) promptText = [promptText, REPORTING_GUIDANCE].join("\n\n");
  if (!promptText.includes(INTERNAL_BUS_DELIVERY_GUIDANCE)) promptText = [promptText, INTERNAL_BUS_DELIVERY_GUIDANCE].join("\n\n");
  if (!promptText.includes(RESPONSE_LANGUAGE_GUIDANCE)) promptText = [promptText, RESPONSE_LANGUAGE_GUIDANCE].join("\n\n");
  if (!promptText.includes(COOPERATION_GUIDANCE)) promptText = [promptText, COOPERATION_GUIDANCE].join("\n\n");
  return {
    promptText,
    extraArgs: nextArgs,
  };
}

function buildMemoryPrefix(projectRoot, limit = 50) {
  try {
    return buildCachedMemoryPrefix(projectRoot, { limit }).prefix.trim();
  } catch {
    return "";
  }
}

function readAgentsMap(projectRoot) {
  try {
    const data = readJSON(getUfooPaths(projectRoot).agentsFile, null);
    return data && data.agents && typeof data.agents === "object" ? data.agents : {};
  } catch {
    return {};
  }
}

function buildInternalPromptMessage(projectRoot, subscriber, evt = {}) {
  const message = String((evt.data && evt.data.message) || "");
  if (evt.__internalRawInput) return message;
  return buildPromptInjectionText(evt, subscriber, readAgentsMap(projectRoot));
}

function createBusSender(projectRoot, subscriber) {
  const eventBus = new EventBus(projectRoot);
  const surface = createAgentSurfacePublisher(projectRoot, subscriber);
  let sendQueue = Promise.resolve();

  function enqueue(target, message, sendOptions = {}) {
    if (!target || !message) return;
    sendQueue = sendQueue
      .then(() => eventBus.send(target, message, subscriber, sendOptions))
      .catch(() => {
        // ignore per-message bus send errors to keep runner loop alive
      });
  }

  async function flush() {
    try {
      await sendQueue;
      await surface.flush();
    } catch {
      // ignore flush errors
    }
  }

  return { enqueue, flush, surface: surface.enqueue,
    report: report => enqueueAgentReport(projectRoot, { ...report, agent_id: subscriber, source: "runtime" }) };
}

function isChatUiSource(source = "") {
  const value = String(source || "").trim();
  return value === "chat-direct"
    || value === "chat-agent-view"
    || value === "chat-internal-agent-view"
    || value === "rust-multi-window"
    || value === "ufoo-desktop"
    || value === "ufoo-desktop-worker"
    || value === "ufoo-desktop-handoff";
}

function isUfooAgentDispatchSource(source = "") {
  const value = String(source || "").trim();
  return value === "ufoo-agent";
}

function shouldStreamReplyToPublisher(projectRoot, publisher, evt = {}) {
  const source = evt && evt.data ? evt.data.source : "";
  if (isChatUiSource(source)) return true;
  if (normalizePublisher(publisher) === "ufoo-agent" && isUfooAgentDispatchSource(source)) return true;
  return shouldForwardStreamToPublisher(projectRoot, publisher);
}

function claimQueuedEvents(queueFile) {
  const queue = new DeliveryQueue(queueFile);
  const claims = [];
  while (true) {
    const claim = queue.claimNext();
    if (!claim) break;
    claims.push({ ...claim, queue });
  }
  return claims;
}

function parseInternalRawInput(message) {
  if (typeof message !== "string" || !message.trim()) return null;
  try {
    const parsed = JSON.parse(message);
    if (parsed && parsed.raw === true && typeof parsed.data === "string") {
      return parsed.data;
    }
  } catch {
    // Not a raw internal-input envelope.
  }
  return null;
}

function createInteractiveInputSession({ write = () => {} } = {}) {
  let buffer = "";

  function writePrompt() {
    write("> ");
  }

  function handleRaw(data) {
    const submissions = [];
    const text = String(data || "");
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        const submitted = buffer.trim();
        buffer = "";
        write("\r\n");
        if (submitted) submissions.push(submitted);
        else writePrompt();
        continue;
      }

      if (char === "\u0003") {
        buffer = "";
        write("^C\r\n");
        writePrompt();
        continue;
      }

      if (char === "\u007f" || char === "\b") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          write("\b \b");
        }
        continue;
      }

      if (char >= " " && char !== "\u007f") {
        buffer += char;
        write(char);
      }
    }
    return submissions;
  }

  return {
    handleRaw,
    writePrompt,
    writeResponsePrompt: () => {
      write("\r\n");
      writePrompt();
    },
    getBuffer: () => buffer,
  };
}

async function handleEvent(
  projectRoot,
  agentType,
  provider,
  model,
  subscriber,
  nickname,
  evt,
  busSender,
  extraArgs = [],
  threadRuntime = null,
  bootstrapText = "",
  tracker = null,
  signal = null
) {
  if (!evt || !evt.data || (!evt.data.message && !(Array.isArray(evt.data.attachments) && evt.data.attachments.length > 0))) return;
  const incomingAttachments = normalizeAttachmentList(evt.data.attachments || []);
  const attachmentCtx = incomingAttachments.length > 0
    ? loadAttachmentModelContext(incomingAttachments, projectRoot)
    : { promptAppendix: "" };
  const memoryPrefix = buildMemoryPrefix(projectRoot);
  const promptMessage = buildInternalPromptMessage(projectRoot, subscriber, evt);
  const inlineBootstrap = threadRuntime?.thread?.managesSystemPrompt ? "" : bootstrapText;
  const prompt = [inlineBootstrap, memoryPrefix, promptMessage, attachmentCtx.promptAppendix]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const publisher = evt.publisher || "unknown";
  const dispatchId = publisher === "ufoo-agent" && evt.data.source === "ufoo-agent" && evt.data.dispatch_id;
  const streamToPublisher = !dispatchId && shouldStreamReplyToPublisher(projectRoot, publisher, evt);
  const sendReply = (text) => dispatchId
    ? busSender.enqueue(publisher, text, { data: { reply_to_dispatch: dispatchId } })
    : busSender.enqueue(publisher, text);
  const inherited = normalizeTraceContext(evt.data.runtime_context);
  const taskId = getTaskIdFromEvent(evt) || inherited.taskId || `worker-${randomUUID()}`;
  const runtimeContext = { ...inherited, taskId, traceId: inherited.traceId || taskId,
    taskRunId: `worker-run-${randomUUID()}`, requestId: `bus-${evt.seq || randomUUID()}`, attemptId: `attempt-${randomUUID()}`,
    requestKind: evt.__runtimeWake ? "system_wake" : publisher === "ufoo-agent" && getTaskIdFromEvent(evt) ? "worker-task" : "bus-message" };
  const emitSurface = event => busSender.surface?.({ ...runtimeContext, task_id: taskId, agentId: subscriber,
    provider, model, sessionId: threadRuntime?.thread?.id || "", ...event });
  const delegated = publisher === "ufoo-agent" && Boolean(getTaskIdFromEvent(evt));
  const reportLifecycle = async (phase, error = "", meta = {}) => {
    if (!delegated || typeof busSender.report !== "function") return;
    await busSender.report({ task_id: taskId, phase, scope: "private", controller_id: "ufoo-agent", error,
      meta: { ...runtimeContext, ...meta } });
  };
  emitSurface({
    type: "task_started",
    message: evt.data.message,
    publisher,
    source: String(evt.data?.source || ""),
    queueSequence: evt.seq,
  });
  if (provider !== "ucode") emitSurface({ type: "run_config", configuration: buildRunObservation({ provider, model,
    executionKind: "sdk", systemPrompt: bootstrapText, prompt: evt.data.message,
    requestKind: runtimeContext.requestKind,
    engineFingerprint: observationFingerprint(handleThreadedEvent.toString()),
    tools: threadRuntime?.toolRuntime?.tools || [],
    thinkingLevel: String(threadRuntime?.thread?.threadOptions?.modelReasoningEffort || threadRuntime?.thread?.agentOptions?.effort || threadRuntime?.thread?.thinkingLevel || "") }) });
  await reportLifecycle("start");

  const emitStreamDelta = (delta) => {
    const text = String(delta || "");
    if (!text) return;
    if (!streamToPublisher) return;
    busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: text }));
  };

  if (threadRuntime && threadRuntime.enabled && threadRuntime.thread) {
    return handleThreadedEvent({
      projectRoot,
      subscriber,
      agentType,
      provider,
      model,
      publisher,
      incomingSource: String(evt.data?.source || ""),
      incomingWorkflowMeta: {
        workflow_group_id: evt.data?.workflow_group_id || "",
        workflow_edge_id: evt.data?.workflow_edge_id || "",
        workflow_hop: Number(evt.data?.workflow_hop) || 0,
        workflow_trail: Array.isArray(evt.data?.workflow_trail) ? evt.data.workflow_trail : [],
      },
      prompt,
      userMessage: evt.data.message,
      attachments: incomingAttachments,
      busSender,
      emitStreamDelta,
      streamToPublisher,
      sendReply,
      threadRuntime,
      tracker,
      emitSurface,
      runtimeContext,
      reportLifecycle,
      signal,
    });
  }

  const errorText = `[internal:${agentType}] error: ${threadRuntime?.error?.message || `agent runtime not initialized for provider ${provider}`}`;
  emitSurface({ type: "task_failed", error: errorText });
  await reportLifecycle("error", errorText);
  // eslint-disable-next-line no-console
  console.error(errorText);
  if (streamToPublisher) {
    busSender.enqueue(publisher, JSON.stringify({ stream: true, delta: errorText }));
    busSender.enqueue(publisher, JSON.stringify({ stream: true, done: true, reason: "error" }));
  } else {
    sendReply(errorText);
  }
  await busSender.flush();
  return { ok: false, error: errorText };
}

function compactToolDetail(value = "", maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeThreadToolCall(event = {}) {
  const name = String(event.name || event.tool || event.tool_name || "tool").trim() || "tool";
  const args = event.args && typeof event.args === "object" ? event.args : {};
  const detail = args.command
    || args.cmd
    || args.code
    || args.path
    || args.file
    || args.target
    || args.query
    || "";
  return [name, compactToolDetail(detail)].filter(Boolean).join(" · ");
}

function toNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

// Normalizes provider usage payloads (claude/codex thread events) onto the
// metric fields used by provider usage summaries.
function normalizeTurnUsage(usage = null) {
  const item = usage && typeof usage === "object" ? usage : {};
  return {
    input_tokens: toNonNegativeInt(item.input_tokens ?? item.inputTokens ?? item.prompt_tokens ?? item.input),
    output_tokens: toNonNegativeInt(item.output_tokens ?? item.outputTokens ?? item.completion_tokens ?? item.output),
    cache_read_tokens: toNonNegativeInt(
      item.cache_read_tokens
        || item.cachedReadTokens
        || item.cache_read_input_tokens
        || item.cached_input_tokens
        || item.cacheRead
        || (item.input_tokens_details && item.input_tokens_details.cached_tokens)
    ),
    cache_creation_tokens: toNonNegativeInt(
      item.cache_creation_tokens || item.cachedWriteTokens || item.cache_creation_input_tokens || item.cacheCreation
    ),
  };
}

async function handleThreadedEvent({
  projectRoot = "",
  subscriber = "",
  agentType,
  provider,
  model = "",
  publisher,
  incomingSource = "",
  incomingWorkflowMeta = {},
  prompt,
  userMessage = "",
  attachments = [],
  busSender,
  emitStreamDelta,
  streamToPublisher = true,
  sendReply = (text) => busSender.enqueue(publisher, text),
  threadRuntime,
  tracker = null,
  emitSurface = () => {},
  runtimeContext = {},
  reportLifecycle = async () => {},
  signal = null,
}) {
  try {
    const plainReplyParts = [];
    let finalReply;
    let turnUsage = null;
    let stopReason = "";
    let waitingForUser = false;
    if (tracker && typeof tracker.notifyTurnStart === "function") {
      tracker.notifyTurnStart();
    }
    const started = Date.now();
    for await (const event of threadRuntime.thread.runStreamed(prompt, {
      ...(signal ? { signal } : {}),
      runtimeContext,
      ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
      ...(provider === "ucode" ? { userInput: userMessage } : {}),
    })) {
      if (!event || typeof event !== "object") continue;
      emitSurface(event.type === "tool_call" && event.args !== undefined
        ? { ...event, argumentFingerprint: observationFingerprint(event.args) } : event);
      if (["usage", "turn_completed"].includes(event.type) && event.usage && provider !== "ucode") {
        emitSurface({ type: "context_usage", meter: contextMeterForUsage(event.usage, model || threadRuntime.thread.model, provider) });
      }
      if (event.type === "interaction" || (event.type === "status" && event.state === "waiting_input")) waitingForUser = true;
      if (typeof threadRuntime.syncProviderSessionId === "function") {
        threadRuntime.syncProviderSessionId();
      }
      if (tracker && typeof tracker.onProviderEvent === "function") {
        tracker.onProviderEvent(event);
      }
      if (event.type === "text_delta" && event.delta) {
        if (streamToPublisher) {
          emitStreamDelta(event.delta);
        } else {
          plainReplyParts.push(String(event.delta));
        }
      } else if (event.type === "tool_call") {
        const summary = summarizeThreadToolCall(event);
        if (streamToPublisher && summary) {
          emitStreamDelta(`\nTool: ${summary}\n`);
        }
      } else if (event.type === "tool_result" && streamToPublisher) {
        const output = typeof event.output === "string" ? event.output
          : Array.isArray(event.output) ? event.output.map((block) => block && block.text || "").join("\n")
          : event.output && typeof event.output === "object" ? JSON.stringify(event.output) : "";
        if (output) emitStreamDelta(output.slice(0, 4000) + (output.endsWith("\n") ? "" : "\n"));
        if (Number.isFinite(event.exitCode) && event.exitCode !== 0) emitStreamDelta(`[exit ${event.exitCode}]\n`);
      } else if (event.type === "usage" && event.usage) {
        turnUsage = normalizeTurnUsage(event.usage);
      } else if (event.type === "turn_completed") {
        if (typeof event.finalText === "string") finalReply = event.finalText;
        if (event.usage) turnUsage = normalizeTurnUsage(event.usage);
        if (event.stopReason) stopReason = String(event.stopReason);
      } else if (event.type === "turn_failed") {
        throw new Error(event.error || `thread turn failed for ${agentType}`);
      }
    }
    if (typeof threadRuntime.syncProviderSessionId === "function") {
      threadRuntime.syncProviderSessionId();
    }
    const reply = (finalReply === undefined ? plainReplyParts.join("") : finalReply).trim();
    emitSurface({ type: waitingForUser ? "task_paused" : "task_completed", usage: turnUsage, durationMs: Date.now() - started,
      finalTextCharacters: [...reply].length, finalText: reply.slice(0, 8000) });
    if (waitingForUser && tracker?.requestUserInput) tracker.requestUserInput("reply");

    const isWorkflowHandoff = incomingSource === "workflow-handoff";
    if (streamToPublisher) {
      const doneEnvelope = { stream: true, done: true, reason: "complete" };
      if (turnUsage) doneEnvelope.usage = turnUsage;
      busSender.enqueue(publisher, JSON.stringify(doneEnvelope));
    } else if (!isWorkflowHandoff) {
      // Live progress belongs to the worker pane. Peers receive only the final
      // answer, including an explicitly empty ack-only result.
      // Workflow-handoff turns forward strictly along outgoing workflow edges below
      // rather than bouncing back to the upstream node.
      if (reply && runtimeContext.requestKind !== "system_wake") sendReply(reply);
    }

    if (!waitingForUser && reply && runtimeContext.requestKind !== "system_wake" && projectRoot && subscriber) {
      try {
        const { resolveWorkflowForwardTargets } = require("../../orchestration/groups/workflowGraph");
        const forwardTargets = resolveWorkflowForwardTargets(projectRoot, subscriber, incomingWorkflowMeta);
        for (const hop of forwardTargets) {
          if (!isWorkflowHandoff && !streamToPublisher && hop.to === publisher) continue;
          busSender.enqueue(hop.to, reply, {
            source: "workflow-handoff",
            silent: true,
            data: {
              message: reply,
              source: "workflow-handoff",
              workflow_group_id: hop.group_id,
              workflow_edge_id: hop.edge_id,
              workflow_hop: hop.next_hop,
              workflow_trail: hop.next_trail,
            },
          });
        }
      } catch {
        // never fail a completed turn due to workflow lookup errors
      }
    }
    await busSender.flush();
    return {
      ok: true,
      meta: {
        ...(turnUsage || normalizeTurnUsage(null)),
        stop_reason: stopReason,
      },
    };
  } catch (err) {
    if (tracker && typeof tracker.markIdle === "function") {
      tracker.markIdle();
    }
    const errorText = `[internal:${agentType}] error: ${err && err.message ? err.message : "unknown error"}`;
    const cancelled = signal?.aborted || err?.code === "cancelled" || err?.name === "AbortError";
    emitSurface(cancelled
      ? { type: "task_cancelled" } : { type: "task_failed", error: errorText });
    await reportLifecycle("error", errorText, { cancelled });
    if (!cancelled && threadRuntime && typeof threadRuntime.rebuildThread === "function") {
      try { await threadRuntime.rebuildThread(); }
      catch (recoveryError) { console.error(`[internal:${agentType}] recovery failed: ${recoveryError?.message || "unknown error"}`); }
    }
    // eslint-disable-next-line no-console
    console.error(errorText);
    if (streamToPublisher) {
      busSender.enqueue(
        publisher,
        JSON.stringify({ stream: true, delta: errorText })
      );
      busSender.enqueue(
        publisher,
        JSON.stringify({ stream: true, done: true, reason: "error" })
      );
    } else if (runtimeContext.requestKind !== "system_wake") {
      sendReply(errorText);
    }
    await busSender.flush();
    return { ok: false, error: errorText };
  }
}

function getWorkerThreadToolMode() {
  return normalizeWorkerThreadToolMode(process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS);
}

function buildWorkerThreadToolRuntime({ projectRoot, subscriber, observer }) {
  const mode = getWorkerThreadToolMode();
  if (mode !== "worker-tier01") {
    return {
      enabled: false,
      mode,
      tools: [],
      executeToolCall: null,
    };
  }

  const eventBus = new EventBus(projectRoot);
  const toolDefinitions = listToolsForCallerTier(CALLER_TIERS.WORKER);
  const toolsByName = new Map(toolDefinitions.map((tool) => [tool.name, tool]));
  const emitAudit = (phase, payload) => {
    if (observer && typeof observer.onToolCall === "function") {
      try { observer.onToolCall({ phase, payload }); } catch { /* ignore observer errors */ }
    }
  };

  return {
    enabled: toolDefinitions.length > 0,
    mode,
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    })),
    // Keep a shared-handler executor ready for a future continuation-capable SDK path.
    // The current Codex seam injects tool descriptors only and does not execute live
    // tool calls inside the SDK stream yet.
    async executeToolCall(toolCall = {}) {
      const name = String(toolCall.name || "").trim();
      const definition = toolsByName.get(name);
      const rawArgs = toolCall.arguments || toolCall.args || {};
      // Slice 1 (§10.7 tool pre-call): build a redacted audit envelope before
      // the handler receives args, so observability consumers never see raw secrets.
      const redactedPayload = redactToolCallPayload({
        name,
        args: rawArgs,
        tool_call_id: toolCall.tool_call_id || toolCall.toolCallId || "",
        caller_tier: CALLER_TIERS.WORKER,
      });
      emitAudit("pre_call", redactedPayload);
      if (!definition) {
        const errorResult = {
          ok: false,
          error: {
            code: "unsupported_tool",
            message: `worker tool is unavailable: ${name}`,
          },
        };
        emitAudit("post_call", { ...redactedPayload, result: errorResult });
        return errorResult;
      }

      try {
        const result = await definition.handler({
          caller_tier: CALLER_TIERS.WORKER,
          projectRoot,
          subscriber,
          eventBus,
          tool_call_id: toolCall.tool_call_id || toolCall.toolCallId || "",
          turn_id: toolCall.turn_id || toolCall.turnId || "",
        }, rawArgs);
        const safeResult = redactSecrets(result);
        emitAudit("post_call", { ...redactedPayload, result: safeResult });
        return safeResult;
      } catch (err) {
        const errorResult = {
          ok: false,
          error: {
            code: err && err.code ? err.code : "tool_execution_failed",
            message: err && err.message ? err.message : String(err || "tool execution failed"),
          },
        };
        const safeErrorResult = redactSecrets(errorResult);
        emitAudit("post_call", { ...redactedPayload, result: safeErrorResult });
        return safeErrorResult;
      }
    },
  };
}

function buildClaudeAuthProvider(projectRoot) {
  const config = loadConfig(projectRoot);
  return async () => {
    const credential = await resolveClaudeUpstreamCredentials({
      profile: config.claudeOauthProfile,
      tokenPath: config.claudeOauthTokenPath,
      refreshWindowMs: Number(config.claudeOauthRefreshWindowSec || 300) * 1000,
    });
    return buildUpstreamAuthFromCredential(credential);
  };
}

function persistProviderSessionId(projectRoot, subscriber, providerSessionId) {
  const id = String(providerSessionId || "").trim();
  if (!projectRoot || !subscriber || !id) return false;
  try {
    const agentsFile = getUfooPaths(projectRoot).agentsFile;
    if (!fs.existsSync(agentsFile)) return false;
    return updateAgentsData(agentsFile, (parsed) => {
      if (!parsed.agents || typeof parsed.agents !== "object") return false;
      if (!parsed.agents[subscriber] || typeof parsed.agents[subscriber] !== "object") {
        appendAgentRegistryDiagnostic(agentsFile, "provider_session_subscriber_missing", {
          source: "agent.internalRunner.persistProviderSessionId",
          subscriber,
          known_ids: Object.keys(parsed.agents || {}).sort(),
        });
        return false;
      }
      if (parsed.agents[subscriber].provider_session_id === id) return false;
      parsed.agents[subscriber].provider_session_id = id;
      parsed.agents[subscriber].provider_session_updated_at = new Date().toISOString();
      return true;
    });
  } catch {
    return false;
  }
}

function clearProviderSessionId(projectRoot, subscriber) {
  const id = String(subscriber || "").trim();
  if (!projectRoot || !id) return false;
  try {
    const agentsFile = getUfooPaths(projectRoot).agentsFile;
    if (!fs.existsSync(agentsFile)) return false;
    return updateAgentsData(agentsFile, (parsed) => {
      if (!parsed.agents || !parsed.agents[id]) return false;
      if (!parsed.agents[id].provider_session_id) return false;
      parsed.agents[id].provider_session_id = "";
      parsed.agents[id].provider_session_updated_at = new Date().toISOString();
      return true;
    });
  } catch {
    return false;
  }
}

function persistAgentRuntimeMeta(projectRoot, subscriber, fields = {}) {
  const id = String(subscriber || "").trim();
  if (!id || !fields || typeof fields !== "object") return false;
  const agentsFile = getUfooPaths(projectRoot).agentsFile;
  if (!fs.existsSync(agentsFile)) return false;
  try {
    return updateAgentsData(agentsFile, (parsed) => {
      if (!parsed.agents || !parsed.agents[id]) return false;
      let changed = false;
      for (const [key, val] of Object.entries(fields)) {
        if (val === undefined) continue;
        const next = String(val || "").trim();
        if (parsed.agents[id][key] !== next) {
          parsed.agents[id][key] = next;
          changed = true;
        }
      }
      if (changed) parsed.agents[id].runtime_config_updated_at = new Date().toISOString();
      return changed;
    });
  } catch {
    return false;
  }
}

function resolveInternalModel({ projectRoot, provider, extraArgs = [], env = process.env }) {
  for (let index = 0; index < extraArgs.length; index++) {
    if (["-m", "--model"].includes(extraArgs[index]) && extraArgs[index + 1]) return String(extraArgs[index + 1]);
    if (String(extraArgs[index]).startsWith("--model=")) return String(extraArgs[index]).slice(8);
  }
  if (env.UFOO_AGENT_MODEL) return String(env.UFOO_AGENT_MODEL);
  // Native ucode resolves its own provider/model in the coding host.
  if (provider === "ucode") return "";
  const config = loadConfig(projectRoot);
  return (sameModelProvider(config.agentProvider, provider) && config.agentModel)
    || defaultAgentModelForProvider(provider);
}

function resolveInternalCodexEffort(extraArgs = []) {
  for (let index = 0; index < extraArgs.length; index++) {
    if (!["-c", "--config"].includes(extraArgs[index])) continue;
    const match = String(extraArgs[index + 1] || "").match(/^model_reasoning_effort\s*=\s*["']?(none|minimal|low|medium|high|xhigh|max)["']?$/);
    if (match) return match[1];
  }
  return "medium";
}

function resolveInternalEffortArg(extraArgs = []) {
  for (let index = 0; index < extraArgs.length; index += 1) {
    const item = String(extraArgs[index] || "").trim();
    if (item === "--effort" && extraArgs[index + 1]) {
      return String(extraArgs[index + 1]).trim().toLowerCase();
    }
    if (item.startsWith("--effort=")) {
      return item.slice("--effort=".length).trim().toLowerCase();
    }
  }
  return "";
}

function createThreadRuntime({
  projectRoot,
  cwd = "",
  provider,
  model,
  thinkingLevel = "",
  extraArgs = [],
  subscriber = "",
  providerSessionId = "",
  permissionMode = "",
  systemPrompt = "",
} = {}) {
  const effectiveCwd = String(cwd || projectRoot || process.cwd());
  let currentModel = String(model || "").trim();
  let currentPermission = String(permissionMode || process.env.UFOO_PERMISSION_MODE || loadConfig(projectRoot)?.permissionMode || "auto_edit").trim();
  let currentThinking = String(thinkingLevel || process.env.UFOO_AGENT_THINKING || "").trim()
    || (provider === "codex-cli"
      ? resolveInternalCodexEffort(extraArgs)
      : (resolveInternalEffortArg(extraArgs) || loadConfig(projectRoot)?.agentThinking || "medium"));
  const disabledRuntime = {
    enabled: false,
    thread: null,
    toolRuntime: { enabled: false, mode: "disabled", tools: [] },
    configure: async () => ({ ok: false, error: "thread runtime disabled" }),
    clearContext: async () => ({ ok: false, error: "thread runtime disabled" }),
    close: async () => {},
    rebuildThread: async () => {},
    syncProviderSessionId: () => false,
  };

  const initialProviderSessionId = String(providerSessionId || "").trim();
  let savedProviderSessionId = initialProviderSessionId;

  function rememberProviderSessionId(thread) {
    const id = String(thread && thread.id ? thread.id : "").trim();
    if (!id || id === savedProviderSessionId) return false;
    const changed = persistProviderSessionId(projectRoot, subscriber, id);
    if (changed) savedProviderSessionId = id;
    return changed;
  }

  function applyRuntimePatch(patch = {}) {
    if (patch.model !== undefined) currentModel = String(patch.model || "").trim();
    const rawThinking = patch.thinking_level ?? patch.thinkingLevel;
    if (rawThinking !== undefined) currentThinking = String(rawThinking || "").trim().toLowerCase() || currentThinking;
    const rawPerm = patch.permission_mode ?? patch.permissionMode;
    if (rawPerm !== undefined) currentPermission = String(rawPerm || "").trim().toLowerCase() || currentPermission;
  }

  if (provider === "ucode") {
    const { createInternalCodingThread } = require("../../code/internalThread");
    const thread = createInternalCodingThread({
      workspaceRoot: effectiveCwd,
      model: currentModel,
      thinkingLevel: currentThinking,
      permissionMode: currentPermission,
      sessionId: initialProviderSessionId,
    });
    currentModel = String(thread.model || currentModel || "");
    currentThinking = String(thread.thinkingLevel || currentThinking || "medium");
    return {
      enabled: true, thread,
      getRuntimeState: () => ({ model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission }),
      async configure(patch = {}) {
        applyRuntimePatch(patch);
        const applied = thread.configure ? await thread.configure({
          model: patch.model,
          thinkingLevel: patch.thinking_level ?? patch.thinkingLevel,
          permissionMode: patch.permission_mode ?? patch.permissionMode,
        }) : {};
        if (applied?.model) currentModel = applied.model;
        if (applied?.thinkingLevel) currentThinking = applied.thinkingLevel;
        if (applied?.permissionMode) currentPermission = applied.permissionMode;
        return { ok: true, model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission };
      },
      syncProviderSessionId: () => rememberProviderSessionId(thread),
      async clearContext() {
        if (typeof thread.clear === "function") {
          thread.clear();
        }
        savedProviderSessionId = "";
        clearProviderSessionId(projectRoot, subscriber);
        if (thread.id) rememberProviderSessionId(thread);
        return { ok: true, session_id: thread.id || "" };
      },
      rebuildThread: async () => {},
      close: () => thread.close(),
    };
  }

  if (isAcpAgentType(provider)) {
    try {
      const acpId = extractAcpAgentId(provider);
      const mcpServers = buildAcpMcpServers({ projectRoot, subscriber });
      let providerInstance = createAcpThreadProvider({
        agentId: acpId,
        cwd: effectiveCwd,
        mcpServers,
        model: currentModel,
        thinkingLevel: currentThinking,
        permissionMode: currentPermission,
      });
      let thread = initialProviderSessionId
        ? providerInstance.resumeThread(initialProviderSessionId)
        : providerInstance.startThread();

      return {
        enabled: true,
        get thread() {
          return thread;
        },
        getRuntimeState: () => ({ model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission }),
        async configure(patch = {}) {
          applyRuntimePatch(patch);
          if (thread && typeof thread.configure === "function") {
            await thread.configure({
              model: patch.model,
              thinkingLevel: patch.thinking_level ?? patch.thinkingLevel,
              permissionMode: patch.permission_mode ?? patch.permissionMode,
            });
          }
          return { ok: true, model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission };
        },
        syncProviderSessionId() {
          return rememberProviderSessionId(thread);
        },
        async clearContext() {
          savedProviderSessionId = "";
          clearProviderSessionId(projectRoot, subscriber);
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createAcpThreadProvider({
            agentId: acpId,
            cwd: effectiveCwd,
            mcpServers: buildAcpMcpServers({ projectRoot, subscriber }),
            model: currentModel,
            thinkingLevel: currentThinking,
            permissionMode: currentPermission,
          });
          thread = providerInstance.startThread();
          return { ok: true, session_id: thread?.id || "" };
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createAcpThreadProvider({
            agentId: acpId,
            cwd: effectiveCwd,
            mcpServers: buildAcpMcpServers({ projectRoot, subscriber }),
            model: currentModel,
            thinkingLevel: currentThinking,
            permissionMode: currentPermission,
          });
          thread = savedProviderSessionId
            ? providerInstance.resumeThread(savedProviderSessionId)
            : providerInstance.startThread();
        },
        async close() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
        },
      };
    } catch (error) {
      return { ...disabledRuntime, error };
    }
  }

  if (provider === "codex-cli") {
    try {
      const toolRuntime = buildWorkerThreadToolRuntime({
        projectRoot,
        subscriber,
      });
      let providerInstance = createCodexThreadProvider({
        model: currentModel,
        cwd: effectiveCwd,
        extraArgs,
        tools: toolRuntime.tools,
        permissionMode: currentPermission,
        mcpConfig: buildCodexMcpConfig({ projectRoot, subscriber }),
        threadOptions: { modelReasoningEffort: currentThinking },
      });
      let thread = initialProviderSessionId
        ? providerInstance.resumeThread(initialProviderSessionId)
        : providerInstance.startThread();

      return {
        enabled: true,
        toolRuntime,
        get thread() {
          return thread;
        },
        getRuntimeState: () => ({ model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission }),
        async configure(patch = {}) {
          applyRuntimePatch(patch);
          if (thread && typeof thread.configure === "function") {
            const applied = thread.configure({
              model: patch.model,
              thinkingLevel: patch.thinking_level ?? patch.thinkingLevel,
              permissionMode: patch.permission_mode ?? patch.permissionMode,
            });
            if (applied?.model !== undefined) currentModel = applied.model;
            if (applied?.thinkingLevel) currentThinking = applied.thinkingLevel;
            if (applied?.permissionMode) currentPermission = applied.permissionMode;
          }
          return { ok: true, model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission };
        },
        syncProviderSessionId() {
          return rememberProviderSessionId(thread);
        },
        async clearContext() {
          savedProviderSessionId = "";
          clearProviderSessionId(projectRoot, subscriber);
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createCodexThreadProvider({
            model: currentModel,
            cwd: effectiveCwd,
            extraArgs,
            tools: toolRuntime.tools,
            permissionMode: currentPermission,
            mcpConfig: buildCodexMcpConfig({ projectRoot, subscriber }),
            threadOptions: { modelReasoningEffort: currentThinking },
          });
          thread = providerInstance.startThread();
          return { ok: true, session_id: thread?.id || "" };
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createCodexThreadProvider({
            model: currentModel,
            cwd: effectiveCwd,
            extraArgs,
            tools: toolRuntime.tools,
            permissionMode: currentPermission,
            mcpConfig: buildCodexMcpConfig({ projectRoot, subscriber }),
            threadOptions: { modelReasoningEffort: currentThinking },
          });
          thread = savedProviderSessionId
            ? providerInstance.resumeThread(savedProviderSessionId)
            : providerInstance.startThread();
        },
        async close() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
        },
      };
    } catch (error) {
      return { ...disabledRuntime, error };
    }
  }

  if (provider === "claude-cli") {
    if (typeof createClaudeThreadProvider !== "function") {
      return disabledRuntime;
    }

    const buildClaudeEffortOptions = (level) => {
      const raw = String(level || "").trim().toLowerCase();
      const mapped = raw === "xhigh" ? "max"
        : ["low", "medium", "high", "max"].includes(raw) ? raw : "";
      return mapped ? { effort: mapped } : {};
    };

    try {
      const mcpServers = buildClaudeMcpServers({ projectRoot, subscriber });
      let providerInstance = createClaudeThreadProvider({
        model: currentModel,
        cwd: effectiveCwd,
        extraArgs,
        permissionMode: currentPermission,
        mcpServers,
        agentOptions: buildClaudeEffortOptions(currentThinking),
      });
      let thread = initialProviderSessionId
        ? providerInstance.resumeThread(initialProviderSessionId)
        : providerInstance.startThread();

      return {
        enabled: true,
        get thread() {
          return thread;
        },
        getRuntimeState: () => ({ model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission }),
        async configure(patch = {}) {
          applyRuntimePatch(patch);
          if (thread && typeof thread.configure === "function") {
            const applied = thread.configure({
              model: patch.model,
              thinkingLevel: patch.thinking_level ?? patch.thinkingLevel,
              permissionMode: patch.permission_mode ?? patch.permissionMode,
            });
            if (applied?.model !== undefined) currentModel = applied.model;
            if (applied?.permissionMode) currentPermission = applied.permissionMode;
          }
          return { ok: true, model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission };
        },
        syncProviderSessionId() {
          return rememberProviderSessionId(thread);
        },
        async clearContext() {
          savedProviderSessionId = "";
          clearProviderSessionId(projectRoot, subscriber);
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createClaudeThreadProvider({
            model: currentModel,
            cwd: effectiveCwd,
            extraArgs,
            permissionMode: currentPermission,
            mcpServers: buildClaudeMcpServers({ projectRoot, subscriber }),
            agentOptions: buildClaudeEffortOptions(currentThinking),
          });
          thread = providerInstance.startThread();
          return { ok: true, session_id: thread?.id || "" };
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = createClaudeThreadProvider({
            model: currentModel,
            cwd: effectiveCwd,
            extraArgs,
            permissionMode: currentPermission,
            mcpServers: buildClaudeMcpServers({ projectRoot, subscriber }),
            agentOptions: buildClaudeEffortOptions(currentThinking),
          });
          thread = savedProviderSessionId
            ? providerInstance.resumeThread(savedProviderSessionId)
            : providerInstance.startThread();
        },
        async close() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
        },
      };
    } catch (error) {
      return { ...disabledRuntime, error };
    }
  }

  if (provider === "agy-cli") {
    try {
      const buildAgyProvider = () => createAgyThreadProvider({
        cwd: effectiveCwd,
        mcpServers: buildAcpMcpServers({ projectRoot, subscriber }),
        model: currentModel,
        thinkingLevel: currentThinking,
        permissionMode: currentPermission,
        systemPrompt,
        extraArgs,
      });
      let providerInstance = buildAgyProvider();
      let thread = initialProviderSessionId
        ? providerInstance.resumeThread(initialProviderSessionId)
        : providerInstance.startThread();

      return {
        enabled: true,
        get thread() {
          return thread;
        },
        getRuntimeState: () => ({ model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission }),
        async configure(patch = {}) {
          applyRuntimePatch(patch);
          if (thread && typeof thread.configure === "function") {
            const applied = await thread.configure({
              model: patch.model,
              thinkingLevel: patch.thinking_level ?? patch.thinkingLevel,
              permissionMode: patch.permission_mode ?? patch.permissionMode,
            });
            if (applied?.model !== undefined) currentModel = applied.model;
            if (applied?.thinkingLevel) currentThinking = applied.thinkingLevel;
            if (applied?.permissionMode) currentPermission = applied.permissionMode;
          }
          return { ok: true, model: currentModel, thinking_level: currentThinking, permission_mode: currentPermission };
        },
        syncProviderSessionId() {
          return rememberProviderSessionId(thread);
        },
        async clearContext() {
          savedProviderSessionId = "";
          clearProviderSessionId(projectRoot, subscriber);
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = buildAgyProvider();
          thread = providerInstance.startThread();
          return { ok: true, session_id: thread?.id || "" };
        },
        async rebuildThread() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
          providerInstance = buildAgyProvider();
          thread = savedProviderSessionId
            ? providerInstance.resumeThread(savedProviderSessionId)
            : providerInstance.startThread();
        },
        async close() {
          if (thread && typeof thread.close === "function") {
            await thread.close();
          }
        },
      };
    } catch (error) {
      return { ...disabledRuntime, error };
    }
  }

  return disabledRuntime;
}

async function runInternalRunner({ projectRoot, agentType = "codex", extraArgs = [] }) {
  const normalizedAgentType = normalizeInternalAgentType(agentType);
  if (!normalizedAgentType) throw new Error(`unsupported internal agent type: ${agentType}; use codex, claude, ucode, agy, or acp:<id>`);
  // Internal runner 必须由 daemon 启动，UFOO_SUBSCRIBER_ID 应该已经设置
  const { subscriber, agentType: parsedAgentType, sessionId } = parseSubscriberId();
  const nickname = process.env.UFOO_NICKNAME || "";
  const effectiveCwd = String(projectRoot);

  const queueDir = path.join(getUfooPaths(projectRoot).busQueuesDir, safeSubscriber(subscriber));
  const queueFile = path.join(queueDir, "pending.jsonl");
  const provider = isAcpAgentType(normalizedAgentType)
    ? normalizedAgentType
    : ({ ucode: "ucode", codex: "codex-cli", claude: "claude-cli", agy: "agy-cli" }[normalizedAgentType]);
  let currentModel = isAcpAgentType(normalizedAgentType) ? "" : resolveInternalModel({ projectRoot, provider, extraArgs });
  const bootstrap = resolveInternalBootstrap({
    projectRoot,
    agentType: normalizedAgentType,
    extraArgs,
    env: process.env,
  });
  const busSender = createBusSender(projectRoot, subscriber);
  const interactiveSessions = new Map();
  const threadRuntime = createThreadRuntime({
    projectRoot,
    cwd: effectiveCwd,
    provider,
    model: currentModel,
    extraArgs: bootstrap.extraArgs,
    subscriber,
    providerSessionId: process.env.UFOO_PROVIDER_SESSION_ID || "",
    permissionMode: process.env.UFOO_PERMISSION_MODE || "",
    systemPrompt: bootstrap.promptText,
  });

  if (typeof threadRuntime.getRuntimeState === "function") {
    const initialRuntime = threadRuntime.getRuntimeState();
    if (initialRuntime.model) currentModel = initialRuntime.model;
    persistAgentRuntimeMeta(projectRoot, subscriber, initialRuntime);
  }

  let running = true;
  let processing = false;
  let lastHeartbeat = 0;
  const HEARTBEAT_INTERVAL = 30000; // 30秒心跳间隔
  const runnerAbort = new AbortController();
  const { createTaskControl, startTaskControlServer } = require("./taskControl");
  const baseControl = createTaskControl(runnerAbort.signal);
  const taskControl = {
    ...baseControl,
    async configure(patch = {}) {
      if (typeof threadRuntime.configure !== "function") {
        return { ok: false, error: "Worker runtime does not support live configuration" };
      }
      const res = await threadRuntime.configure(patch);
      if (res?.ok) {
        if (res.model !== undefined) currentModel = res.model;
        persistAgentRuntimeMeta(projectRoot, subscriber, {
          model: res.model,
          thinking_level: res.thinking_level,
          permission_mode: res.permission_mode,
        });
      }
      return res;
    },
    async clear() {
      baseControl.cancel();
      interactiveSessions.clear();
      const cleared = typeof threadRuntime.clearContext === "function"
        ? await threadRuntime.clearContext()
        : { ok: true };
      busSender.surface?.({
        type: "surface_cleared",
        agentId: subscriber,
        provider,
        model: currentModel,
      });
      await busSender.flush();
      activityTracker.markIdle();
      return {
        ok: cleared?.ok !== false,
        cleared: true,
        cleared_surface: true,
        session_id: cleared?.session_id || "",
      };
    },
  };
  const controlServer = await startTaskControlServer(projectRoot, subscriber, taskControl);

  const stop = () => {
    running = false;
    runnerAbort.abort("runner_stopped");
    // Closing the provider aborts an in-flight turn, which records cancellation
    // and queues a terminal report before the runner drains and exits.
    threadRuntime.close().catch(error => console.error(`[internal] stop failed: ${error.message}`));
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const agentsFile = getUfooPaths(projectRoot).agentsFile;
  const activityPublisher = createActivityStatePublisher({
    agentsFile, subscriber, projectRoot,
  });
  const activityTracker = createActivityTracker({ publisher: activityPublisher });

  function getInteractiveSession(publisher) {
    const key = String(publisher || "unknown");
    if (interactiveSessions.has(key)) return interactiveSessions.get(key);
    const session = createInteractiveInputSession({
      write: (delta) => {
        busSender.enqueue(key, JSON.stringify({ stream: true, delta: String(delta || "") }));
      },
    });
    interactiveSessions.set(key, session);
    return session;
  }

  activityTracker.notifyStarting("runner");
  activityTracker.notifyReady("");

  // 心跳更新函数
  const updateHeartbeat = () => {
    try {
      spawnSync("ufoo", ["bus", "check", subscriber], {
        cwd: projectRoot,
        env: { ...process.env, UFOO_SUBSCRIBER_ID: subscriber },
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {
      // ignore heartbeat errors
    }
  };

  try { while (running) {
    // 定期心跳更新
    const now = Date.now();
    if (now - lastHeartbeat > HEARTBEAT_INTERVAL) {
      updateHeartbeat();
      lastHeartbeat = now;
    }

    if (!processing) {
      processing = true;
      try {
        const claims = claimQueuedEvents(queueFile);
        if (claims.length > 0) {
          let handledAny = false;

          for (const claim of claims) {
            const evt = claim.event;
            const runnableEvents = [];
            const rawInput = parseInternalRawInput(evt && evt.data ? evt.data.message : "");
            if (rawInput === null) {
              runnableEvents.push(evt);
            } else {
              const session = getInteractiveSession(evt.publisher || "unknown");
              const submissions = session.handleRaw(rawInput);
              for (const message of submissions) {
                runnableEvents.push({
                  ...evt,
                  __internalRawInput: true,
                  data: {
                    ...(evt.data || {}),
                    message,
                  },
                });
              }
            }

            if (runnableEvents.length > 0) {
              activityTracker.notifyTurnStart("thinking");
            }

            try {
              for (const runnableEvent of runnableEvents) {
                // eslint-disable-next-line no-await-in-loop
                await taskControl.run((signal) => handleEvent(
                  projectRoot,
                  parsedAgentType,
                  provider,
                  currentModel,
                  subscriber,
                  nickname,
                  runnableEvent,
                  busSender,
                  bootstrap.extraArgs,
                  threadRuntime,
                  bootstrap.promptText,
                  activityTracker,
                  signal
                ));
                if (runnableEvent.__internalRawInput) {
                  getInteractiveSession(runnableEvent.publisher || "unknown").writeResponsePrompt();
                }
              }
              claim.queue.completeClaim(claim);
              if (runnableEvents.length > 0) handledAny = true;
            } catch (err) {
              claim.queue.restoreClaim(claim);
              throw err;
            }
          }
          // 处理消息后更新心跳
          updateHeartbeat();
          lastHeartbeat = now;
          if (handledAny && activityTracker.getState().state !== "waiting_input") {
            activityTracker.markIdle();
          }
          await busSender.flush();
        }
      } finally {
        processing = false;
      }
    }
    if (running && threadRuntime.thread?.pollWakes) {
      await threadRuntime.thread.pollWakes(async (event, claim, text) => {
        if (!running || !claim()) return false;
        activityTracker.notifyTurnStart("thinking");
        try {
          await taskControl.run((signal) => handleEvent(projectRoot, parsedAgentType, provider, currentModel, subscriber, nickname,
            { publisher: "runtime", __runtimeWake: true, seq: event.id,
              data: { message: text, runtime_context: { parentTaskRunId: event.ownerTaskRunId } } },
            busSender, bootstrap.extraArgs, threadRuntime, bootstrap.promptText, activityTracker, signal));
          await busSender.flush();
        } finally { if (activityTracker.getState().state !== "waiting_input") activityTracker.markIdle(); }
        return true;
      });
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }

  } finally {
    await controlServer.close();
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await threadRuntime.close();
  }
}

module.exports = {
  runInternalRunner,
  createBusSender,
  handleEvent,
  handleThreadedEvent,
  createThreadRuntime,
  resolveInternalModel,
  resolveInternalCodexEffort,
  getWorkerThreadToolMode,
  buildWorkerThreadToolRuntime,
  normalizeWorkerThreadToolMode,
  buildClaudeAuthProvider,
  parseInternalRawInput,
  createInteractiveInputSession,
  resolveInternalBootstrap,
  persistProviderSessionId,
  clearProviderSessionId,
  persistAgentRuntimeMeta,
};
