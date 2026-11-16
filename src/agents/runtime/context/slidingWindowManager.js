"use strict";

const { estimateTextTokens, estimateMessagesTokens, historyUnits, userInstruction } = require("./contextBudget");
const { resolveModelContextLimit } = require("./contextWindow");
const { createTopicSelector } = require("./topicSelector");
const { normalizeTopic } = require("./turnIndexStore");
const {
  stripTurnContextWrapper,
  stripTurnContextFromContent,
  extractTextFromMessage,
} = require("./turnAnalyzer");

const STABLE_HISTORY_BOUNDARY_SYMBOL = Symbol.for("ufoo.stableHistoryBoundary");

const DEFAULT_V2_POLICY = Object.freeze({
  rawTurnCount: 5,
  hardMaxTurns: 10,
  stepSize: 2,
  hotTopicThreshold: 3,
  hotWindowLookback: 5,
  hardHotBudgetRatio: 0.45,
  maxSystemWakeTurns: 2,
  minKeepTurns: 2,
  maxOutputTokens: 32768,
  triggerRatio: 0.85,
  maxTurnContextRatio: 0.25,
  maxToolResultCharsLevel1: 1200,
  maxToolResultCharsLevel3: 480,
});

function copyOwnSymbols(source, target) {
  if (!source || !target || typeof source !== "object" || typeof target !== "object") return target;
  for (const sym of Object.getOwnPropertySymbols(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, sym);
    if (desc) Object.defineProperty(target, sym, desc);
  }
  return target;
}

function cloneMessageClean(msg) {
  if (!msg || typeof msg !== "object") return msg;
  if (msg.role !== "user") return msg;
  if (typeof msg.content === "string") {
    const stripped = stripTurnContextWrapper(msg.content);
    if (stripped === msg.content) return msg;
    return copyOwnSymbols(msg, { ...msg, content: stripped });
  }
  if (Array.isArray(msg.content)) {
    const stripped = stripTurnContextFromContent(msg.content);
    const changed = stripped.length !== msg.content.length || stripped.some((part, idx) => part !== msg.content[idx]);
    if (!changed) return msg;
    return copyOwnSymbols(msg, { ...msg, content: stripped });
  }
  return msg;
}

function attachTurnContextToMessage(msg, turnContextXml) {
  if (!turnContextXml || !msg || typeof msg !== "object") return msg;
  const cleaned = cloneMessageClean(msg);
  const base = cleaned === msg ? copyOwnSymbols(msg, { ...msg }) : cleaned;
  if (typeof base.content === "string") {
    base.content = base.content ? `${turnContextXml}\n\n${base.content}` : turnContextXml;
    return base;
  }
  if (Array.isArray(base.content)) {
    const parts = base.content.slice();
    // Place <turn_context> before regular user text while keeping tool_result blocks intact.
    const firstNonToolIdx = parts.findIndex((p) => !p || p.type !== "tool_result");
    const block = { type: "text", text: turnContextXml };
    if (firstNonToolIdx === -1) {
      parts.push(block);
    } else {
      parts.splice(firstNonToolIdx, 0, block);
    }
    base.content = parts;
    return base;
  }
  base.content = turnContextXml;
  return base;
}

function clampString(text, maxChars) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  const marker = "\n...[truncated; re-read source or recall earlier turns]...\n";
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.floor(remaining * 0.6);
  const tail = remaining - head;
  return `${s.slice(0, head)}${marker}${tail ? s.slice(-tail) : ""}`;
}

function truncateToolResultsInMessage(msg, maxChars) {
  if (!msg || typeof msg !== "object") return msg;
  if (msg.role === "tool") {
    if (typeof msg.content === "string" && msg.content.length > maxChars) {
      return copyOwnSymbols(msg, { ...msg, content: clampString(msg.content, maxChars) });
    }
    if (Array.isArray(msg.content)) {
      let changed = false;
      const next = msg.content.map((part) => {
        if (part && part.type === "text" && typeof part.text === "string" && part.text.length > maxChars) {
          changed = true;
          return { ...part, text: clampString(part.text, maxChars) };
        }
        return part;
      });
      return changed ? copyOwnSymbols(msg, { ...msg, content: next }) : msg;
    }
    return msg;
  }
  if (msg.role === "user" && Array.isArray(msg.content)) {
    let changed = false;
    const next = msg.content.map((part) => {
      if (part && part.type === "tool_result") {
        if (typeof part.content === "string" && part.content.length > maxChars) {
          changed = true;
          return { ...part, content: clampString(part.content, maxChars) };
        }
        if (Array.isArray(part.content)) {
          let innerChanged = false;
          const inner = part.content.map((sub) => {
            if (sub && sub.type === "text" && typeof sub.text === "string" && sub.text.length > maxChars) {
              innerChanged = true;
              return { ...sub, text: clampString(sub.text, maxChars) };
            }
            return sub;
          });
          if (innerChanged) {
            changed = true;
            return { ...part, content: inner };
          }
        }
      }
      return part;
    });
    return changed ? copyOwnSymbols(msg, { ...msg, content: next }) : msg;
  }
  return msg;
}

