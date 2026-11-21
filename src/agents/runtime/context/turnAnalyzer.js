"use strict";

const path = require("path");
const { replayTurnMessages } = require("./replayHistory");
const { createHash } = require("crypto");
const { historyUnits, userInstruction } = require("./contextBudget");
const { normalizeTopic } = require("./turnIndexStore");

const WRITE_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "replace_file_content",
  "create_file",
  "delete_file",
  "rm",
]);

const READ_TOOLS = new Set([
  "read",
  "read_file",
  "read_image",
  "view_file",
  "grep",
  "search",
  "find",
  "glob",
  "ls",
  "list_dir",
  "artifact_read",
]);

const SYSTEM_REQUEST_KINDS = new Set([
  "worker-report",
  "task-result",
  "system_wake",
  "wake",
  "cron",
  "schedule",
  "notification",
]);

const GENERIC_PATH_SEGMENTS = new Set([
  "src",
  "lib",
  "app",
  "test",
  "tests",
  "unit",
  "integration",
  "spec",
  "index",
  "utils",
  "helpers",
  "common",
  "shared",
  "types",
]);

const CONTINUATION_CUES = [
  /^(继续|接着|好的|可以|行|对|嗯|改一下|修一下|再试|再测|然后|顺便|还有)/,
  /^(continue|proceed|go ahead|yes|ok|okay|sure|fix that|fix it|try again|also|and then|now)\b/i,
];

const TURN_CONTEXT_SOURCE = Symbol.for("ufoo.turnContextSource");

function stripTurnContextFromMessage(message) {
  const source = message?.[TURN_CONTEXT_SOURCE];
  return source ? { ...message, content: source.originalContent } : message;
}

function extractTextFromMessage(message, { includeThinking = false } = {}) {
  if (!message || typeof message !== "object") return "";
  message = stripTurnContextFromMessage(message);
  if (typeof message.content === "string") {
    return message.content.trim();
  }
  if (!Array.isArray(message.content)) return "";
  const chunks = [];
  for (const part of message.content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text;
      if (text.trim()) chunks.push(text.trim());
    } else if (includeThinking && part.type === "thinking" && typeof part.thinking === "string") {
      if (part.thinking.trim()) chunks.push(part.thinking.trim());
    }
  }
  return chunks.join("\n").trim();
}

function extractToolCalls(message) {
  const calls = [];
  if (!message || typeof message !== "object") return calls;
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (!tc) continue;
      const fn = tc.function || tc;
      let parsedArgs = {};
      if (fn.arguments && typeof fn.arguments === "object") parsedArgs = fn.arguments;
      else if (typeof fn.arguments === "string") {
        try { parsedArgs = JSON.parse(fn.arguments); } catch { parsedArgs = { raw: fn.arguments }; }
      } else if (tc.input && typeof tc.input === "object") {
        parsedArgs = tc.input;
      }
      calls.push({ id: tc.id || "", name: String(fn.name || tc.name || ""), args: parsedArgs });
    }
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_use") {
        calls.push({
          id: part.id || "",
          name: String(part.name || ""),
          args: part.input && typeof part.input === "object" ? part.input : {},
        });
      }
    }
  }
  return calls;
}

function extractToolResultTexts(message) {
  const texts = [];
  if (!message || typeof message !== "object") return texts;
  if (message.role === "tool") {
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n")
        : "";
    if (content.trim()) texts.push(content.trim());
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === "tool_result") {
        const body = typeof part.content === "string"
          ? part.content
          : Array.isArray(part.content)
            ? part.content.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n")
            : "";
        if (body.trim()) texts.push(body.trim());
      }
    }
  }
  return texts;
}

