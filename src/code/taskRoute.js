"use strict";

/**
 * Structural / explicit decomposition upgrade decisions (R7).
 * Not a language-specific bug-keyword classifier.
 */

function shouldUpgradeToDecomposition(task = "", options = {}) {
  const text = String(task || "").trim();
  const reasons = [];

  if (options.forceDirect === true || options.disableDecomposition === true) {
    return {
      upgrade: false,
      reason: "forced_direct",
      reasons: ["forced_direct"],
    };
  }
  if (options.forceDecomposition === true || options.forceDecompose === true) {
    return {
      upgrade: true,
      reason: "forced_decomposition",
      reasons: ["forced_decomposition"],
    };
  }
  if (!text) {
    return { upgrade: false, reason: "empty", reasons: ["empty"] };
  }

  // Explicit user/model requests (EN + ZH).
  if (/(?:\bdecompos(?:e|ition)\b|\bbreak\s+(?:this|it)\s+down\b|\bmulti[- ]?step\s+plan\b|拆解|分步|分解任务|制定计划)/i.test(text)) {
    reasons.push("explicit_decompose_request");
  }

  // Multiple independently verifiable goals (numbered / bulleted / conjunctions).
  const numbered = (text.match(/(?:^|\n)\s*(?:\d+[\).]|[-*•])\s+\S+/g) || []).length;
  if (numbered >= 2) reasons.push("multiple_listed_goals");

  const multiClause = /(?:^|[;；。\n])\s*(?:and\s+also|also|然后|并且|同时|另外|以及)\b/i.test(text)
    || (text.split(/[;；]/).map((s) => s.trim()).filter((s) => s.length > 12).length >= 3);
  if (multiClause) reasons.push("multi_clause_objectives");

  // High-risk / multi-file structural cues (not "fix" alone).
  if (/\b(?:across\s+(?:files?|modules?|packages?)|multiple\s+files?|refactor\s+the\s+\w+|迁移|跨文件|多文件)\b/i.test(text)) {
    reasons.push("multi_file_or_refactor_scope");
  }
  if (/\b(?:checkpoint|rollback|migration|schema\s+change|生产环境|回滚)\b/i.test(text)) {
    reasons.push("high_risk_change");
  }

  // Runtime budget / prior failures may request upgrade.
  if (Number(options.failureCount || 0) >= 2) {
    reasons.push("repeated_failures");
  }
  if (options.modelRequestedUpgrade === true) {
    reasons.push("model_route_decision");
  }
  if (options.hasPlanGraph === true) {
    // Already structured — keep direct loop unless other reasons fire.
    // (graph exists is not itself a decompose trigger)
  }

  const upgrade = reasons.length > 0;
  return {
    upgrade,
    reason: upgrade ? reasons[0] : "direct_default",
    reasons,
  };
}

module.exports = {
  shouldUpgradeToDecomposition,
};
