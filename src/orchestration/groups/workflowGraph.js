"use strict";

/**
 * Multi-mode Workflow Graph & Temporary (Ad-Hoc) Group Engine.
 *
 * - Reads active template groups (.ufoo/groups/*.json) and projects their
 *   member workflow edges onto live subscriber IDs.
 * - Manages temporary / ad-hoc groups (kind === "adhoc") formed automatically
 *   whenever a user wires 2+ non-template agents together in Multi mode.
 * - Persists canvas node positions (.ufoo/desktop-workflow-layout.json).
 * - Resolves live downstream auto-forward targets for internalRunner.js.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getUfooPaths } = require("../../coordination/state/paths");
const { loadAgentsData, updateAgentsData } = require("../../coordination/state/agentsStore");
const { isMetaActive } = require("../../coordination/bus/utils");
const { reconcileGroupStatus } = require("../../runtime/daemon/groupStatus");
const { collectTemplateEdges } = require("./diagram");

const MAX_WORKFLOW_HOPS = 4;
const MIN_NODE_WIDTH = 220;
const MAX_NODE_WIDTH = 960;
const MIN_NODE_HEIGHT = 160;
const MAX_NODE_HEIGHT = 900;

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeNodeGeometry(entry, existing = null) {
  if (!entry || typeof entry !== "object") return null;
  const x = Number.isFinite(entry.x) ? Math.round(entry.x) : existing?.x;
  const y = Number.isFinite(entry.y) ? Math.round(entry.y) : existing?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const out = { x, y };
  const rawW = Number.isFinite(entry.w) ? entry.w : existing?.w;
  const rawH = Number.isFinite(entry.h) ? entry.h : existing?.h;
  if (Number.isFinite(rawW)) out.w = clampInt(rawW, MIN_NODE_WIDTH, MAX_NODE_WIDTH);
  if (Number.isFinite(rawH)) out.h = clampInt(rawH, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT);
  return out;
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function layoutFilePath(projectRoot) {
  return path.join(getUfooPaths(projectRoot).ufooDir, "desktop-workflow-layout.json");
}

function readNodePositions(projectRoot) {
  const file = layoutFilePath(projectRoot);
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const positions = parsed && typeof parsed.positions === "object" ? parsed.positions : {};
    const out = {};
    for (const [id, pt] of Object.entries(positions)) {
      const normalized = normalizeNodeGeometry(pt);
      if (normalized) out[id] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

function saveNodePositions(projectRoot, patch = {}) {
  if (!projectRoot || !patch || typeof patch !== "object") return readNodePositions(projectRoot);
  const file = layoutFilePath(projectRoot);
  const current = readNodePositions(projectRoot);
  for (const [id, pt] of Object.entries(patch)) {
    const key = asTrimmedString(id);
    if (!key) continue;
    if (pt === null) {
      delete current[key];
    } else {
      const normalized = normalizeNodeGeometry(pt, current[key]);
      if (normalized) current[key] = normalized;
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, positions: current, updated_at: nowIso() }, null, 2)}\n`, "utf8");
  } catch {
    // best-effort layout persistence
  }
  return current;
}

function listRawGroupRuntimes(projectRoot) {
  const groupsDir = getUfooPaths(projectRoot).groupsDir;
  if (!groupsDir || !fs.existsSync(groupsDir)) return [];
  const out = [];
  try {
    const files = fs.readdirSync(groupsDir)
      .filter((name) => name.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    for (const file of files) {
      const filePath = path.join(groupsDir, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (parsed && typeof parsed === "object" && parsed.group_id) {
          out.push({ filePath, runtime: parsed });
        }
      } catch {
        // ignore malformed group state
      }
    }
  } catch {
    return [];
  }
  return out;
}

function isAdhocGroup(runtime = {}) {
  return runtime.kind === "adhoc"
    || runtime.template_alias === "adhoc"
    || String(runtime.group_id || "").startsWith("adhoc-");
}

function isCanvasWorkerSubscriber(id, agentsMap) {
  const key = asTrimmedString(id);
  if (!key || key === "ufoo-agent" || key === "ufoo") return false;
  const meta = agentsMap[key];
  if (!isMetaActive(meta)) return false;
  const agentType = asTrimmedString(meta.agent_type || meta.type).toLowerCase();
  const role = asTrimmedString(meta.role).toLowerCase();
  if (agentType === "ufoo" || agentType === "ufoo-agent" || role === "controller") return false;
  return true;
}

function runtimeTimestampMs(runtime = {}) {
  const raw = runtime.updated_at || runtime.started_at || runtime.created_at || "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function readAgentsMap(projectRoot) {
  try {
    const data = loadAgentsData(getUfooPaths(projectRoot).agentsFile);
    return data && data.agents && typeof data.agents === "object" ? data.agents : {};
  } catch {
    return {};
  }
}

function extractTemplateGroupEdges(runtime = {}) {
  const members = Array.isArray(runtime.members) ? runtime.members : [];
  const byNickname = new Map();
  const byAgentId = new Map();
  const bySubscriber = new Map();

  for (const m of members) {
    const subId = asTrimmedString(m.subscriber_id);
    if (!subId) continue;
    bySubscriber.set(subId, m);
    if (m.nickname) byNickname.set(asTrimmedString(m.nickname), subId);
    if (m.scoped_nickname) byNickname.set(asTrimmedString(m.scoped_nickname), subId);
    if (m.template_agent_id) byAgentId.set(asTrimmedString(m.template_agent_id), subId);
  }

  const resolveEndpoint = (ref) => {
    const key = asTrimmedString(ref);
    if (!key) return "";
    if (bySubscriber.has(key)) return key;
    if (byNickname.has(key)) return byNickname.get(key);
    if (byAgentId.has(key)) return byAgentId.get(key);
    return "";
  };

  const edges = [];
  const seen = new Set();
  const pushEdge = (fromRef, toRef, kind = "handoff") => {
    const from = resolveEndpoint(fromRef);
    const to = resolveEndpoint(toRef);
    if (!from || !to || from === to) return;
    const edgeKind = asTrimmedString(kind) || "handoff";
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      id: `tpl:${runtime.group_id}:${from}->${to}`,
      from,
      to,
      kind: edgeKind,
      group_id: runtime.group_id,
      origin: "template",
      readonly: true,
      auto_forward: false,
    });
  };

  // 1. Explicit runtime.edges (persisted by buildDefaultRuntime)
  if (Array.isArray(runtime.edges) && runtime.edges.length > 0) {
    for (const edge of runtime.edges) {
      pushEdge(edge?.from, edge?.to, edge?.kind || "task");
    }
  }

  // 2. Fallback: read template_file if runtime predates persisted runtime.edges
  if (edges.length === 0 && runtime.template_file && fs.existsSync(runtime.template_file)) {
    try {
      const tplDoc = JSON.parse(fs.readFileSync(runtime.template_file, "utf8"));
      const tplEdges = collectTemplateEdges(tplDoc, members);
      for (const edge of tplEdges) {
        pushEdge(edge.from, edge.to, edge.kind || "task");
      }
    } catch {
      // ignore missing/malformed template file
    }
  }

  // 3. Fallback: derive from member report_to / downstream / depends_on
  if (edges.length === 0) {
    for (const m of members) {
      const selfRef = m.subscriber_id || m.nickname;
      for (const target of (Array.isArray(m.report_to) ? m.report_to : [])) {
        pushEdge(selfRef, target, "handoff");
      }
      for (const target of (Array.isArray(m.downstream) ? m.downstream : [])) {
        pushEdge(selfRef, target, "handoff");
      }
      for (const dep of (Array.isArray(m.depends_on) ? m.depends_on : [])) {
        pushEdge(dep, selfRef, "depends_on");
      }
    }
  }

  return edges;
}

function getActiveAdhocRuntime(projectRoot, agents = null) {
  const agentsMap = agents || readAgentsMap(projectRoot);
  const runtimes = listRawGroupRuntimes(projectRoot);
  for (const { filePath, runtime } of runtimes) {
    if (!isAdhocGroup(runtime)) continue;
    if (runtime.status === "stopped") continue;
    const rawEdges = Array.isArray(runtime.edges) ? runtime.edges : [];
    const activeEdges = rawEdges.filter(
      (e) => e && e.from && e.to && e.from !== e.to && isMetaActive(agentsMap[e.from]) && isMetaActive(agentsMap[e.to])
    );
    if (activeEdges.length > 0) {
      return { filePath, runtime, activeEdges };
    }
  }
  return null;
}

function syncAdhocMembershipInAgentsJson(projectRoot, groupId, memberIds = []) {
  const agentsFile = getUfooPaths(projectRoot).agentsFile;
  if (!fs.existsSync(agentsFile)) return;
  const memberSet = new Set(memberIds);
  try {
    updateAgentsData(agentsFile, (parsed) => {
      if (!parsed.agents || typeof parsed.agents !== "object") return false;
      let changed = false;
      for (const [id, meta] of Object.entries(parsed.agents)) {
        if (!meta || typeof meta !== "object") continue;
        if (memberSet.has(id)) {
          if (meta.group_id !== groupId || meta.group_template_alias !== "adhoc") {
            meta.group_id = groupId;
            meta.group_template_alias = "adhoc";
            changed = true;
          }
        } else if (meta.group_id === groupId || (String(meta.group_id || "").startsWith("adhoc-") && !groupId)) {
          meta.group_id = "";
          if (meta.group_template_alias === "adhoc") meta.group_template_alias = "";
          changed = true;
        }
      }
      return changed;
    });
  } catch {
    // best-effort sync
  }
}

function buildAdhocMembers(memberIds, edges, agentsMap) {
  return memberIds.map((id, index) => {
    const meta = agentsMap[id] || {};
    const label = asTrimmedString(meta.display_nickname || meta.nickname || id);
    const downstream = [...new Set(edges.filter((e) => e.from === id).map((e) => e.to))];
    const upstream = [...new Set(edges.filter((e) => e.to === id).map((e) => e.from))];
    return {
      index,
      template_agent_id: id,
      nickname: label,
      scoped_nickname: label,
      type: asTrimmedString(meta.agent_type || meta.type || id.split(":")[0] || "worker"),
      role: "ad-hoc workflow member",
      status: isMetaActive(meta) ? "active" : "stopped",
      managed: false,
      subscriber_id: id,
      upstream,
      downstream,
      accept_from: upstream,
      report_to: downstream,
      depends_on: upstream,
    };
  });
}

function writeAdhocRuntime(projectRoot, groupId, edges, agentsMap, existingRuntime = null) {
  const groupsDir = getUfooPaths(projectRoot).groupsDir;
  fs.mkdirSync(groupsDir, { recursive: true });
  const filePath = path.join(groupsDir, `${groupId}.json`);
  const connectedIds = [];
  const seen = new Set();
  for (const edge of edges) {
    if (!seen.has(edge.from)) { seen.add(edge.from); connectedIds.push(edge.from); }
    if (!seen.has(edge.to)) { seen.add(edge.to); connectedIds.push(edge.to); }
  }

  if (connectedIds.length < 2 || edges.length === 0) {
    // Dissolve temporary group cleanly when fewer than 2 connected agents remain
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    } catch {
      // ignore
    }
    syncAdhocMembershipInAgentsJson(projectRoot, "", []);
    return null;
  }

  const now = nowIso();
  const runtime = {
    group_id: groupId,
    kind: "adhoc",
    status: "active",
    template_alias: "adhoc",
    template_name: asTrimmedString(existingRuntime?.template_name) || "Temporary Group",
    created_at: existingRuntime?.created_at || now,
    started_at: existingRuntime?.started_at || now,
    updated_at: now,
    members: buildAdhocMembers(connectedIds, edges, agentsMap),
    edges: edges.map((e) => ({
      id: e.id || `adhoc:${e.from}->${e.to}`,
      from: e.from,
      to: e.to,
      kind: asTrimmedString(e.kind) || "handoff",
      auto_forward: e.auto_forward !== false,
    })),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
  syncAdhocMembershipInAgentsJson(projectRoot, groupId, connectedIds);
  return runtime;
}

function findTemplateGroupOwner(projectRoot, subscriberId, agentsMap) {
  const meta = agentsMap[subscriberId];
  const groupId = asTrimmedString(meta?.group_id);
  if (!groupId || groupId.startsWith("adhoc-")) return null;
  const runtimes = listRawGroupRuntimes(projectRoot);
  for (const { runtime } of runtimes) {
    if (isAdhocGroup(runtime)) continue;
    const reconciled = reconcileGroupStatus(runtime, agentsMap);
    if (!["active", "partial", "starting"].includes(reconciled.status)) continue;
    const owns = runtime.group_id === groupId
      || (Array.isArray(runtime.members) && runtime.members.some((m) => m?.subscriber_id === subscriberId));
    if (owns) return runtime;
  }
  return null;
}

/**
 * Connect two agents with a directed workflow edge (from -> to).
 * Automatically creates or expands a temporary ad-hoc group when 2+ agents are connected.
 */
