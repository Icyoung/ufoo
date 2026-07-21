"use strict";

const { loadArtifact, readArtifactSlice } = require("./artifacts");

function emptyWorkingSet() {
  return [];
}

function normalizeWorkingSetEntry(entry = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  return {
    artifactId: String(source.artifactId || "").trim(),
    selector: source.selector && typeof source.selector === "object" ? source.selector : {},
    intent: String(source.intent || "inspect").trim(),
    retention: String(source.retention || "retain_region").trim(),
    expiresWhen: String(source.expiresWhen || "").trim(),
    priority: Number.isFinite(source.priority) ? source.priority : 0.5,
    addedAt: source.addedAt || new Date().toISOString(),
  };
}

function workingSetArtifactIds(workingSet = []) {
  return new Set(
    (Array.isArray(workingSet) ? workingSet : [])
      .map((entry) => String(entry && entry.artifactId || "").trim())
      .filter(Boolean),
  );
}

function isWorkingSetEntryExpired(entry = {}, session = {}) {
  const expires = String(entry.expiresWhen || "").trim();
  if (!expires) return false;
  const turnMatch = expires.match(/^turn:\+(\d+)$/i);
  if (turnMatch) {
    const addedTurn = Number(entry.addedAtTurn);
    const currentTurn = Number(session.currentTurn);
    if (!Number.isFinite(addedTurn) || !Number.isFinite(currentTurn)) return false;
    return currentTurn - addedTurn > Number.parseInt(turnMatch[1], 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(expires)) {
    const deadline = new Date(expires);
    if (!Number.isNaN(deadline.getTime())) return Date.now() > deadline.getTime();
  }
  return false;
}

function pruneExpiredWorkingSetEntries(workingSet = [], session = {}) {
  const list = Array.isArray(workingSet) ? workingSet.map(normalizeWorkingSetEntry) : [];
  const expired = [];
  const kept = list.filter((entry) => {
    if (!isWorkingSetEntryExpired(entry, session)) return true;
    expired.push(entry.artifactId);
    return false;
  });
  for (const artifactId of expired) {
    recordVeto(session, "ttl_expired", artifactId, "");
  }
  return kept;
}

const MAX_WORKING_SET = 12;
const MAX_REHYDRATE_PER_PLAN = 4;

function recordVeto(session = {}, type = "", artifactId = "", detail = "") {
  if (!session || typeof session !== "object") return;
  session.lastContextVetoes = [
    ...(Array.isArray(session.lastContextVetoes) ? session.lastContextVetoes : []),
    {
      at: new Date().toISOString(),
      type: String(type || "veto"),
      artifactId: String(artifactId || ""),
      detail: String(detail || ""),
    },
  ].slice(-20);
}

function applyRehydrateNext(entries = [], plan = {}, session = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const byId = new Set(list.map((e) => e.artifactId).filter(Boolean));
  const workspaceRoot = session.workspaceRoot || process.cwd();
  const sessionId = session.sessionId || "";
  const requested = Array.isArray(plan.rehydrateNext) ? plan.rehydrateNext : [];
  let accepted = 0;
  let processed = 0;

  for (const item of requested) {
    const id = typeof item === "string"
      ? String(item || "").trim()
      : String((item && item.artifactId) || "").trim();
    if (!id) continue;
    if (processed >= MAX_REHYDRATE_PER_PLAN) {
      recordVeto(session, "rehydrate_cap", id, `max ${MAX_REHYDRATE_PER_PLAN} per plan`);
      break;
    }
    processed += 1;
    if (byId.has(id)) continue;

    const loaded = loadArtifact(workspaceRoot, sessionId, id);
    if (!loaded.ok || !loaded.artifact) {
      recordVeto(session, "rehydrate_missing", id, loaded.error || "not found");
      continue;
    }
    if (loaded.artifact.cold === true) {
      // Cold artifacts may rehydrate as preview-only regions, never retain_raw.
      const entry = normalizeWorkingSetEntry({
        artifactId: id,
        intent: "rehydrate_cold",
        retention: "retain_region",
        priority: 0.55,
        selector: (item && typeof item === "object" && item.selector) || { maxChars: 800 },
      });
      if (list.length >= MAX_WORKING_SET) {
        const lowestIdx = list.reduce((best, cur, idx) => (
          cur.priority < list[best].priority ? idx : best
        ), 0);
        if (list[lowestIdx].priority >= entry.priority) {
          recordVeto(session, "rehydrate_rejected", id, "working set full");
          continue;
        }
        recordVeto(session, "cap_evicted", list[lowestIdx].artifactId, "displaced by rehydrate");
        byId.delete(list[lowestIdx].artifactId);
        list.splice(lowestIdx, 1);
      }
      list.push(entry);
      byId.add(id);
      accepted += 1;
      continue;
    }

    const entry = normalizeWorkingSetEntry({
      artifactId: id,
      intent: "rehydrate",
      retention: "retain_region",
      priority: 0.7,
      selector: (item && typeof item === "object" && item.selector) || {},
    });
    if (list.length >= MAX_WORKING_SET) {
      const lowestIdx = list.reduce((best, cur, idx) => (
        cur.priority < list[best].priority ? idx : best
      ), 0);
      if (list[lowestIdx].priority >= entry.priority) {
        recordVeto(session, "rehydrate_rejected", id, "working set full");
        continue;
      }
      recordVeto(session, "cap_evicted", list[lowestIdx].artifactId, "displaced by rehydrate");
      byId.delete(list[lowestIdx].artifactId);
      list.splice(lowestIdx, 1);
    }
    list.push(entry);
    byId.add(id);
    accepted += 1;
  }

  return list.slice(0, MAX_WORKING_SET);
}

function applyWorkingSetPlan(workingSet = [], plan = {}, session = {}) {
  const current = pruneExpiredWorkingSetEntries(
    Array.isArray(workingSet) ? workingSet.map(normalizeWorkingSetEntry) : [],
    session,
  );
  const source = plan && typeof plan === "object" ? plan : {};
  const byId = new Map(current.map((e) => [e.artifactId, e]));

  for (const artifactId of source.retainRaw || []) {
    const id = String(artifactId || "").trim();
    if (!id) continue;
    byId.set(id, normalizeWorkingSetEntry({
      artifactId: id,
      intent: "retain_raw",
      retention: "retain_raw",
      priority: 0.95,
      ...(byId.get(id) || {}),
    }));
  }

  for (const entry of source.retainRegions || []) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.artifactId || "").trim();
    if (!id) continue;
    byId.set(id, normalizeWorkingSetEntry({
      artifactId: id,
      selector: entry.selector || {},
      intent: entry.intent || "inspect",
      retention: "retain_region",
      priority: entry.priority || 0.8,
      ...(byId.get(id) || {}),
    }));
  }

  for (const artifactId of source.evict || []) {
    byId.delete(String(artifactId || "").trim());
  }

  for (const entry of source.summarize || []) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.artifactId || "").trim();
    if (!id) continue;
    const existing = byId.get(id) || normalizeWorkingSetEntry({ artifactId: id });
    byId.set(id, normalizeWorkingSetEntry({
      ...existing,
      intent: "summarized",
      retention: "retain_region",
      priority: Math.min(existing.priority || 0.5, 0.45),
      selector: entry.selector && typeof entry.selector === "object" ? entry.selector : { maxChars: 1200 },
    }));
  }

  const sorted = Array.from(byId.values()).sort((a, b) => b.priority - a.priority);
  const evicted = sorted.slice(MAX_WORKING_SET).map((entry) => entry.artifactId).filter(Boolean);
  let next = sorted.slice(0, MAX_WORKING_SET);
  for (const artifactId of evicted) {
    recordVeto(session, "cap_evicted", artifactId, "working set cap");
  }

  next = applyRehydrateNext(next, source, session);
  return next.slice(0, MAX_WORKING_SET);
}