function buildTopicMapBlock(offWindowTurns = [], maxTopics = 16) {
  if (!offWindowTurns.length) return "";
  const byTopic = new Map();
  for (const turn of offWindowTurns) {
    const topic = normalizeTopic(turn.topic);
    const existing = byTopic.get(topic);
    if (!existing) {
      byTopic.set(topic, {
        topic,
        count: 1,
        files: new Set(turn.modifiedFiles || []),
        lastTurnIndex: turn.turnIndex || 0,
      });
    } else {
      existing.count += 1;
      existing.lastTurnIndex = Math.max(existing.lastTurnIndex, turn.turnIndex || 0);
      for (const f of turn.modifiedFiles || []) existing.files.add(f);
    }
  }
  const rows = [...byTopic.values()]
    .sort((a, b) => b.lastTurnIndex - a.lastTurnIndex)
    .slice(0, maxTopics)
    .map((entry) => {
      const files = [...entry.files].slice(0, 3);
      const filePart = files.length ? ` | modified: ${files.join(", ")}` : "";
      return `- ${entry.topic} (${entry.count} turns${filePart})`;
    });
  return [
    `<topic_map off_window_turns="${offWindowTurns.length}">`,
    ...rows,
    "Note: Use recall_turn(query/topic/turn_id) to inspect older turn details not shown verbatim below.",
    "</topic_map>",
  ].join("\n");
}

function buildSelectedTurnsBlock(selectedTurns = [], maxCharsPerTurn = 480) {
  if (!selectedTurns.length) return "";
  const blocks = selectedTurns.map((turn) => {
    const parts = [
      `[${turn.turnId} | topic=${turn.topic || "general"} | kind=${turn.turnKind || "user"} | outcome=${turn.outcome || "completed"}]`,
    ];
    if (turn.userSummary || turn.rawUserText) {
      parts.push(`User: ${String(turn.userSummary || turn.rawUserText).slice(0, 180)}`);
    }
    if (turn.assistantSummary) {
      parts.push(`Result: ${String(turn.assistantSummary).slice(0, 220)}`);
    }
    const files = [...new Set([...(turn.modifiedFiles || []), ...(turn.touchedFiles || [])])].slice(0, 5);
    if (files.length) parts.push(`Files: ${files.join(", ")}`);
    if (Array.isArray(turn.decisions) && turn.decisions.length) {
      parts.push(`Notes: ${turn.decisions.slice(0, 2).join("; ").slice(0, 160)}`);
    }
    if (Array.isArray(turn.keywords) && turn.keywords.length) {
      parts.push(`Keywords: ${turn.keywords.slice(0, 6).join(", ")}`);
    }
    const joined = parts.join("\n");
    return joined.length > maxCharsPerTurn ? `${joined.slice(0, maxCharsPerTurn - 3)}...` : joined;
  });
  return [
    `<relevant_turns count="${selectedTurns.length}">`,
    ...blocks,
    "</relevant_turns>",
  ].join("\n");
}

function buildTurnContextXml({
  offWindowTurns = [],
  selectedTurns = [],
  maxTopics = 16,
  maxSelected = 5,
  maxCharsPerTurn = 480,
} = {}) {
  if (!offWindowTurns.length) return "";
  const sections = [];
  const topicMap = buildTopicMapBlock(offWindowTurns, maxTopics);
  if (topicMap) sections.push(topicMap);
  const l2 = buildSelectedTurnsBlock(selectedTurns.slice(0, maxSelected), maxCharsPerTurn);
  if (l2) sections.push(l2);
  if (!sections.length) return "";
  return `<turn_context>\n${sections.join("\n")}\n</turn_context>`;
}

