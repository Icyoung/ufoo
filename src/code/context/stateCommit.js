"use strict";

function emptyTaskContract() {
  return {
    objective: "",
    successCriteria: [],
    constraints: [],
    preferences: [],
  };
}

function emptyStateEpoch() {
  return {
    epochId: 1,
    snapshot: {
      phase: "active",
      currentObjective: "",
      facts: [],
      hypotheses: [],
      decisions: [],
      openQuestions: [],
    },
    commits: [],
  };
}

function extractConstraintsFromText(text = "") {
  const raw = String(text || "");
  const constraints = [];
  const patterns = [
    /(?:don'?t|do not|never|without)\s+[^!?\n]{8,120}/gi,
    /(?:must|should|need to)\s+[^!?\n]{8,120}/gi,
    /(?:不要|不能|禁止|必须)[^.!?\n]{4,80}/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(raw))) {
      const item = String(match[0] || "").trim();
      if (item && !constraints.includes(item)) constraints.push(item);
    }
  }
  return constraints.slice(0, 8);
}

function buildInitialTaskContract(userTask = "") {
  const task = String(userTask || "").trim();
  if (!task) return emptyTaskContract();
  const firstLine = task.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || task;
  return {
    objective: firstLine.slice(0, 500),
    successCriteria: [
      "Complete the requested work with verifiable outcomes",
      "Keep changes aligned with repository conventions",
    ],
    constraints: extractConstraintsFromText(task),
    preferences: [],
  };
}

function patchTaskContract(contract = {}, patch = {}) {
  const base = contract && typeof contract === "object" ? { ...contract } : emptyTaskContract();
  const source = patch && typeof patch === "object" ? patch : {};
  if (typeof source.objective === "string" && source.objective.trim()) {
    // Runtime does not allow silent objective overwrite unless explicitly patched
    if (source.allowObjectiveReplace === true) {
      base.objective = source.objective.trim();
    }
  }
  const mergeList = (key) => {
    const incoming = Array.isArray(source[key]) ? source[key].map(String).filter(Boolean) : [];
    if (incoming.length === 0) return;
    const set = new Set([...(Array.isArray(base[key]) ? base[key] : []), ...incoming]);
    base[key] = Array.from(set);
  };
  mergeList("successCriteria");
  mergeList("constraints");
  mergeList("preferences");
  return base;
}

function renderTaskContract(contract = null) {
  if (!contract || !contract.objective) return "";
  const lines = [
    "Task Contract:",
    `- Objective: ${contract.objective}`,
  ];
  if (Array.isArray(contract.successCriteria) && contract.successCriteria.length > 0) {
    lines.push(`- Success criteria: ${contract.successCriteria.join("; ")}`);
  }
  if (Array.isArray(contract.constraints) && contract.constraints.length > 0) {
    lines.push(`- Constraints: ${contract.constraints.join("; ")}`);
  }
  if (Array.isArray(contract.preferences) && contract.preferences.length > 0) {
    lines.push(`- Preferences: ${contract.preferences.join("; ")}`);
  }
  return lines.join("\n");
}

function normalizeStateCommit(commit = {}) {
  const source = commit && typeof commit === "object" ? commit : {};
  return {
    factsAdd: Array.isArray(source.factsAdd) ? source.factsAdd.map(String).filter(Boolean) : [],
    factsUpdate: Array.isArray(source.factsUpdate) ? source.factsUpdate : [],
    hypothesesAdd: Array.isArray(source.hypothesesAdd) ? source.hypothesesAdd.map(String).filter(Boolean) : [],
    hypothesesUpdate: Array.isArray(source.hypothesesUpdate) ? source.hypothesesUpdate : [],
    decisionsAdd: Array.isArray(source.decisionsAdd) ? source.decisionsAdd.map(String).filter(Boolean) : [],
    questionsAdd: Array.isArray(source.questionsAdd) ? source.questionsAdd.map(String).filter(Boolean) : [],
    questionsClose: Array.isArray(source.questionsClose) ? source.questionsClose.map(String).filter(Boolean) : [],
    nextObjective: typeof source.nextObjective === "string" ? source.nextObjective.trim() : "",
  };
}

function applyListPatch(list = [], { add = [], update = [], close = [] } = {}) {
  let next = Array.isArray(list) ? list.slice() : [];
  for (const item of add) {
    if (!next.includes(item)) next.push(item);
  }
  for (const entry of update) {
    if (!entry || typeof entry !== "object") continue;
    const from = String(entry.from || "").trim();
    const to = String(entry.to || "").trim();
    if (!from || !to) continue;
    next = next.map((v) => (v === from ? to : v));
  }
  for (const item of close) {
    next = next.filter((v) => v !== item);
  }
  return next;
}