function hydrateWorkingSetEntry(entry = {}, session = {}) {
  const normalized = normalizeWorkingSetEntry(entry);
  if (!normalized.artifactId) return null;
  const loaded = loadArtifact(
    session.workspaceRoot || process.cwd(),
    session.sessionId || "",
    normalized.artifactId,
  );
  if (!loaded.ok || !loaded.artifact) return null;
  let selector = normalized.selector && typeof normalized.selector === "object"
    ? { ...normalized.selector }
    : {};
  if (selector.symbol && (!selector.startLine || !selector.endLine)) {
    const { selectorFromSymbol } = require("./artifactIndex");
    const fromSymbol = selectorFromSymbol(loaded.artifact.index || {}, selector.symbol);
    if (fromSymbol) {
      selector = { ...selector, ...fromSymbol };
    }
  }
  const slice = readArtifactSlice(loaded.artifact, selector);
  return {
    ...normalized,
    selector,
    preview: slice.content,
    truncated: Boolean(slice.truncated),
    range: slice.range,
  };
}

function renderWorkingSetContext(workingSet = [], session = {}) {
  const list = Array.isArray(workingSet) ? workingSet : [];
  if (list.length === 0) return "";
  const lines = ["Current Working Set:"];
  for (const entry of list) {
    const hydrated = hydrateWorkingSetEntry(entry, session);
    if (!hydrated) {
      lines.push(`- artifact://${entry.artifactId} (${entry.intent}) [missing]`);
      continue;
    }
    lines.push(`- artifact://${hydrated.artifactId} (${hydrated.intent}, priority=${hydrated.priority})`);
    if (hydrated.preview) {
      lines.push(`  preview:\n${String(hydrated.preview).split(/\r?\n/).map((l) => `  ${l}`).join("\n")}`);
    }
  }
  return lines.join("\n");
}