function groupMessagesIntoTurnUnits(messages = [], baseOffset = 0, idPrefix = "tail") {
  if (!Array.isArray(messages) || !messages.length) return [];
  const rawUnits = historyUnits(messages);
  const grouped = [];
  for (const unit of rawUnits) {
    const first = unit.messages[0];
    const startsNewTurn = Boolean(first && first.role === "user" && userInstruction(first));
    if (!grouped.length || startsNewTurn) {
      grouped.push({
        start: baseOffset + unit.start,
        end: baseOffset + unit.end,
        messages: unit.messages.map(cloneMessageClean),
      });
    } else {
      const prev = grouped[grouped.length - 1];
      prev.end = baseOffset + unit.end;
      prev.messages.push(...unit.messages.map(cloneMessageClean));
    }
  }
  return grouped.map((g) => ({
    turnId: `${idPrefix}_${g.start}`,
    turnKind: "user",
    topic: "general",
    start: g.start,
    end: g.end,
    messages: g.messages,
  }));
}

function partitionHistoricalMessages(historicalMessages = [], indexedTurns = []) {
  if (!historicalMessages.length) return [];
  const total = historicalMessages.length;

  // Prefer turn-aligned slices from turnIndexStore when offsets fit cleanly within history.
  const alignedUnits = [];
  let cursor = 0;
  const byOffset = new Map();
  for (const t of indexedTurns) {
    if (!t || !Number.isInteger(t.historyOffset) || !Number.isInteger(t.historyEnd)) continue;
    if (t.historyEnd <= t.historyOffset || t.historyOffset >= total) continue;
    byOffset.set(t.historyOffset, t);
  }
  const sortedTurns = [...byOffset.values()].sort((a, b) => a.historyOffset - b.historyOffset);

  for (let i = 0; i < sortedTurns.length; i += 1) {
    const turn = sortedTurns[i];
    const nextStart = i + 1 < sortedTurns.length ? sortedTurns[i + 1].historyOffset : total;
    if (turn.historyOffset > cursor) {
      const gapEnd = Math.min(turn.historyOffset, total);
      alignedUnits.push(...groupMessagesIntoTurnUnits(historicalMessages.slice(cursor, gapEnd), cursor, "gap"));
      cursor = gapEnd;
    }
    const effectiveStart = Math.max(cursor, turn.historyOffset);
    const effectiveEnd = Math.min(turn.historyEnd, nextStart, total);
    if (effectiveEnd > effectiveStart) {
      alignedUnits.push({
        turnId: turn.turnId,
        turnKind: turn.turnKind || "user",
        topic: normalizeTopic(turn.topic),
        start: effectiveStart,
        end: effectiveEnd,
        messages: historicalMessages.slice(effectiveStart, effectiveEnd).map(cloneMessageClean),
      });
      cursor = effectiveEnd;
    }
  }

  if (cursor < total) {
    alignedUnits.push(...groupMessagesIntoTurnUnits(historicalMessages.slice(cursor), cursor, "tail"));
  }

  return alignedUnits;
}