function applyStateCommit(stateEpoch = null, commit = {}) {
  const epoch = stateEpoch && typeof stateEpoch === "object"
    ? JSON.parse(JSON.stringify(stateEpoch))
    : emptyStateEpoch();
  const normalized = normalizeStateCommit(commit);
  const snapshot = epoch.snapshot && typeof epoch.snapshot === "object"
    ? epoch.snapshot
    : emptyStateEpoch().snapshot;

  snapshot.facts = applyListPatch(snapshot.facts, {
    add: normalized.factsAdd,
    update: normalized.factsUpdate,
  });
  snapshot.hypotheses = applyListPatch(snapshot.hypotheses, {
    add: normalized.hypothesesAdd,
    update: normalized.hypothesesUpdate,
  });
  snapshot.decisions = applyListPatch(snapshot.decisions, {
    add: normalized.decisionsAdd,
  });
  snapshot.openQuestions = applyListPatch(snapshot.openQuestions, {
    add: normalized.questionsAdd,
    close: normalized.questionsClose,
  });
  if (normalized.nextObjective) snapshot.currentObjective = normalized.nextObjective;

  epoch.snapshot = snapshot;
  epoch.commits = Array.isArray(epoch.commits) ? epoch.commits : [];
  epoch.commits.push({
    at: new Date().toISOString(),
    commit: normalized,
  });
  return epoch;
}

function renderStateEpoch(stateEpoch = null) {
  if (!stateEpoch || !stateEpoch.snapshot) return "";
  const snap = stateEpoch.snapshot;
  const lines = [
    "State Snapshot:",
    `- Phase: ${snap.phase || "active"}`,
    snap.currentObjective ? `- Current objective: ${snap.currentObjective}` : "",
    snap.facts && snap.facts.length > 0 ? `- Facts: ${snap.facts.join("; ")}` : "",
    snap.hypotheses && snap.hypotheses.length > 0 ? `- Hypotheses: ${snap.hypotheses.join("; ")}` : "",
    snap.decisions && snap.decisions.length > 0 ? `- Decisions: ${snap.decisions.join("; ")}` : "",
    snap.openQuestions && snap.openQuestions.length > 0 ? `- Open questions: ${snap.openQuestions.join("; ")}` : "",
  ].filter(Boolean);
  const commits = Array.isArray(stateEpoch.commits) ? stateEpoch.commits.slice(-3) : [];
  if (commits.length > 0) {
    lines.push("Recent state commits:");
    for (const entry of commits) {
      const c = entry.commit || {};
      const bits = [];
      if (c.factsAdd && c.factsAdd.length) bits.push(`facts+${c.factsAdd.length}`);
      if (c.decisionsAdd && c.decisionsAdd.length) bits.push(`decisions+${c.decisionsAdd.length}`);
      if (c.nextObjective) bits.push(`next=${c.nextObjective}`);
      lines.push(`- ${entry.at}: ${bits.join(", ") || "noop"}`);
    }
  }
  return lines.join("\n");
}