function pruneWorkingSetByRetention(workingSet = [], session = {}) {
  const list = pruneExpiredWorkingSetEntries(
    Array.isArray(workingSet) ? workingSet.map(normalizeWorkingSetEntry) : [],
    session,
  );
  const segmentId = String(session.executionState && session.executionState.currentSegmentId || "").trim();
  return list.filter((entry) => {
    if (entry.expiresWhen === "patch_applied" && entry.intent === "modify") {
      const modified = session.executionState && Array.isArray(session.executionState.modifiedFiles)
        ? session.executionState.modifiedFiles
        : [];
      const pathHint = entry.selector && entry.selector.path ? String(entry.selector.path) : "";
      if (pathHint && modified.includes(pathHint)) return false;
    }
    if (entry.expiresWhen === "segment_end" && segmentId && entry.addedAt) {
      // Keep during active segment only when priority is high
      return entry.priority >= 0.7;
    }
    return true;
  });
}

function defaultContextPlanFromToolEvent(tool = "", artifactId = "", args = {}) {
  if (!artifactId) return null;
  const name = String(tool || "").trim().toLowerCase();
  if (name === "read" || name === "bash") {
    const selector = {};
    if (args && args.path) selector.path = String(args.path);
    return {
      retainRegions: [{ artifactId, intent: "inspect", priority: 0.75, selector }],
    };
  }
  if (name === "write" || name === "edit") {
    const path = args && args.path ? String(args.path) : "";
    return {
      retainRaw: [artifactId],
      retainRegions: path ? [{ artifactId, intent: "modify", priority: 0.85, selector: { path } }] : [],
    };
  }
  return { retainRaw: [artifactId] };
}

module.exports = {
  MAX_WORKING_SET,
  MAX_REHYDRATE_PER_PLAN,
  emptyWorkingSet,
  normalizeWorkingSetEntry,
  applyWorkingSetPlan,
  applyRehydrateNext,
  hydrateWorkingSetEntry,
  renderWorkingSetContext,
  workingSetArtifactIds,
  pruneWorkingSetByRetention,
  pruneExpiredWorkingSetEntries,
  isWorkingSetEntryExpired,
  defaultContextPlanFromToolEvent,
};