function selectWindowUnits({
  units = [],
  policy = DEFAULT_V2_POLICY,
  windowState = null,
  availableHistoryBudget = 32000,
  targetKeepOverride = null,
} = {}) {
  if (!units.length) {
    return { keptUnits: [], keptUserTurnCount: 0, targetKeep: policy.rawTurnCount, anchorTurnId: "" };
  }

  // Hot-topic expansion: >= hotTopicThreshold of recent user turns share same non-general topic.
  const userUnits = units.filter((u) => u.turnKind !== "system_wake");
  const recentForHot = userUnits.slice(-policy.hotWindowLookback);
  const topicCounts = new Map();
  for (const unit of recentForHot) {
    if (!unit.topic || unit.topic === "general") continue;
    topicCounts.set(unit.topic, (topicCounts.get(unit.topic) || 0) + 1);
  }
  let hasHotTopic = false;
  for (const count of topicCounts.values()) {
    if (count >= policy.hotTopicThreshold) {
      hasHotTopic = true;
      break;
    }
  }

  let targetUserTurns = targetKeepOverride !== null ? targetKeepOverride : policy.rawTurnCount;
  if (targetKeepOverride === null && hasHotTopic) {
    // Expand up to hardMaxTurns while respecting 45% hard hot budget cap.
    const hotBudget = Math.floor(availableHistoryBudget * policy.hardHotBudgetRatio);
    let cumulative = 0;
    let expanded = 0;
    for (let i = userUnits.length - 1; i >= 0 && expanded < policy.hardMaxTurns; i -= 1) {
      const unitTokens = estimateMessagesTokens(userUnits[i].messages);
      if (expanded >= policy.rawTurnCount && cumulative + unitTokens > hotBudget) break;
      cumulative += unitTokens;
      expanded += 1;
    }
    targetUserTurns = Math.max(policy.rawTurnCount, Math.min(policy.hardMaxTurns, expanded));
  }

  // Step-aligned anchor calculation over user units.
  const stepSize = targetKeepOverride !== null ? 1 : Math.max(1, policy.stepSize || 2);
  let anchorUserIdx = Math.max(0, userUnits.length - targetUserTurns);
  if (targetKeepOverride === null && windowState && windowState.anchorTurnId) {
    const prevIdx = userUnits.findIndex((u) => u.turnId === windowState.anchorTurnId);
    if (prevIdx >= 0) {
      const keptWithPrevAnchor = userUnits.length - prevIdx;
      if (keptWithPrevAnchor >= targetUserTurns && keptWithPrevAnchor < targetUserTurns + stepSize) {
        anchorUserIdx = prevIdx;
      } else if (keptWithPrevAnchor >= targetUserTurns + stepSize) {
        // Slide forward by stepSize cleanly while keeping >= targetUserTurns.
        anchorUserIdx = Math.min(userUnits.length - targetUserTurns, prevIdx + stepSize);
      }
    }
  }

  const anchorUnit = userUnits[anchorUserIdx] || units[0];
  const anchorStartIndex = units.indexOf(anchorUnit);
  const candidateUnits = anchorStartIndex >= 0 ? units.slice(anchorStartIndex) : units.slice();

  // Enforce maxSystemWakeTurns cap in the kept tail while preserving user turns.
  const keptSystemIndices = [];
  for (let i = 0; i < candidateUnits.length; i += 1) {
    if (candidateUnits[i].turnKind === "system_wake") keptSystemIndices.push(i);
  }
  const dropSystemSet = new Set();
  if (keptSystemIndices.length > policy.maxSystemWakeTurns) {
    const excess = keptSystemIndices.length - policy.maxSystemWakeTurns;
    for (let i = 0; i < excess; i += 1) {
      dropSystemSet.add(keptSystemIndices[i]);
    }
  }

  const keptUnits = candidateUnits.filter((_, idx) => !dropSystemSet.has(idx));
  return {
    keptUnits,
    keptUserTurnCount: Math.max(0, userUnits.length - anchorUserIdx),
    targetKeep: targetUserTurns,
    anchorTurnId: anchorUnit ? anchorUnit.turnId : "",
  };
}

function splitHistoryAndCurrentTurn(messages = [], explicitOffset) {
  if (Number.isInteger(explicitOffset) && explicitOffset >= 0 && explicitOffset <= messages.length) {
    return {
      historyOffset: explicitOffset,
      historicalMessages: messages.slice(0, explicitOffset),
      currentTurnMessages: messages.slice(explicitOffset),
    };
  }
  const markedIndex = messages.findIndex((msg) => {
    if (!msg || msg.role !== "user") return false;
    if (typeof msg.content === "string") return /<turn_context(?:\s+[^>]*)?>/i.test(msg.content);
    if (Array.isArray(msg.content)) {
      return msg.content.some((p) => p && p.type === "text" && typeof p.text === "string" && /<turn_context(?:\s+[^>]*)?>/i.test(p.text));
    }
    return false;
  });
  if (markedIndex >= 0) {
    return {
      historyOffset: markedIndex,
      historicalMessages: messages.slice(0, markedIndex),
      currentTurnMessages: messages.slice(markedIndex),
    };
  }
  const units = historyUnits(messages);
  if (units.length <= 1) {
    return {
      historyOffset: 0,
      historicalMessages: [],
      currentTurnMessages: messages.slice(),
    };
  }
  const lastUnit = units[units.length - 1];
  return {
    historyOffset: lastUnit.start,
    historicalMessages: messages.slice(0, lastUnit.start),
    currentTurnMessages: messages.slice(lastUnit.start),
  };
}