function extractBalancedJsonObjects(text = "") {
  const source = String(text || "");
  const objects = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < source.length; j += 1) {
      const ch = source[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(source.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  return objects;
}

function isStructuredSideEffectPayload(parsed = null) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  // Strict: only recognized control envelopes. Do not treat arbitrary JSON
  // (examples, docs, code) as executable side effects.
  return Boolean(
    parsed.stateCommit
    || parsed.contextPlan
    || parsed.nextSegment
    || parsed.type === "execution_segment",
  );
}

function parseStructuredSideEffects(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const candidates = [];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/g);
  if (fence) {
    for (const block of fence) {
      candidates.push(block.replace(/```(?:json)?/g, "").replace(/```/g, "").trim());
    }
  }
  candidates.push(raw);
  for (const objectText of extractBalancedJsonObjects(raw)) {
    candidates.push(objectText);
  }

  for (const item of candidates) {
    try {
      const parsed = JSON.parse(item);
      if (isStructuredSideEffectPayload(parsed)) return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function resolveCommitInterval(env = process.env) {
  const parsed = Number.parseInt(String(env.UFOO_UCODE_COMMIT_INTERVAL || ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 4;
}

function validateStateCommit(commit = {}) {
  const normalized = normalizeStateCommit(commit);
  const errors = [];
  for (const listName of ["factsAdd", "hypothesesAdd", "decisionsAdd", "questionsAdd", "questionsClose"]) {
    const list = normalized[listName];
    if (!Array.isArray(list)) errors.push(`${listName} must be an array`);
    else if (list.some((item) => String(item).length > 500)) errors.push(`${listName} item too long`);
  }
  for (const listName of ["factsUpdate", "hypothesesUpdate"]) {
    const list = normalized[listName];
    if (!Array.isArray(list)) errors.push(`${listName} must be an array`);
    else {
      for (const entry of list) {
        if (!entry || typeof entry !== "object" || !entry.from || !entry.to) {
          errors.push(`${listName} entries require from/to`);
        }
      }
    }
  }
  if (normalized.nextObjective.length > 500) errors.push("nextObjective too long");
  return { ok: errors.length === 0, errors, commit: normalized };
}

function buildDeterministicToolCommit(toolEvent = {}) {
  const source = toolEvent && typeof toolEvent === "object" ? toolEvent : {};
  const tool = String(source.tool || "").trim().toLowerCase();
  const preview = String(source.preview || source.summary || "").trim();
  const artifactId = String(source.artifactId || "").trim();
  if (!tool && !preview) return null;
  const fact = [
    tool ? `tool:${tool}` : "",
    artifactId ? `artifact:${artifactId}` : "",
    preview ? preview.slice(0, 180) : "",
  ].filter(Boolean).join(" ");
  if (!fact) return null;
  return {
    factsAdd: [fact],
    nextObjective: "",
  };
}

function shouldCommitAfterToolCall(session = {}, interval = resolveCommitInterval()) {
  const count = Number(session.toolCallsSinceCommit) || 0;
  return count >= interval;
}

function appendCommitLog(workspaceRoot = process.cwd(), sessionId = "", commitEntry = {}) {
  if (!sessionId) return { ok: false, error: "invalid session id" };
  const fs = require("fs");
  const path = require("path");
  const filePath = path.join(
    path.resolve(workspaceRoot || process.cwd()),
    ".ufoo",
    "agent",
    "ucode",
    "commits",
    `${sessionId}.jsonl`,
  );
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(commitEntry)}\n`, "utf8");
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "failed to append commit log" };
  }
}

function resolveCommitFoldThreshold(env = process.env) {
  const parsed = Number.parseInt(String(env.UFOO_UCODE_COMMIT_FOLD_THRESHOLD || ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 8;
}

function foldCommitsIfNeeded(stateEpoch = null, threshold = resolveCommitFoldThreshold()) {
  const epoch = stateEpoch && typeof stateEpoch === "object"
    ? JSON.parse(JSON.stringify(stateEpoch))
    : emptyStateEpoch();
  const commits = Array.isArray(epoch.commits) ? epoch.commits : [];
  if (commits.length < threshold) return epoch;
  epoch.commits = commits.slice(-3);
  epoch.epochId = (Number(epoch.epochId) || 1) + 1;
  return epoch;
}

function patchTaskContractFromUserMessage(contract = {}, userMessage = "") {
  const constraints = extractConstraintsFromText(userMessage);
  if (constraints.length === 0) return contract;
  return patchTaskContract(contract, { constraints });
}

function applyValidatedStateCommit(session = {}, commit = {}, workspaceRoot = process.cwd()) {
  const validated = validateStateCommit(commit);
  if (!validated.ok) return { ok: false, errors: validated.errors, stateEpoch: session.stateEpoch };
  session.stateEpoch = applyStateCommit(session.stateEpoch, validated.commit);
  session.stateEpoch = foldCommitsIfNeeded(session.stateEpoch);
  session.toolCallsSinceCommit = 0;
  appendCommitLog(workspaceRoot, session.sessionId, {
    at: new Date().toISOString(),
    commit: validated.commit,
    source: "runtime",
  });
  return { ok: true, errors: [], stateEpoch: session.stateEpoch };
}

function ensureTaskContract(session = {}, userTask = "") {
  if (session.taskContract && session.taskContract.objective) return session.taskContract;
  session.taskContract = buildInitialTaskContract(userTask);
  return session.taskContract;
}

function ensureStateEpoch(session = {}) {
  if (session.stateEpoch && session.stateEpoch.snapshot) return session.stateEpoch;
  session.stateEpoch = emptyStateEpoch();
  return session.stateEpoch;
}

module.exports = {
  emptyTaskContract,
  emptyStateEpoch,
  buildInitialTaskContract,
  patchTaskContract,
  patchTaskContractFromUserMessage,
  renderTaskContract,
  normalizeStateCommit,
  validateStateCommit,
  buildDeterministicToolCommit,
  resolveCommitInterval,
  resolveCommitFoldThreshold,
  foldCommitsIfNeeded,
  shouldCommitAfterToolCall,
  appendCommitLog,
  applyValidatedStateCommit,
  applyStateCommit,
  renderStateEpoch,
  parseStructuredSideEffects,
  extractBalancedJsonObjects,
  isStructuredSideEffectPayload,
  ensureTaskContract,
  ensureStateEpoch,
};