function connectWorkflowEdge(projectRoot, { from, to, kind = "handoff" } = {}) {
  const source = asTrimmedString(from);
  const target = asTrimmedString(to);
  if (!source || !target) return { ok: false, error: "from and to agent IDs are required" };
  if (source === target) return { ok: false, error: "Cannot connect an agent to itself" };

  const agentsMap = readAgentsMap(projectRoot);
  if (!isMetaActive(agentsMap[source])) return { ok: false, error: `Source agent is not active: ${source}` };
  if (!isMetaActive(agentsMap[target])) return { ok: false, error: `Target agent is not active: ${target}` };

  const sourceOwner = findTemplateGroupOwner(projectRoot, source, agentsMap);
  if (sourceOwner) {
    return { ok: false, error: `${source} belongs to template group "${sourceOwner.template_alias || sourceOwner.group_id}"` };
  }
  const targetOwner = findTemplateGroupOwner(projectRoot, target, agentsMap);
  if (targetOwner) {
    return { ok: false, error: `${target} belongs to template group "${targetOwner.template_alias || targetOwner.group_id}"` };
  }

  const existing = getActiveAdhocRuntime(projectRoot, agentsMap);
  const groupId = existing?.runtime?.group_id || `adhoc-${crypto.randomBytes(3).toString("hex")}`;
  const currentEdges = existing ? existing.activeEdges.slice() : [];

  const edgeId = `adhoc:${source}->${target}`;
  if (currentEdges.some((e) => e.from === source && e.to === target)) {
    return {
      ok: true,
      already_connected: true,
      group_id: groupId,
      edge_id: edgeId,
      snapshot: getWorkflowSnapshot(projectRoot),
    };
  }

  currentEdges.push({
    id: edgeId,
    from: source,
    to: target,
    kind: asTrimmedString(kind) || "handoff",
    auto_forward: true,
  });

  const saved = writeAdhocRuntime(projectRoot, groupId, currentEdges, agentsMap, existing?.runtime || null);
  return {
    ok: true,
    created_group: !existing && Boolean(saved),
    group_id: saved?.group_id || "",
    edge_id: edgeId,
    snapshot: getWorkflowSnapshot(projectRoot),
  };
}

