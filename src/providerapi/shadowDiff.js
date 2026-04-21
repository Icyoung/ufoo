"use strict";

// §11.6 Phase 1 shadow diff metrics: model text BLEU ≥ 0.85 and
// tool-call sequence consistency ≥ 95%. This module provides the deterministic
// helpers the shadow harness feeds paired (legacy, api-backed) samples into.

const PHASE1_DEFAULT_BLEU_THRESHOLD = 0.85;
const PHASE1_DEFAULT_TOOLCALL_THRESHOLD = 0.95;

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens, n) {
  if (!Array.isArray(tokens) || tokens.length < n) return [];
  const out = [];
  for (let i = 0; i <= tokens.length - n; i += 1) {
    out.push(tokens.slice(i, i + n).join("\u0001"));
  }
  return out;
}

function countMap(list) {
  const map = new Map();
  for (const item of list) {
    map.set(item, (map.get(item) || 0) + 1);
  }
  return map;
}

function clippedPrecision(candidateNgrams, referenceNgrams) {
  if (candidateNgrams.length === 0) return 0;
  const candidateCounts = countMap(candidateNgrams);
  const referenceCounts = countMap(referenceNgrams);
  let clipped = 0;
  for (const [gram, count] of candidateCounts.entries()) {
    const refCount = referenceCounts.get(gram) || 0;
    clipped += Math.min(count, refCount);
  }
  return clipped / candidateNgrams.length;
}

function brevityPenalty(candidateLen, referenceLen) {
  if (candidateLen === 0) return 0;
  if (candidateLen >= referenceLen) return 1;
  return Math.exp(1 - referenceLen / candidateLen);
}

function computeBleu(referenceText, candidateText, options = {}) {
  const maxN = Number.isFinite(options.maxN) ? Math.max(1, Math.min(4, options.maxN)) : 4;
  const weight = 1 / maxN;
  const ref = tokenize(referenceText);
  const cand = tokenize(candidateText);
  if (cand.length === 0) return 0;
  if (ref.length === 0) return 0;

  let logSum = 0;
  for (let n = 1; n <= maxN; n += 1) {
    const precision = clippedPrecision(ngrams(cand, n), ngrams(ref, n));
    if (precision <= 0) return 0;
    logSum += weight * Math.log(precision);
  }
  const bp = brevityPenalty(cand.length, ref.length);
  return bp * Math.exp(logSum);
}

function extractToolCallNames(events = []) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => event && event.type === "tool_call" && event.name)
    .map((event) => String(event.name).trim())
    .filter(Boolean);
}

function computeToolCallSequenceConsistency(referenceSeq = [], candidateSeq = []) {
  const ref = Array.isArray(referenceSeq) ? referenceSeq : [];
  const cand = Array.isArray(candidateSeq) ? candidateSeq : [];
  if (ref.length === 0 && cand.length === 0) return 1;

  const m = ref.length;
  const n = cand.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (ref[i - 1] === cand[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  const lcs = dp[m][n];
  const denom = Math.max(m, n);
  if (denom === 0) return 1;
  return lcs / denom;
}

function buildPhase1ShadowDiffSample({ legacy = {}, api = {} } = {}) {
  const bleu = computeBleu(legacy.text || "", api.text || "");
  const toolSeqConsistency = computeToolCallSequenceConsistency(
    extractToolCallNames(legacy.events || legacy.toolCalls || []),
    extractToolCallNames(api.events || api.toolCalls || [])
  );
  return {
    bleu,
    toolSeqConsistency,
  };
}

function summarizePhase1ShadowDiff(samples = [], options = {}) {
  const bleuThreshold = Number.isFinite(options.bleuThreshold)
    ? options.bleuThreshold
    : PHASE1_DEFAULT_BLEU_THRESHOLD;
  const toolCallThreshold = Number.isFinite(options.toolCallThreshold)
    ? options.toolCallThreshold
    : PHASE1_DEFAULT_TOOLCALL_THRESHOLD;

  const list = Array.isArray(samples) ? samples : [];
  if (list.length === 0) {
    return {
      sampleCount: 0,
      meanBleu: 0,
      meanToolSeqConsistency: 0,
      bleuPass: false,
      toolCallPass: false,
      overallPass: false,
      bleuThreshold,
      toolCallThreshold,
    };
  }

  let totalBleu = 0;
  let totalTool = 0;
  let toolCallPassCount = 0;
  for (const sample of list) {
    totalBleu += Number(sample.bleu || 0);
    const consistency = Number(sample.toolSeqConsistency || 0);
    totalTool += consistency;
    if (consistency >= toolCallThreshold) toolCallPassCount += 1;
  }

  const meanBleu = totalBleu / list.length;
  const meanToolSeqConsistency = totalTool / list.length;
  const bleuPass = meanBleu >= bleuThreshold;
  const toolCallPassRate = toolCallPassCount / list.length;
  const toolCallPass = toolCallPassRate >= toolCallThreshold;

  return {
    sampleCount: list.length,
    meanBleu,
    meanToolSeqConsistency,
    toolCallPassRate,
    bleuPass,
    toolCallPass,
    overallPass: bleuPass && toolCallPass,
    bleuThreshold,
    toolCallThreshold,
  };
}

module.exports = {
  PHASE1_DEFAULT_BLEU_THRESHOLD,
  PHASE1_DEFAULT_TOOLCALL_THRESHOLD,
  tokenize,
  ngrams,
  computeBleu,
  extractToolCallNames,
  computeToolCallSequenceConsistency,
  buildPhase1ShadowDiffSample,
  summarizePhase1ShadowDiff,
};