function createSlidingWindowManager({
  policy = {},
  turnIndexStore = null,
  topicSelector = null,
} = {}) {
  const cfg = { ...DEFAULT_V2_POLICY, ...policy };

  async function prepare({
    messages = [],
    model = "",
    systemPrompt = "",
    systemBlocks = null,
    tools = [],
    historyOffset: explicitHistoryOffset,
    requestKind = "user",
    turnId = "",
    resume = false,
    isolated = false,
    lastUsage = 0,
    lastEstimate = 0,
    force = false,
    signal = null,
    onEvent = null,
  } = {}) {
    const {
      historyOffset,
      historicalMessages: rawHistoricalMessages,
      currentTurnMessages,
    } = splitHistoryAndCurrentTurn(messages, explicitHistoryOffset);

    let leadingSystemCount = 0;
    while (leadingSystemCount < rawHistoricalMessages.length && rawHistoricalMessages[leadingSystemCount]?.role === "system") {
      leadingSystemCount += 1;
    }
    const pinnedSystemMessages = rawHistoricalMessages.slice(0, leadingSystemCount);
    const historicalMessages = rawHistoricalMessages.slice(leadingSystemCount);
    const adjustedHistoryOffset = Math.max(0, historyOffset - leadingSystemCount);

    let indexedTurns = [];
    let windowState = null;
    if (turnIndexStore && !isolated) {
      try { indexedTurns = turnIndexStore.listTurns(); } catch { indexedTurns = []; }
      try { windowState = turnIndexStore.loadWindowState(); } catch { windowState = null; }
    }

    const units = partitionHistoricalMessages(historicalMessages, indexedTurns);
    const limitOption = cfg.contextWindowTokens || cfg.limitTokens || Number(process.env.UFOO_CONTEXT_LIMIT_TOKENS) || 0;
    const modelLimit = resolveModelContextLimit(model, { limit: limitOption });
    const outputOverride = Number(process.env.UFOO_UCODE_MAX_TOKENS);
    const configuredOutput = Number.isFinite(outputOverride) && outputOverride > 0
      ? Math.floor(outputOverride)
      : (cfg.maxOutputTokens || 32768);
    const reserveOutput = Math.max(
      1,
      Math.min(modelLimit - 1, cfg.outputReserveTokens ?? Math.min(configuredOutput, Math.floor(modelLimit * 0.2))),
    );
    const rawMaxInputTokens = Math.max(512, Math.floor((modelLimit - reserveOutput) * cfg.triggerRatio));

    const sysTokens = systemBlocks
      ? estimateTextTokens(JSON.stringify(systemBlocks))
      : estimateTextTokens(systemPrompt);
    const inlineSysTokens = pinnedSystemMessages.length ? estimateMessagesTokens(pinnedSystemMessages) : 0;
    const toolTokens = Array.isArray(tools) && tools.length
      ? estimateTextTokens(JSON.stringify(tools))
      : 0;

    // Calibrate token multiplier if provider usage reported higher than prior char estimate.
    const scaleFactor = (lastUsage > 0 && lastEstimate > 0 && lastUsage > lastEstimate)
      ? Math.min(2.5, Math.max(1, lastUsage / lastEstimate))
      : 1;
    const estTokens = (msgs) => Math.ceil(estimateMessagesTokens(msgs) * scaleFactor);
    const estText = (text) => Math.ceil(estimateTextTokens(text) * scaleFactor);

    const cleanedCurrent = currentTurnMessages.map(cloneMessageClean);
    const currentFirstMsg = cleanedCurrent[0] || null;
    const currentQueryText = currentFirstMsg ? (userInstruction(currentFirstMsg) || extractTextFromMessage(currentFirstMsg)) : "";
    const effectiveTurnId = String(turnId || (currentQueryText ? `turn_${adjustedHistoryOffset}` : "")).trim();

    const maxInputTokens = force
      ? Math.max(400, Math.floor(rawMaxInputTokens * 0.8))
      : rawMaxInputTokens;
    const fixedOverhead = Math.ceil((sysTokens + toolTokens) * scaleFactor);
    const currentTurnTokens = estTokens(cleanedCurrent);
    const initialHistoryBudget = Math.max(0, maxInputTokens - fixedOverhead - Math.ceil(inlineSysTokens * scaleFactor) - currentTurnTokens);

    // Level 0 initial window selection.
    let windowSelection = selectWindowUnits({
      units,
      policy: cfg,
      windowState,
      availableHistoryBudget: initialHistoryBudget,
    });
    const sameTurnState = windowState?.cachedTurnContext?.turnId === effectiveTurnId ? windowState : null;
    let keptUnits = windowSelection.keptUnits;
    // Once evicted in this logical turn, never restore a prefix on a later tool round.
    if (sameTurnState?.evictionLevel > 0 && Array.isArray(sameTurnState.keptTurnIds)) {
      const retained = new Set(sameTurnState.keptTurnIds);
      keptUnits = units.filter((unit) => retained.has(unit.turnId)).map((unit) => ({
        ...unit,
        messages: unit.messages.map((m) => truncateToolResultsInMessage(m, cfg.maxToolResultCharsLevel1)),
      }));
    }
    let windowTurnIds = new Set(keptUnits.map((u) => u.turnId));
    let offWindowTurns = indexedTurns.filter((t) => !windowTurnIds.has(t.turnId) && (t.historyOffset || 0) < adjustedHistoryOffset);

    // Use cached <turn_context> within the same turn (multi-round tool loops) to keep prefix cache stable.
    let selectionResult = null;
    let turnContextXml = "";
    const canReuseCachedContext = Boolean(
      !force
      && windowState
      && windowState.cachedTurnContext
      && effectiveTurnId
      && windowState.cachedTurnContext.turnId === effectiveTurnId
      && JSON.stringify(windowState.keptTurnIds) === JSON.stringify(keptUnits.map((u) => u.turnId))
    );

    if (canReuseCachedContext) {
      turnContextXml = windowState.cachedTurnContext.xml || "";
      selectionResult = {
        mode: windowState.cachedTurnContext.mode || "cached",
        activeTopics: windowState.cachedTurnContext.activeTopics || [],
        selectedTurns: indexedTurns.filter((t) => (windowState.cachedTurnContext.selectedTurnIds || []).includes(t.turnId)),
        latencyMs: 0,
        cached: true,
      };
    } else if (offWindowTurns.length > 0) {
      if (topicSelector && typeof topicSelector.select === "function") {
        selectionResult = await topicSelector.select({
          currentQuery: currentQueryText,
          requestKind,
          resume,
          allTurns: indexedTurns.filter((t) => (t.historyOffset || 0) < adjustedHistoryOffset),
          windowTurnIds: [...windowTurnIds],
          store: turnIndexStore,
          signal,
        });
      } else {
        selectionResult = {
          mode: "tier1_local",
          activeTopics: [],
          selectedTurns: offWindowTurns.slice(-3),
          latencyMs: 0,
        };
      }
      turnContextXml = buildTurnContextXml({
        offWindowTurns,
        selectedTurns: selectionResult.selectedTurns || [],
      });
    } else {
      selectionResult = { mode: "bypass", activeTopics: [], selectedTurns: [], latencyMs: 0 };
    }

    // Clamp <turn_context> size proportionally on tight windows.
    const maxTurnContextTokens = Math.max(200, Math.floor(maxInputTokens * cfg.maxTurnContextRatio));
    if (turnContextXml && estText(turnContextXml) > maxTurnContextTokens) {
      turnContextXml = buildTurnContextXml({
        offWindowTurns,
        selectedTurns: (selectionResult.selectedTurns || []).slice(0, 2),
        maxTopics: 8,
        maxSelected: 2,
        maxCharsPerTurn: 280,
      });
    }

    let evictionLevel = Math.max(sameTurnState?.evictionLevel || 0, force ? 1 : 0);
    const currentToolLimits = { ...(sameTurnState?.currentToolLimits || {}) };
    let workingCurrent = cleanedCurrent.map((msg, idx) => currentToolLimits[idx]
      ? truncateToolResultsInMessage(msg, currentToolLimits[idx]) : msg);
    const truncateCurrent = (idx, maxChars) => {
      const before = workingCurrent[idx];
      workingCurrent[idx] = truncateToolResultsInMessage(before, maxChars);
      if (workingCurrent[idx] !== before) currentToolLimits[idx] = maxChars;
    };
    const refreshTurnContext = async (compact = false) => {
      windowTurnIds = new Set(keptUnits.map((u) => u.turnId));
      offWindowTurns = indexedTurns.filter((t) => !windowTurnIds.has(t.turnId) && (t.historyOffset || 0) < adjustedHistoryOffset);
      // Eviction must not introduce extra model calls on the foreground path.
      selectionResult = await createTopicSelector().select({
        currentQuery: currentQueryText, requestKind, resume,
        allTurns: indexedTurns.filter((t) => (t.historyOffset || 0) < adjustedHistoryOffset),
        windowTurnIds: [...windowTurnIds], store: turnIndexStore,
      });
      turnContextXml = buildTurnContextXml({
        offWindowTurns, selectedTurns: selectionResult.selectedTurns || [],
        ...(compact ? { maxTopics: 6, maxSelected: 1, maxCharsPerTurn: 220 } : {}),
      });
      if (estText(turnContextXml) > maxTurnContextTokens) {
        turnContextXml = buildTurnContextXml({ offWindowTurns, selectedTurns: selectionResult.selectedTurns || [],
          maxTopics: 6, maxSelected: 1, maxCharsPerTurn: 220 });
      }
    };

    const assembleCandidate = (candidateUnits, candidateCurrent, xml) => {
      const histMsgs = [...pinnedSystemMessages];
      for (const unit of candidateUnits) {
        for (const msg of unit.messages) histMsgs.push(msg);
      }
      if (histMsgs.length > pinnedSystemMessages.length && candidateCurrent.length > 0 && (xml || candidateCurrent.length > 1)) {
        const boundaryIdx = histMsgs.length - 1;
        const boundaryMsg = copyOwnSymbols(histMsgs[boundaryIdx], { ...histMsgs[boundaryIdx] });
        Object.defineProperty(boundaryMsg, STABLE_HISTORY_BOUNDARY_SYMBOL, {
          value: true,
          enumerable: false,
          configurable: true,
        });
        histMsgs[boundaryIdx] = boundaryMsg;
      }
      const curMsgs = candidateCurrent.slice();
      if (xml && curMsgs.length) {
        curMsgs[0] = attachTurnContextToMessage(curMsgs[0], xml);
      }
      const all = [...histMsgs, ...curMsgs];
      return {
        messages: all,
        histCount: histMsgs.length,
        estimatedTokens: fixedOverhead + estTokens(all),
      };
    };

    let assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
    const initialTokens = assembled.estimatedTokens;
    const initialKeptCount = keptUnits.length;
    const prevForcedLevel = force && windowState ? Number(windowState.evictionLevel || 0) : 0;

    // Deterministic Eviction Ladder when overflow detected or forced retry.
    if (force || assembled.estimatedTokens > maxInputTokens) {
      // Level 1: Drop to minKeepTurns (2) user turns, drop system wakes in L1, truncate large older tool outputs in L1.
      evictionLevel = Math.max(evictionLevel, 1);
      const shrunkSelection = selectWindowUnits({
        units: keptUnits,
        policy: { ...cfg, maxSystemWakeTurns: 0 },
        windowState: null,
        availableHistoryBudget: initialHistoryBudget,
        targetKeepOverride: cfg.minKeepTurns,
      });
      keptUnits = shrunkSelection.keptUnits.map((unit) => ({
        ...unit,
        messages: unit.messages.map((m) => truncateToolResultsInMessage(m, cfg.maxToolResultCharsLevel1)),
      }));
      await refreshTurnContext();
      assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
    }

    const level1DidNotShrink = force && assembled.estimatedTokens >= Math.floor(initialTokens * 0.9);
    if (assembled.estimatedTokens > maxInputTokens || (force && (prevForcedLevel >= 1 || level1DidNotShrink))) {
      // Level 2: Trim <turn_context> and peel off oldest L1 units cleanly.
      evictionLevel = Math.max(evictionLevel, 2);
      if (force) keptUnits = keptUnits.slice(-1);
      await refreshTurnContext(true);
      assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
      while (keptUnits.length > 0 && assembled.estimatedTokens > maxInputTokens) {
        keptUnits = keptUnits.slice(1);
        await refreshTurnContext(true);
        assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
      }
      if (assembled.estimatedTokens > maxInputTokens) {
        turnContextXml = "";
        assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
      }
    }

    const level2DidNotShrink = force && assembled.estimatedTokens >= Math.floor(initialTokens * 0.9);
    if (assembled.estimatedTokens > maxInputTokens || (force && (prevForcedLevel >= 2 || level2DidNotShrink))) {
      // Level 3: Emergency compression of intermediate tool outputs inside currentTurnMessages (preserve round 0 user + latest round + thinking signatures).
      evictionLevel = 3;
      keptUnits = [];
      await refreshTurnContext(true);
      const currentSubUnits = historyUnits(workingCurrent);
      const preserveStart = currentSubUnits.length > 1
        ? currentSubUnits[currentSubUnits.length - 1].start
        : Math.max(1, workingCurrent.length - 2);
      for (let idx = 1; idx < preserveStart; idx += 1) {
        truncateCurrent(idx, cfg.maxToolResultCharsLevel3);
      }
      assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
      // Latest results are preferred intact, but cannot be exempt from the hard budget.
      if (assembled.estimatedTokens > maxInputTokens) {
        for (const cap of [cfg.maxToolResultCharsLevel3, 240]) {
          for (let idx = 1; idx < workingCurrent.length; idx += 1) truncateCurrent(idx, cap);
          assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
          if (assembled.estimatedTokens <= maxInputTokens) break;
        }
      }
      if (assembled.estimatedTokens > maxInputTokens) {
        turnContextXml = "";
        assembled = assembleCandidate(keptUnits, workingCurrent, turnContextXml);
      }
    }

    const didShrink = assembled.estimatedTokens < initialTokens
      || keptUnits.length < initialKeptCount;
    if (assembled.estimatedTokens > maxInputTokens || (force && !didShrink)) {
      throw Object.assign(
        new Error("context exceeds the configured input budget; original history retained"),
        { code: "context_budget_exceeded" },
      );
    }

    const finalAnchorTurnId = (keptUnits.find((u) => u.turnKind !== "system_wake") || keptUnits[0])?.turnId || "";
    if (typeof onEvent === "function") {
      try {
        await onEvent("context.select.completed", {
          mode: selectionResult.mode,
          activeTopics: selectionResult.activeTopics || [],
          selectedTurnIds: (selectionResult.selectedTurns || []).map((t) => t.turnId),
          latencyMs: selectionResult.latencyMs || 0,
          cached: Boolean(selectionResult.cached),
        });
      } catch {}
    }

    if (turnIndexStore && !isolated) {
      try {
        turnIndexStore.saveWindowState({
          anchorTurnId: finalAnchorTurnId,
          evictionLevel,
          currentToolLimits,
          keptTurnIds: keptUnits.map((u) => u.turnId),
          cachedTurnContext: effectiveTurnId ? {
            turnId: effectiveTurnId,
            anchorTurnId: finalAnchorTurnId,
            xml: turnContextXml,
            mode: selectionResult.mode,
            activeTopics: selectionResult.activeTopics || [],
            selectedTurnIds: (selectionResult.selectedTurns || []).map((t) => t.turnId),
          } : null,
        });
      } catch {
        // Window state persistence must never fail the active LLM call.
      }
    }

    if (typeof onEvent === "function") {
      try {
        await onEvent("context.window.projected", {
          evictionLevel,
          rawTurnCount: keptUnits.length,
          totalTurns: indexedTurns.length,
          offWindowCount: offWindowTurns.length,
          estimatedTokens: assembled.estimatedTokens,
          maxOutputTokens: reserveOutput,
          anchorTurnId: finalAnchorTurnId,
        });
      } catch {}
    }

    return {
      messages: assembled.messages,
      historyOffset: assembled.histCount,
      estimatedTokens: assembled.estimatedTokens,
      maxOutputTokens: reserveOutput,
      meta: {
        evictionLevel,
        rawTurnCount: keptUnits.length,
        offWindowCount: offWindowTurns.length,
        selectionMode: selectionResult.mode,
        activeTopics: selectionResult.activeTopics || [],
      },
    };
  }

  return Object.freeze({ prepare });
}

module.exports = {
  DEFAULT_V2_POLICY,
  createSlidingWindowManager,
  buildTurnContextXml,
  attachTurnContextToMessage,
  partitionHistoricalMessages,
  selectWindowUnits,
};