/**
 * Remove a directed workflow edge (by edgeId or from+to).
 * Dissolves the temporary ad-hoc group automatically if no connected edges remain.
 */
function disconnectWorkflowEdge(projectRoot, { edgeId = "", from = "", to = "" } = {}) {
  const agentsMap = readAgentsMap(projectRoot);
  const existing = getActiveAdhocRuntime(projectRoot, agentsMap);
  if (!existing) {
    return { ok: true, removed: false, snapshot: getWorkflowSnapshot(projectRoot) };
  }

  const cleanEdgeId = asTrimmedString(edgeId);
  const cleanFrom = asTrimmedString(from);
  const cleanTo = asTrimmedString(to);

  const nextEdges = existing.activeEdges.filter((e) => {
    if (cleanEdgeId && e.id === cleanEdgeId) return false;
    if (cleanFrom && cleanTo && e.from === cleanFrom && e.to === cleanTo) return false;
    return true;
  });

  if (nextEdges.length === existing.activeEdges.length) {
    return { ok: true, removed: false, snapshot: getWorkflowSnapshot(projectRoot) };
  }

  const saved = writeAdhocRuntime(
    projectRoot,
    existing.runtime.group_id,
    nextEdges,
    agentsMap,
    existing.runtime
  );
  return {
    ok: true,
    removed: true,
    dissolved: !saved,
    group_id: saved?.group_id || "",
    snapshot: getWorkflowSnapshot(projectRoot),
  };
}