function normalizeCandidatePath(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = raw.trim().replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/");
  if (!cleaned || cleaned.length > 260) return "";
  if (/^https?:\/\//i.test(cleaned)) return "";
  if (/\s/.test(cleaned) && !cleaned.includes("/")) return "";
  return cleaned.replace(/^\.\//, "");
}

function addPathsFromArgs(args, targetSet, artifactSet) {
  if (!args || typeof args !== "object") return;
  const pathKeys = ["path", "file_path", "target_file", "file", "target", "source", "destination", "cwd"];
  for (const key of pathKeys) {
    if (typeof args[key] === "string") {
      const normalized = normalizeCandidatePath(args[key]);
      if (normalized && (normalized.includes("/") || /\.[a-zA-Z0-9]{1,8}$/.test(normalized))) {
        targetSet.add(normalized);
      }
    }
  }
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) {
      const normalized = normalizeCandidatePath(entry);
      if (normalized) targetSet.add(normalized);
    }
  }
  for (const artKey of ["id", "artifact_id", "artifactId"]) {
    if (typeof args[artKey] === "string" && args[artKey].trim()) {
      artifactSet.add(args[artKey].trim());
    }
  }
  if (typeof args.patch === "string" || typeof args.diff === "string" || typeof args.raw === "string") {
    const patchBody = args.patch || args.diff || args.raw || "";
    const patchMatches = patchBody.match(/(?:^\+\+\+\s+b\/|\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+)([^\r\n]+)/gm) || [];
    for (const line of patchMatches) {
      const pathPart = line.replace(/^\+\+\+\s+b\//, "").replace(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+/, "").trim();
      const normalized = normalizeCandidatePath(pathPart);
      if (normalized) targetSet.add(normalized);
    }
  }
}

function summarizeAction(call) {
  const name = call.name || "tool";
  const args = call.args || {};
  const target = args.path || args.file_path || args.target_file || args.file || args.id || args.artifact_id || args.query || args.pattern || args.command || args.cmd || "";
  const compactTarget = String(target).replace(/\s+/g, " ").trim().slice(0, 72);
  return compactTarget ? `${name}(${compactTarget})` : name;
}

function extractTechnicalKeywords(texts = []) {
  const seen = new Set();
  const keywords = [];
  const push = (word) => {
    const cleaned = String(word || "").trim();
    if (!cleaned || cleaned.length < 3 || cleaned.length > 80 || seen.has(cleaned)) return;
    seen.add(cleaned);
    keywords.push(cleaned);
  };

  const combined = texts.filter(Boolean).join("\n");
  // Backtick-quoted identifiers and paths
  const codeSpans = combined.match(/`([^`\n]{2,72})`/g) || [];
  for (const span of codeSpans) {
    push(span.slice(1, -1).trim());
    if (keywords.length >= 40) break;
  }

  // camelCase, snake_case, UPPER_SNAKE_CASE, alphanumeric codes with digits/underscores
  const idMatches = combined.match(/\b(?:[a-z]+(?:[A-Z][a-zA-Z0-9]*)+|[a-zA-Z]+_[a-zA-Z0-9_]+|[A-Z]{2,}_[A-Z0-9_]+|[a-zA-Z]+-[a-zA-Z0-9-]*[0-9][a-zA-Z0-9-]*)\b/g) || [];
  for (const id of idMatches) {
    push(id);
    if (keywords.length >= 48) break;
  }

  return keywords;
}

function compressSummary(text, maxChars = 280) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > maxChars ? `${cleaned.slice(0, Math.max(0, maxChars - 3))}...` : cleaned;
}

function inferDeterministicTopic({
  topicHint,
  turnKind,
  rawUserText,
  touchedFiles,
  modifiedFiles,
  previousTurns,
}) {
  if (topicHint && String(topicHint).trim()) {
    return normalizeTopic(topicHint);
  }

  const prevUserTurns = (previousTurns || []).filter((item) => item && item.turnKind !== "system_wake");
  const lastTurn = (previousTurns || [])[(previousTurns || []).length - 1] || null;
  const lastUserTurn = prevUserTurns[prevUserTurns.length - 1] || lastTurn;

  if (turnKind === "system_wake") {
    if (lastUserTurn && lastUserTurn.topic && lastUserTurn.topic !== "general") {
      return lastUserTurn.topic;
    }
    return "system-wake";
  }

  if (turnKind === "resumed_interaction" && lastUserTurn && lastUserTurn.topic) {
    return lastUserTurn.topic;
  }

  const touchedSet = new Set([...(modifiedFiles || []), ...(touchedFiles || [])]);
  if (lastUserTurn && lastUserTurn.topic && lastUserTurn.topic !== "general") {
    const prevFiles = new Set([...(lastUserTurn.modifiedFiles || []), ...(lastUserTurn.touchedFiles || [])]);
    for (const f of touchedSet) {
      if (prevFiles.has(f)) return lastUserTurn.topic;
    }
    const textTrimmed = String(rawUserText || "").trim();
    if (textTrimmed && textTrimmed.length <= 64 && CONTINUATION_CUES.some((re) => re.test(textTrimmed))) {
      return lastUserTurn.topic;
    }
  }

  const prioritizedPaths = [...(modifiedFiles || []), ...(touchedFiles || [])];
  for (const filePath of prioritizedPaths) {
    const segments = filePath.split("/").filter(Boolean);
    const meaningful = [];
    for (let i = 0; i < segments.length; i += 1) {
      const rawSeg = i === segments.length - 1 ? segments[i].replace(/\.[a-z0-9]+$/i, "") : segments[i];
      const lower = rawSeg.toLowerCase();
      if (!lower || GENERIC_PATH_SEGMENTS.has(lower)) continue;
      meaningful.push(lower);
    }
    if (meaningful.length >= 2) {
      return normalizeTopic(`${meaningful[meaningful.length - 2]}-${meaningful[meaningful.length - 1]}`);
    }
    if (meaningful.length === 1) {
      return normalizeTopic(meaningful[0]);
    }
  }

  const asciiTerm = String(rawUserText || "").match(/\b([a-zA-Z][a-zA-Z0-9_-]{2,24})\b/);
  if (asciiTerm && !/^(the|and|for|with|this|that|please|help|fix|add|check|run)$/i.test(asciiTerm[1])) {
    return normalizeTopic(asciiTerm[1]);
  }
  const cjkTerm = String(rawUserText || "").match(/[\u4e00-\u9fff]{2,8}/);
  if (cjkTerm) {
    return normalizeTopic(cjkTerm[0]);
  }

  return "general";
}

function classifyTurnKind({ requestKind = "user", prompt = "", turnMessages = [], resume = false } = {}) {
  const normalizedKind = String(requestKind || "user").trim().toLowerCase();
  if (SYSTEM_REQUEST_KINDS.has(normalizedKind)) {
    return "system_wake";
  }
  if (resume || normalizedKind === "resumed_interaction") {
    return "resumed_interaction";
  }
  const firstUser = (turnMessages || []).find((m) => m && m.role === "user");
  const instruction = firstUser ? userInstruction(stripTurnContextFromMessage(firstUser)) : "";
  if (!instruction && !String(prompt || "") && (turnMessages || []).length > 0) {
    const hasToolResults = (turnMessages || []).some((m) => m && (m.role === "tool" || (Array.isArray(m.content) && m.content.some((p) => p && p.type === "tool_result"))));
    if (hasToolResults) return "tool_continuation";
  }
  return "user";
}

function buildDeterministicTurnRecord({
  turnId,
  turnIndex = 0,
  historyOffset = 0,
  historyEnd,
  turnMessages = [],
  requestKind = "user",
  prompt = "",
  outcome = "completed",
  error = "",
  startedAt,
  endedAt,
  previousTurns = [],
  topicHint = "",
  resume = false,
} = {}) {
  const safeId = String(turnId || `turn_${String(turnIndex).padStart(4, "0")}`).trim();
  const messages = Array.isArray(turnMessages) ? turnMessages : [];
  const turnKind = classifyTurnKind({ requestKind, prompt, turnMessages: messages, resume });

  const userTexts = [];
  const assistantTexts = [];
  const toolResultTexts = [];
  const touchedFiles = new Set();
  const modifiedFiles = new Set();
  const artifactIds = new Set();
  const keyActions = [];
  const decisions = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "user") {
      const instruction = userInstruction(stripTurnContextFromMessage(msg)) || extractTextFromMessage(msg);
      if (instruction) userTexts.push(instruction);
    } else if (msg.role === "assistant") {
      const text = extractTextFromMessage(msg);
      if (text) assistantTexts.push(text);
      const calls = extractToolCalls(msg);
      for (const call of calls) {
        keyActions.push(summarizeAction(call));
        const callFiles = new Set();
        addPathsFromArgs(call.args, callFiles, artifactIds);
        for (const file of callFiles) {
          touchedFiles.add(file);
          if (WRITE_TOOLS.has(call.name)) {
            modifiedFiles.add(file);
          } else if (!READ_TOOLS.has(call.name) && /write|edit|patch|create|delete/i.test(call.name)) {
            modifiedFiles.add(file);
          }
        }
      }
    }
    for (const resultText of extractToolResultTexts(msg)) {
      toolResultTexts.push(resultText);
      const artifactMatch = resultText.match(/"artifactId"\s*:\s*"([^"]+)"|artifacts\/[^/\s]+\/([a-zA-Z0-9._-]+)/g) || [];
      for (const hit of artifactMatch) {
        const quoted = hit.match(/"artifactId"\s*:\s*"([^"]+)"/);
        if (quoted && quoted[1]) artifactIds.add(quoted[1]);
        const pathHit = hit.match(/artifacts\/[^/\s]+\/([a-zA-Z0-9._-]+)/);
        if (pathHit && pathHit[1]) artifactIds.add(pathHit[1]);
      }
    }
  }

  const cleanedPrompt = String(prompt || "");
  const rawUserText = userTexts[0] || cleanedPrompt || (turnKind === "system_wake" ? `[${requestKind}]` : "");
  const finalAssistantText = assistantTexts[assistantTexts.length - 1] || "";

  let assistantSummary = compressSummary(finalAssistantText, 420);
  if (!assistantSummary && error) {
    assistantSummary = compressSummary(`[${outcome}] ${error}`, 420);
  } else if (outcome !== "completed" && error && !assistantSummary.includes(error)) {
    assistantSummary = compressSummary(`${assistantSummary ? `${assistantSummary} ` : ""}[${outcome}: ${error}]`, 420);
  }

  if (outcome === "failed" && error) {
    decisions.push(compressSummary(`Failed: ${error}`, 180));
  } else if (outcome === "cancelled" || outcome === "interrupted") {
    decisions.push(compressSummary(`${outcome}: ${error || "stopped before completion"}`, 180));
  } else if (outcome === "paused") {
    decisions.push("Paused waiting for user input");
  }

  const userSummaryPrefix = turnKind === "system_wake" ? `[wake:${requestKind}] ` : "";
  const userSummary = compressSummary(`${userSummaryPrefix}${rawUserText}`, 240);
  const touchedList = [...touchedFiles];
  const modifiedList = [...modifiedFiles];
  const artifactList = [...artifactIds];
  const topic = inferDeterministicTopic({
    topicHint,
    turnKind,
    rawUserText,
    touchedFiles: touchedList,
    modifiedFiles: modifiedList,
    previousTurns,
  });

  const keywords = extractTechnicalKeywords([
    rawUserText,
    finalAssistantText,
    error,
    ...touchedList,
    ...toolResultTexts.slice(-2),
  ]);

  const resolvedHistoryEnd = Number.isInteger(historyEnd) && historyEnd >= historyOffset
    ? historyEnd
    : historyOffset + messages.length;

  const contentHash = createHash("sha256")
    .update(JSON.stringify({
      turnKind,
      outcome,
      rawUserText,
      assistantSummary,
      modifiedList,
      touchedList,
      keyActions: keyActions.slice(0, 12),
    }))
    .digest("hex")
    .slice(0, 16);

  return {
    turnId: safeId,
    turnIndex,
    historyOffset,
    historyEnd: resolvedHistoryEnd,
    turnKind,
    outcome,
    startedAt: startedAt || new Date().toISOString(),
    endedAt: endedAt || new Date().toISOString(),
    topic,
    rawUserText,
    userSummary,
    assistantSummary,
    keyActions: keyActions.slice(0, 24),
    touchedFiles: touchedList,
    modifiedFiles: modifiedList,
    artifactIds: artifactList,
    decisions,
    keywords,
    enrichmentVersion: 1,
    enrichedAt: null,
    contentHash,
  };
}

function backfillMissingTurns({
  store,
  runtimeEvents = null,
  journalMessages = null,
} = {}) {
  if (!store) return [];
  const existingTurns = store.listTurns();
  const byId = new Map(existingTurns.map((t) => [t.turnId, t]));
  const runningTurns = [...existingTurns];
  const added = [];

  if (Array.isArray(runtimeEvents) && runtimeEvents.length) {
    const accepted = new Map();
    const terminalByTask = new Map();
    for (const event of runtimeEvents) {
      if (!event || !event.taskRunId) continue;
      if (event.type === "request.accepted") {
        accepted.set(event.taskRunId, event);
      } else if (["task.completed", "task.failed", "task.cancelled", "task.interrupted"].includes(event.type)) {
        terminalByTask.set(event.taskRunId, event);
      }
    }
    let cursor = 0;
    let replayTurnIndex = 0;
    // Match replayHistory: accepted order, one final event per task, no paused snapshots.
    for (const [taskRunId, start] of accepted) {
      const event = terminalByTask.get(taskRunId);
      if (!event) continue;
      const turnIndex = replayTurnIndex++;
      const turnMessages = replayTurnMessages(start.request, event);
      const historyOffset = cursor;
      const historyEnd = cursor + turnMessages.length;
      cursor = historyEnd;
      const outcome = event.type.replace(/^task\./, "");
      const existing = byId.get(event.taskRunId);
      const shouldUpdate = !existing || existing.historyEnd !== historyEnd
        || existing.historyOffset !== historyOffset || existing.outcome !== outcome;
      if (!shouldUpdate) continue;
      const record = buildDeterministicTurnRecord({
        turnId: event.taskRunId,
        turnIndex: existing ? existing.turnIndex : turnIndex,
        historyOffset,
        historyEnd,
        turnMessages,
        requestKind: start.requestKind || (start.request?.report ? "worker-report" : start.request?.parentTaskRunId ? "task-result" : "user"),
        prompt: start.request?.text || start.text || "",
        outcome,
        error: event.error || event.result?.error || "",
        startedAt: start.ts || event.ts,
        endedAt: event.ts,
        previousTurns: runningTurns,
      });
      const saved = store.upsertTurn(record, { phase: "A" });
      if (!existing) runningTurns.push(saved);
      else {
        const idx = runningTurns.findIndex((t) => t.turnId === saved.turnId);
        if (idx >= 0) runningTurns[idx] = saved;
      }
      byId.set(saved.turnId, saved);
      added.push(saved);
    }
    return added;
  }

  if (Array.isArray(journalMessages) && journalMessages.length) {
    // Reconcile any overshot historyEnd from in-turn ephemeral messages so
    // adjacent indexed turns form a contiguous partition of journalMessages.
    for (let k = 0; k < runningTurns.length; k += 1) {
      const cur = runningTurns[k];
      if (!cur || !Number.isInteger(cur.historyOffset)) continue;
      const nextTurn = runningTurns[k + 1];
      const maxEnd = nextTurn && Number.isInteger(nextTurn.historyOffset) && nextTurn.historyOffset > cur.historyOffset
        ? nextTurn.historyOffset
        : (journalMessages.length >= cur.historyOffset ? journalMessages.length : cur.historyEnd);
      if (Number.isInteger(maxEnd) && maxEnd > cur.historyOffset && cur.historyEnd > maxEnd) {
        const repaired = store.upsertTurn({
          ...cur,
          historyEnd: maxEnd,
        }, { phase: "A" });
        runningTurns[k] = repaired;
        byId.set(repaired.turnId, repaired);
      }
    }
    const reconciledTurns = runningTurns.slice();
    const units = historyUnits(journalMessages);
    const groupedTurns = [];
    for (const unit of units) {
      if (!unit.complete) {
        if (groupedTurns.length) {
          const prev = groupedTurns[groupedTurns.length - 1];
          prev.end = unit.end;
          prev.messages.push(...unit.messages);
          prev.complete = false;
        }
        continue;
      }
      const first = unit.messages[0];
      const startsNewUserTurn = Boolean(first && first.role === "user" && userInstruction(first));
      if (!groupedTurns.length || startsNewUserTurn) {
        groupedTurns.push({
          start: unit.start,
          end: unit.end,
          complete: unit.complete,
          messages: [...unit.messages],
        });
      } else {
        const prev = groupedTurns[groupedTurns.length - 1];
        prev.end = unit.end;
        prev.messages.push(...unit.messages);
      }
    }
    for (let i = 0; i < groupedTurns.length; i += 1) {
      const group = groupedTurns[i];
      if (!group.complete) continue;
      const alreadyCovered = reconciledTurns.some(
        (t) => t.historyOffset === group.start || (t.historyOffset <= group.start && t.historyEnd >= group.end)
      );
      if (alreadyCovered) continue;
      const turnId = `journal_turn_${String(group.start).padStart(4, "0")}`;
      const record = buildDeterministicTurnRecord({
        turnId,
        turnIndex: runningTurns.length,
        historyOffset: group.start,
        historyEnd: group.end,
        turnMessages: group.messages,
        requestKind: "user",
        outcome: "completed",
        previousTurns: runningTurns,
      });
      const saved = store.upsertTurn(record, { phase: "A" });
      runningTurns.push(saved);
      added.push(saved);
    }
  }

  return added;
}

function parseJsonObjectLenient(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  const fenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(fenced);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = fenced.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function createAsyncTurnEnricher({
  store,
  runAuxModel = null,
  enabled = false,
  timeoutMs = 8000,
  maxQueue = 32,
  onEvent = null,
} = {}) {
  let closed = false;
  let running = false;
  let drainPromise = null;
  let activeController = null;
  let activeTimer = null;
  const queue = [];

  async function processOne(item) {
    const { turn, expectedHash, requestContext } = item;
    if (closed || typeof runAuxModel !== "function") return;
    activeController = new AbortController();
    let timedOut = false;
    activeTimer = setTimeout(() => {
      timedOut = true;
      if (activeController) activeController.abort();
    }, Math.max(200, Number(timeoutMs) || 8000));
    if (typeof activeTimer.unref === "function") activeTimer.unref();

    try {
      const raw = await runAuxModel({
        purpose: "turn_enrich",
        requestContext,
        turn,
        existingTopics: store.listTopics().slice(0, 12),
        signal: activeController.signal,
      });
      if (closed || timedOut || !raw) return;
      const parsed = typeof raw === "object" ? raw : parseJsonObjectLenient(raw);
      if (!parsed) return;
      store.upsertTurn({
        turnId: turn.turnId,
        topic: parsed.topic,
        userSummary: parsed.userSummary,
        assistantSummary: parsed.assistantSummary,
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
        enrichmentVersion: 2,
        enrichedAt: new Date().toISOString(),
      }, { phase: "B", expectedHash });
      if (typeof onEvent === "function") {
        try { onEvent({ type: "context.turn_enriched", taskRunId: turn.turnId, turnId: turn.turnId, topic: parsed.topic || turn.topic }); } catch {}
      }
    } catch {
      // Never break runtime loop on optional enrichment failure.
    } finally {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
      activeController = null;
    }
  }

  function startDrain() {
    if (running || closed || !queue.length) return;
    running = true;
    drainPromise = (async () => {
      try {
        while (!closed && queue.length) {
          const next = queue.shift();
          await processOne(next);
        }
      } finally {
        running = false;
        drainPromise = null;
      }
    })();
  }

  function enqueue(turnRecord, requestContext) {
    if (closed || !enabled || typeof runAuxModel !== "function") return false;
    if (!turnRecord || !turnRecord.turnId) return false;
    const existingIdx = queue.findIndex((item) => item.turn.turnId === turnRecord.turnId);
    const entry = { turn: turnRecord, expectedHash: turnRecord.contentHash || "", requestContext };
    if (existingIdx >= 0) {
      queue[existingIdx] = entry;
    } else {
      if (queue.length >= maxQueue) queue.shift();
      queue.push(entry);
    }
    startDrain();
    return true;
  }

  async function flush() {
    if (drainPromise) {
      await drainPromise;
    }
  }

  function close() {
    closed = true;
    queue.length = 0;
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    if (activeController) {
      try { activeController.abort(); } catch {}
      activeController = null;
    }
  }

  return Object.freeze({
    enqueue,
    flush,
    close,
    pendingCount: () => queue.length + (running ? 1 : 0),
  });
}

module.exports = {
  TURN_CONTEXT_SOURCE,
  stripTurnContextFromMessage,
  classifyTurnKind,
  buildDeterministicTurnRecord,
  backfillMissingTurns,
  createAsyncTurnEnricher,
  parseJsonObjectLenient,
  extractTextFromMessage,
};
