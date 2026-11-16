"use strict";

const { normalizeTopic, tokenizeForSearch } = require("./turnIndexStore");
const { stripTurnContextWrapper, parseJsonObjectLenient } = require("./turnAnalyzer");

const TEMPORAL_ANCHORS = [
  /刚才|刚刚|上一步|上一个|上一轮|前面|之前那个|刚才那个|上面那个/,
  /\b(just now|earlier|previous|last step|last turn|before that|above)\b/i,
];

const ERROR_CUES = [
  /报错|错误|失败|崩溃|异常|为什么挂|修一下|排查/,
  /\b(error|fail|failed|exception|crash|broken|bug|why did it)\b/i,
];

const CONTINUATION_SHORT_CUES = [
  /^(继续|接着|好的|可以|行|嗯|改一下|再试|再测|然后|好)/,
  /^(continue|proceed|go ahead|yes|ok|okay|sure|try again|next)\b/i,
];

function extractQueryIdentifiers(query) {
  const paths = new Set((String(query || "").match(/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) || []).map((s) => s.replace(/^\.\//, "").toLowerCase()));
  const ids = new Set((String(query || "").match(/\b(?:[a-z]+(?:[A-Z][a-zA-Z0-9]*)+|[a-zA-Z]+_[a-zA-Z0-9_]+|[A-Z]{2,}_[A-Z0-9_]+|[a-zA-Z0-9]+_[0-9a-zA-Z]{3,}|[a-zA-Z0-9-]+\.[a-zA-Z]{1,6})\b/g) || []).map((s) => s.toLowerCase()));
  return { paths, ids };
}

function createTopicSelector({
  runAuxModel = null,
  enableModelSelector = false,
  modelTimeoutMs = 1200,
  recentBypassThreshold = 6,
  maxSelectedTurns = 5,
} = {}) {
  async function select({
    currentQuery = "",
    requestKind = "user",
    resume = false,
    allTurns = [],
    windowTurnIds = [],
    store = null,
    forceTier2 = false,
    signal = null,
  } = {}) {
    const startMs = Date.now();
    const cleanedQuery = stripTurnContextWrapper(String(currentQuery || "")).trim();
    const turns = Array.isArray(allTurns) ? allTurns.slice().sort((a, b) => (a.turnIndex || 0) - (b.turnIndex || 0)) : [];
    const inWindow = new Set(windowTurnIds || []);
    const offWindowTurns = turns.filter((t) => t && !inWindow.has(t.turnId));
    const nonWakeTurns = turns.filter((t) => t && t.turnKind !== "system_wake");
    const lastUserTurn = nonWakeTurns[nonWakeTurns.length - 1] || turns[turns.length - 1] || null;
    const defaultActiveTopic = lastUserTurn ? normalizeTopic(lastUserTurn.topic) : "general";

    const isSystemWake = ["worker-report", "task-result", "system_wake", "wake", "cron", "schedule", "notification"]
      .includes(String(requestKind || "").toLowerCase());

    // Tier 0: Bypass when small history, zero off-window turns, resume, or system wake.
    if (!turns.length || offWindowTurns.length === 0 || turns.length <= recentBypassThreshold || isSystemWake || resume) {
      const selected = [];
      const seenSelected = new Set();
      if (offWindowTurns.length > 0) {
        const sessionFounding = offWindowTurns.find((t) => t.turnKind !== "system_wake") || offWindowTurns[0];
        if (sessionFounding) {
          selected.push(sessionFounding);
          seenSelected.add(sessionFounding.turnId);
        }
      }
      if ((isSystemWake || resume) && offWindowTurns.length > 0 && lastUserTurn && !inWindow.has(lastUserTurn.turnId) && !seenSelected.has(lastUserTurn.turnId)) {
        selected.push(lastUserTurn);
      }
      return {
        mode: "bypass",
        isNewTopic: false,
        activeTopics: defaultActiveTopic && defaultActiveTopic !== "general" ? [defaultActiveTopic] : [],
        selectedTurns: selected,
        confidence: 1,
        latencyMs: Date.now() - startMs,
      };
    }

    const { paths: queryPaths, ids: queryIds } = extractQueryIdentifiers(cleanedQuery);

    // Tier 0 short continuation cue bypass (when no explicit new file/symbol anchor).
    if (cleanedQuery.length <= 48 && !queryPaths.size && !queryIds.size && CONTINUATION_SHORT_CUES.some((re) => re.test(cleanedQuery))) {
      const sameTopicOffWindow = offWindowTurns.filter((t) => normalizeTopic(t.topic) === defaultActiveTopic);
      const picked = [];
      const seenPicked = new Set();
      const pushPicked = (turn) => {
        if (!turn || seenPicked.has(turn.turnId) || picked.length >= maxSelectedTurns) return;
        seenPicked.add(turn.turnId);
        picked.push(turn);
      };
      const sessionFounding = offWindowTurns.find((t) => t.turnKind !== "system_wake") || offWindowTurns[0];
      pushPicked(sessionFounding);
      if (sameTopicOffWindow.length) {
        pushPicked(sameTopicOffWindow[0]); // founding turn of active topic
        if (sameTopicOffWindow.length > 1) {
          pushPicked(sameTopicOffWindow[sameTopicOffWindow.length - 1]);
        }
      }
      if (offWindowTurns.length > picked.length) {
        pushPicked(offWindowTurns[offWindowTurns.length - 1]);
      }
      return {
        mode: "bypass",
        isNewTopic: false,
        activeTopics: defaultActiveTopic !== "general" ? [defaultActiveTopic] : [],
        selectedTurns: picked,
        confidence: 0.95,
        latencyMs: Date.now() - startMs,
      };
    }

    // Tier 1: Local deterministic scoring over off-window turns.
    const hasTemporalCue = TEMPORAL_ANCHORS.some((re) => re.test(cleanedQuery));
    const hasErrorCue = ERROR_CUES.some((re) => re.test(cleanedQuery));

    let lexicalHits = [];
    if (store && typeof store.search === "function") {
      lexicalHits = store.search(cleanedQuery, {
        limit: Math.max(maxSelectedTurns * 3, 12),
        excludeTurnIds: [...inWindow],
      });
    } else if (cleanedQuery) {
      // Pure in-memory fallback tokenizer scoring if store wasn't passed.
      const qTerms = new Set(tokenizeForSearch(cleanedQuery).map((t) => t.term));
      lexicalHits = offWindowTurns.map((turn) => {
        const docText = [
          turn.topic,
          turn.rawUserText,
          turn.userSummary,
          turn.assistantSummary,
          ...(turn.touchedFiles || []),
          ...(turn.modifiedFiles || []),
          ...(turn.keywords || []),
        ].join(" ");
        const dTerms = new Set(tokenizeForSearch(docText).map((t) => t.term));
        let hits = 0;
        for (const term of qTerms) if (dTerms.has(term)) hits += 1;
        return { turn, score: hits, matchedTerms: [] };
      }).filter((x) => x.score > 0);
    }

    const scoreById = new Map();
    for (const hit of lexicalHits) {
      if (hit && hit.turn && !inWindow.has(hit.turn.turnId)) {
        scoreById.set(hit.turn.turnId, Number(hit.score) || 0);
      }
    }

    // Structural boosts across off-window turns.
    for (let i = 0; i < offWindowTurns.length; i += 1) {
      const turn = offWindowTurns[i];
      let score = scoreById.get(turn.turnId) || 0;
      const fileHaystack = new Set([
        ...(turn.modifiedFiles || []).map((f) => f.toLowerCase()),
        ...(turn.touchedFiles || []).map((f) => f.toLowerCase()),
      ]);
      const keywordSet = new Set((turn.keywords || []).map((k) => k.toLowerCase()));
      const rawLower = `${turn.rawUserText || ""}\n${turn.assistantSummary || ""}`.toLowerCase();

      for (const qp of queryPaths) {
        for (const tf of fileHaystack) {
          if (tf === qp || tf.endsWith(`/${qp}`) || tf.includes(qp)) score += 5.0;
        }
      }
      for (const qid of queryIds) {
        if (keywordSet.has(qid) || rawLower.includes(qid)) {
          score += 4.5;
        } else {
          for (const tf of fileHaystack) {
            if (tf.endsWith(`/${qid}`) || tf === qid) score += 4.0;
          }
        }
      }

      if (hasTemporalCue && i >= offWindowTurns.length - 2 && turn.turnKind !== "system_wake") {
        score += 2.2 + (i === offWindowTurns.length - 1 ? 1.0 : 0);
      }
      if (hasErrorCue && (turn.outcome === "failed" || turn.outcome === "cancelled" || turn.outcome === "interrupted")) {
        score += 1.8;
      }
      if (normalizeTopic(turn.topic) === defaultActiveTopic && defaultActiveTopic !== "general") {
        score += 0.8;
      }
      if (score > 0) scoreById.set(turn.turnId, Number(score.toFixed(4)));
    }

    const ranked = offWindowTurns
      .map((turn) => ({ turn, score: scoreById.get(turn.turnId) || 0 }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => (b.score - a.score) || ((b.turn.turnIndex || 0) - (a.turn.turnIndex || 0)));

    const topScore = ranked.length ? ranked[0].score : 0;
    const activeTopics = [];
    const seenTopics = new Set();
    const pushTopic = (topic) => {
      const norm = normalizeTopic(topic);
      if (!norm || norm === "general" || seenTopics.has(norm)) return;
      seenTopics.add(norm);
      activeTopics.push(norm);
    };
    for (const item of ranked.slice(0, 3)) {
      if (item.score >= Math.max(1.2, topScore * 0.5)) pushTopic(item.turn.topic);
    }
    if (!activeTopics.length && defaultActiveTopic !== "general") {
      pushTopic(defaultActiveTopic);
    }

    // Determine whether Tier 1 is confident or ambiguous.
    const hasExactAnchor = queryPaths.size > 0 || queryIds.size > 0 || hasTemporalCue || topScore >= 3.5;
    const confidence = hasExactAnchor ? 0.9 : (topScore >= 1.5 ? 0.65 : 0.3);

    let mode = "tier1_local";
    let isNewTopic = activeTopics.length === 0;
    const selectedMap = new Map();

    // Founding turn preservation for active topics & session start if off-window.
    for (const topic of activeTopics.slice(0, 2)) {
      const founding = offWindowTurns.find((t) => normalizeTopic(t.topic) === topic && t.turnKind !== "system_wake");
      if (founding && !selectedMap.has(founding.turnId)) {
        selectedMap.set(founding.turnId, founding);
      }
    }
    for (const entry of ranked) {
      if (selectedMap.size >= maxSelectedTurns) break;
      if (!selectedMap.has(entry.turn.turnId)) {
        selectedMap.set(entry.turn.turnId, entry.turn);
      }
    }
    if (offWindowTurns.length > 0 && selectedMap.size < maxSelectedTurns) {
      const sessionFounding = offWindowTurns.find((t) => t.turnKind !== "system_wake") || offWindowTurns[0];
      if (sessionFounding && !selectedMap.has(sessionFounding.turnId)) {
        selectedMap.set(sessionFounding.turnId, sessionFounding);
      }
    }

    // Optional Tier 2 fast model selector when enabled and Tier 1 is ambiguous.
    const shouldInvokeTier2 = enableModelSelector
      && typeof runAuxModel === "function"
      && offWindowTurns.length >= 3
      && (forceTier2 || confidence < 0.7);

    if (shouldInvokeTier2 && !(signal && signal.aborted)) {
      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      if (signal) signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), Math.max(200, Number(modelTimeoutMs) || 1200));
      if (typeof timer.unref === "function") timer.unref();

      try {
        const candidateTurns = offWindowTurns.slice(-16).map((t) => ({
          turnId: t.turnId,
          topic: t.topic,
          outcome: t.outcome,
          userSummary: t.userSummary,
          modifiedFiles: (t.modifiedFiles || []).slice(0, 4),
        }));
        const raw = await runAuxModel({
          purpose: "topic_select",
          currentQuery: cleanedQuery,
          activeTopics,
          candidates: candidateTurns,
          signal: controller.signal,
        });
        const parsed = typeof raw === "object" && raw !== null ? raw : parseJsonObjectLenient(raw);
        if (parsed) {
          mode = "tier2_model";
          if (typeof parsed.isNewTopic === "boolean") isNewTopic = parsed.isNewTopic;
          const byId = new Map(offWindowTurns.map((t) => [t.turnId, t]));
          const validTopicSet = new Set(offWindowTurns.map((t) => normalizeTopic(t.topic)));
          const tier2Turns = [];
          const seenTier2 = new Set();

          if (Array.isArray(parsed.matchedTopics)) {
            const matchedTopics = [];
            for (const rawTopic of parsed.matchedTopics) {
              const norm = normalizeTopic(rawTopic);
              if (validTopicSet.has(norm)) matchedTopics.push(norm);
            }
            if (matchedTopics.length) {
              activeTopics.length = 0;
              seenTopics.clear();
              for (const t of matchedTopics) pushTopic(t);
              for (const t of matchedTopics.slice(0, 2)) {
                const founding = offWindowTurns.find((turn) => normalizeTopic(turn.topic) === t);
                if (founding && !seenTier2.has(founding.turnId)) {
                  seenTier2.add(founding.turnId);
                  tier2Turns.push(founding);
                }
              }
            }
          }

          if (Array.isArray(parsed.referencedTurnIds)) {
            for (const id of parsed.referencedTurnIds) {
              const hit = byId.get(String(id || "").trim());
              if (hit && !seenTier2.has(hit.turnId)) {
                seenTier2.add(hit.turnId);
                tier2Turns.push(hit);
              }
            }
          }

          if (tier2Turns.length) {
            selectedMap.clear();
            for (const turn of tier2Turns.slice(0, maxSelectedTurns)) {
              selectedMap.set(turn.turnId, turn);
            }
          }
        }
      } catch {
        // Fallback to Tier 1 cleanly on timeout or model failure.
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onParentAbort);
      }
    }

    const selectedTurns = [...selectedMap.values()]
      .sort((a, b) => (a.turnIndex || 0) - (b.turnIndex || 0))
      .slice(0, maxSelectedTurns);

    return {
      mode,
      isNewTopic,
      activeTopics: activeTopics.slice(0, 3),
      selectedTurns,
      confidence,
      latencyMs: Date.now() - startMs,
    };
  }

  return Object.freeze({ select });
}

module.exports = {
  createTopicSelector,
};