/**
 * Dissolve the active temporary ad-hoc group and remove all temporary edges.
 */
function disbandAdhocGroup(projectRoot) {
  const agentsMap = readAgentsMap(projectRoot);
  const runtimes = listRawGroupRuntimes(projectRoot);
  let disbanded = 0;
  for (const { filePath, runtime } of runtimes) {
    if (!isAdhocGroup(runtime)) continue;
    try {
      if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      disbanded += 1;
    } catch {
      // ignore
    }
  }
  syncAdhocMembershipInAgentsJson(projectRoot, "", []);
  return {
    ok: true,
    disbanded,
    snapshot: getWorkflowSnapshot(projectRoot),
  };
}

/**
 * Rename the active temporary ad-hoc group.
 */
function renameAdhocGroup(projectRoot, rawName) {
  const cleanName = asTrimmedString(rawName).replace(/\s+/g, " ").slice(0, 48);
  if (!cleanName) {
    return { ok: false, error: "Group name cannot be empty" };
  }
  const agentsMap = readAgentsMap(projectRoot);
  const existing = getActiveAdhocRuntime(projectRoot, agentsMap);
  if (!existing) {
    return { ok: false, error: "No active temporary group to rename" };
  }
  const updated = {
    ...existing.runtime,
    template_name: cleanName,
    updated_at: nowIso(),
  };
  fs.writeFileSync(existing.filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return {
    ok: true,
    group_id: updated.group_id,
    name: cleanName,
    snapshot: getWorkflowSnapshot(projectRoot),
  };
}

/**
 * Build the complete workflow snapshot for the Desktop Multi canvas.
 */
function getWorkflowSnapshot(projectRoot) {
  const agentsMap = readAgentsMap(projectRoot);
  const runtimes = listRawGroupRuntimes(projectRoot);
  const groups = [];
  const edges = [];
  const seenEdgeKeys = new Set();

  const adhocRuntimes = [];
  const templateRuntimes = [];
  for (const item of runtimes) {
    if (isAdhocGroup(item.runtime)) adhocRuntimes.push(item);
    else templateRuntimes.push(item);
  }

  // Newest template runtimes claim live workers first so historical/reused group files never duplicate
  templateRuntimes.sort((a, b) => runtimeTimestampMs(b.runtime) - runtimeTimestampMs(a.runtime));

  const claimedTemplateWorkers = new Set();
  for (const { runtime } of templateRuntimes) {
    const reconciled = reconcileGroupStatus(runtime, agentsMap);
    if (!["active", "partial", "starting"].includes(reconciled.status)) continue;
    const memberIds = [];
    const seenMembers = new Set();
    for (const m of (Array.isArray(reconciled.members) ? reconciled.members : [])) {
      const id = asTrimmedString(m?.subscriber_id);
      if (!id || seenMembers.has(id) || claimedTemplateWorkers.has(id)) continue;
      if (!isCanvasWorkerSubscriber(id, agentsMap)) continue;
      const explicitGroupId = asTrimmedString(agentsMap[id]?.group_id);
      if (explicitGroupId && explicitGroupId !== reconciled.group_id) continue;
      seenMembers.add(id);
      memberIds.push(id);
    }
    if (memberIds.length === 0) continue;
    for (const id of memberIds) claimedTemplateWorkers.add(id);

    const tplEdges = extractTemplateGroupEdges(reconciled).filter(
      (e) => seenMembers.has(e.from) && seenMembers.has(e.to)
    );
    for (const edge of tplEdges) {
      const key = `${edge.from}->${edge.to}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      edges.push(edge);
    }
    groups.push({
      group_id: reconciled.group_id,
      name: asTrimmedString(reconciled.template_name || reconciled.template_alias || reconciled.group_id),
      template_alias: asTrimmedString(reconciled.template_alias),
      origin: "template",
      status: reconciled.status,
      readonly: true,
      member_ids: memberIds,
    });
  }

  for (const { runtime } of adhocRuntimes) {
    if (runtime.status === "stopped") continue;
    const rawEdges = Array.isArray(runtime.edges) ? runtime.edges : [];
    const activeEdges = rawEdges.filter(
      (e) =>
        e &&
        e.from &&
        e.to &&
        e.from !== e.to &&
        isCanvasWorkerSubscriber(e.from, agentsMap) &&
        isCanvasWorkerSubscriber(e.to, agentsMap) &&
        !claimedTemplateWorkers.has(e.from) &&
        !claimedTemplateWorkers.has(e.to)
    );
    if (activeEdges.length === 0) continue;
    const memberIds = [];
    const seenMembers = new Set();
    for (const e of activeEdges) {
      if (!seenMembers.has(e.from)) { seenMembers.add(e.from); memberIds.push(e.from); }
      if (!seenMembers.has(e.to)) { seenMembers.add(e.to); memberIds.push(e.to); }
      const key = `${e.from}->${e.to}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      edges.push({
        id: e.id || `adhoc:${e.from}->${e.to}`,
        from: e.from,
        to: e.to,
        kind: asTrimmedString(e.kind) || "handoff",
        group_id: runtime.group_id,
        origin: "adhoc",
        readonly: false,
        auto_forward: e.auto_forward !== false,
      });
    }
    groups.push({
      group_id: runtime.group_id,
      name: runtime.template_name || "Temp Group",
      template_alias: "adhoc",
      origin: "adhoc",
      status: "active",
      readonly: false,
      member_ids: memberIds,
    });
  }

  return {
    project_root: projectRoot,
    groups,
    edges,
    positions: readNodePositions(projectRoot),
  };
}

/**
 * Resolve live downstream auto-forward targets for a worker finishing a turn.
 * Only forwards along active ad-hoc edges with auto_forward !== false.
 */
function resolveWorkflowForwardTargets(projectRoot, fromSubscriberId, incomingMeta = {}) {
  const source = asTrimmedString(fromSubscriberId);
  if (!projectRoot || !source) return [];
  const currentHop = Number(incomingMeta.workflow_hop) || 0;
  if (currentHop >= MAX_WORKFLOW_HOPS) return [];

  const agentsMap = readAgentsMap(projectRoot);
  const adhoc = getActiveAdhocRuntime(projectRoot, agentsMap);
  if (!adhoc) return [];

  const trail = Array.isArray(incomingMeta.workflow_trail)
    ? incomingMeta.workflow_trail.map((item) => String(item || ""))
    : [];

  const targets = [];
  for (const edge of adhoc.activeEdges) {
    if (edge.from !== source || edge.auto_forward === false) continue;
    if (!isMetaActive(agentsMap[edge.to])) continue;
    const edgeKey = `${edge.from}->${edge.to}`;
    // Prevent immediate edge ping-pong within the same hop chain
    if (trail.includes(edgeKey)) continue;
    targets.push({
      group_id: adhoc.runtime.group_id,
      edge_id: edge.id || `adhoc:${edgeKey}`,
      from: edge.from,
      to: edge.to,
      kind: asTrimmedString(edge.kind) || "handoff",
      next_hop: currentHop + 1,
      next_trail: [...trail, edgeKey],
    });
  }
  return targets;
}

module.exports = {
  MAX_WORKFLOW_HOPS,
  readNodePositions,
  saveNodePositions,
  connectWorkflowEdge,
  disconnectWorkflowEdge,
  disbandAdhocGroup,
  renameAdhocGroup,
  getWorkflowSnapshot,
  resolveWorkflowForwardTargets,
};
