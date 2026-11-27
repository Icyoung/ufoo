"use strict";

/**
 * Automatic Group Quiescence Rollup Coordinator.
 *
 * Watches active project groups (both template groups and Multi-mode ad-hoc
 * workflow groups). Whenever a group's members finish a round of work — all
 * active members are non-busy and every member's bus DeliveryQueue is empty
 * for a short settle window — it aggregates each member's last-turn output
 * and invokes `onGroupSettled(rollup)` once (idempotently per round) so the
 * `ufoo` main agent can synthesize the round's conclusion for the user.
 */

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");
const { getUfooPaths } = require("../../coordination/state/paths");
const { loadAgentsData } = require("../../coordination/state/agentsStore");
const { isMetaActive } = require("../../coordination/bus/utils");
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");
const { redactSecrets } = require("../privacy/redactor");
const { loadConfig } = require("../../config");

const BUSY_STATES = new Set(["working", "running", "starting", "thinking", "busy"]);
const PAUSED_STATES = new Set(["waiting_user", "paused"]);
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_DELTA_BUFFER_CHARS = 16000;
const DEFAULT_MEMBER_OUTPUT_CHARS = 3200;
const DEFAULT_POLL_MS = 800;
const DEFAULT_SETTLE_DEBOUNCE_MS = 2000;

function asTrimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function isStreamEnvelope(raw) {
  const text = String(raw || "").trim();
  if (!text || !text.startsWith("{") || !text.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && typeof parsed === "object" && parsed.stream === true);
  } catch {
    return false;
  }
}

function clipMemberOutput(raw, maxChars = DEFAULT_MEMBER_OUTPUT_CHARS) {
  const clean = redactSecrets(String(raw || "").trim());
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n...[truncated ${clean.length - maxChars} chars; use read_agent_history for full transcript]`;
}

function readWorktreeStatusSummary(worktreePath) {
  const dir = asTrimmed(worktreePath);
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    const res = spawnSync("git", ["status", "--short"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 1200,
    });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(0, 25);
  } catch {
    return [];
  }
}

function loadActiveGroupsAndAgents(projectRoot) {
  const paths = getUfooPaths(projectRoot);
  let agents = {};
  try {
    const loaded = loadAgentsData(paths.agentsFile);
    agents = loaded && loaded.agents && typeof loaded.agents === "object" ? loaded.agents : {};
  } catch {
    agents = {};
  }

  const groupsById = new Map();
  const memberToGroups = new Map();

  const linkMember = (groupId, subscriberId) => {
    if (!groupId || !subscriberId) return;
    if (!memberToGroups.has(subscriberId)) memberToGroups.set(subscriberId, new Set());
    memberToGroups.get(subscriberId).add(groupId);
  };

  let files = [];
  try {
    if (fs.existsSync(paths.groupsDir)) {
      files = fs.readdirSync(paths.groupsDir).filter((name) => name.endsWith(".json")).sort();
    }
  } catch {
    files = [];
  }

  for (const file of files) {
    let runtime = null;
    try {
      runtime = JSON.parse(fs.readFileSync(path.join(paths.groupsDir, file), "utf8"));
    } catch {
      continue;
    }
    if (!runtime || typeof runtime !== "object" || !runtime.group_id) continue;
    const status = asTrimmed(runtime.status).toLowerCase();
    if (status === "stopped" || status === "archived") continue;

    const groupId = asTrimmed(runtime.group_id);
    const label = asTrimmed(runtime.template_name || runtime.template_alias || groupId);
    const worktreePath = asTrimmed(runtime.worktree?.path || runtime.worktree_path || "");
    const members = [];
    const seen = new Set();

    for (const row of Array.isArray(runtime.members) ? runtime.members : []) {
      const subId = asTrimmed(row?.subscriber_id);
      if (!subId || seen.has(subId)) continue;
      const meta = agents[subId];
      if (!isMetaActive(meta)) continue;
      seen.add(subId);
      const nickname = asTrimmed(meta?.display_nickname || meta?.nickname || row?.nickname || row?.template_agent_id || subId);
      const role = asTrimmed(row?.role || row?.template_agent_id || meta?.role || "");
      members.push({ subscriberId: subId, nickname, role });
      linkMember(groupId, subId);
    }

    // Include any active agents whose agentsStore meta directly tags this group_id
    for (const [subId, meta] of Object.entries(agents)) {
      if (seen.has(subId) || !isMetaActive(meta)) continue;
      if (asTrimmed(meta.group_id) !== groupId) continue;
      seen.add(subId);
      const nickname = asTrimmed(meta.display_nickname || meta.nickname || subId);
      const role = asTrimmed(meta.role || "");
      members.push({ subscriberId: subId, nickname, role });
      linkMember(groupId, subId);
    }

    if (members.length === 0) continue;
    groupsById.set(groupId, {
      groupId,
      label,
      kind: asTrimmed(runtime.kind || (groupId.startsWith("adhoc-") ? "adhoc" : "template")),
      worktreePath,
      members,
    });
  }

  return { agents, groupsById, memberToGroups };
}

function buildGroupRollupPrompt(rollup) {
  const lines = [
    `Runtime notification (Group Round Settled): Group "${rollup.groupLabel}" (${rollup.groupId}) finished round #${rollup.roundId}. All group members are now idle and have no pending queued messages.`,
    "",
    "Member final-turn outputs for this round:",
  ];

  for (const m of rollup.members) {
    const roleTag = m.role && m.role.toLowerCase() !== m.nickname.toLowerCase() ? ` [${m.role}]` : "";
    const statusLabel = m.participated
      ? `${m.status} (${m.turnsInRound} turn${m.turnsInRound === 1 ? "" : "s"})`
      : "idle (did not run this round)";
    lines.push(`### ${m.nickname}${roleTag} (${m.subscriberId}) — ${statusLabel}`);
    if (m.participated) {
      if (m.lastReply) {
        lines.push(m.lastReply);
      } else if (m.lastError) {
        lines.push(`Error: ${m.lastError}`);
      } else {
        lines.push("(No final text output recorded.)");
      }
      if (m.lastError && m.lastReply) {
        lines.push(`Error: ${m.lastError}`);
      }
    }
    lines.push("");
  }

  if (Array.isArray(rollup.changedFiles) && rollup.changedFiles.length > 0) {
    lines.push("Group worktree modified files (`git status --short`):");
    for (const fileLine of rollup.changedFiles) {
      lines.push(`- ${fileLine}`);
    }
    lines.push("");
  }

  if (rollup.origin === "controller") {
    lines.push(
      "Instructions: This round ran under your active coordinated objective. Synthesize a concise, clear summary of this round's conclusions across all participating members (key outcomes, consensus/conflicts, failures or blockers). If the user's parent objective is still incomplete and unblocked, you may proceed with verification or the next required step; if the objective is complete or blocked on a user decision, present the summary cleanly and stop. If any referenced detail is unclear, call read_agent_history(agent=...) to inspect earlier messages instead of guessing."
    );
  } else {
    lines.push(
      "Instructions: All members of this group have stopped for this round. Provide a concise, structured summary of this round's conclusions across all participating members (key outputs, agreements/disagreements, blockers, and suggested next steps) for the user. Do NOT automatically dispatch a new round of work unless the user asks. If any referenced detail is unclear, call read_agent_history(agent=...) to inspect earlier messages instead of guessing."
    );
  }

  return lines.join("\n");
}

function createGroupRoundCoordinator({
  projectRoot,
  onGroupSettled = async () => {},
  pollIntervalMs = DEFAULT_POLL_MS,
  settleDebounceMs = DEFAULT_SETTLE_DEBOUNCE_MS,
  maxMemberOutputChars = DEFAULT_MEMBER_OUTPUT_CHARS,
  startFromBeginning = false,
  isEnabled = null,
  log = () => {},
} = {}) {
  const paths = getUfooPaths(projectRoot);
  const cursors = new Map(); // filename -> { ino, offset, partial, skipFirst }
  const roundStates = new Map(); // groupId -> round state
  let pollTimer = null;
  let stopped = false;
  let initialized = false;

  function checkEnabled() {
    if (typeof isEnabled === "function") return Boolean(isEnabled());
    try {
      const cfg = loadConfig(projectRoot);
      return cfg?.groupAutoSummarize !== false;
    } catch {
      return true;
    }
  }

  function primeCursorsToEnd() {
    let files = [];
    try {
      files = fs.readdirSync(paths.busEventsDir).filter((name) => name.endsWith(".jsonl")).sort().slice(-2);
    } catch {
      return;
    }
    for (const name of files) {
      try {
        const stat = fs.statSync(path.join(paths.busEventsDir, name));
        cursors.set(name, {
          ino: stat.ino,
          offset: stat.size,
          partial: Buffer.alloc(0),
          skipFirst: false,
        });
      } catch {
        // ignore transient file races
      }
    }
  }

  function readIncrementalBusEvents() {
    let files = [];
    try {
      files = fs.readdirSync(paths.busEventsDir).filter((name) => name.endsWith(".jsonl")).sort().slice(-2);
    } catch {
      return [];
    }
    const events = [];
    for (const name of files) {
      let fd;
      try {
        fd = fs.openSync(path.join(paths.busEventsDir, name), "r");
        const stat = fs.fstatSync(fd);
        let cursor = cursors.get(name);
        if (!cursor || cursor.ino !== stat.ino || stat.size < cursor.offset) {
          cursor = {
            ino: stat.ino,
            offset: Math.max(0, stat.size - MAX_READ_BYTES),
            partial: Buffer.alloc(0),
            skipFirst: stat.size > MAX_READ_BYTES,
          };
        }
        if (stat.size - cursor.offset > MAX_READ_BYTES) {
          cursor.offset = stat.size - MAX_READ_BYTES;
          cursor.partial = Buffer.alloc(0);
          cursor.skipFirst = true;
        }
        const toRead = Math.max(0, stat.size - cursor.offset);
        if (toRead === 0) {
          cursors.set(name, cursor);
          continue;
        }
        const buffer = Buffer.alloc(toRead);
        const bytesRead = fs.readSync(fd, buffer, 0, toRead, cursor.offset);
        cursor.offset += bytesRead;
        const combined = Buffer.concat([cursor.partial, buffer.subarray(0, bytesRead)]);
        const lastNewline = combined.lastIndexOf(10);
        const skipFirst = cursor.skipFirst;
        if (lastNewline >= 0) cursor.skipFirst = false;
        cursor.partial = combined.subarray(lastNewline + 1);
        if (cursor.partial.length > MAX_READ_BYTES) {
          cursor.partial = cursor.partial.subarray(-MAX_READ_BYTES);
          cursor.skipFirst = true;
        }
        cursors.set(name, cursor);
        if (lastNewline < 0) continue;
        const lines = combined.subarray(0, lastNewline).toString("utf8").split(/\r?\n/);
        if (skipFirst) lines.shift();
        for (const line of lines) {
          if (!line) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object") events.push(parsed);
          } catch {
            // ignore partial/corrupt lines
          }
        }
      } catch {
        // ignore transient read errors
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch {}
        }
      }
    }
    return events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  }

  function ensureRoundState(groupInfo) {
    let state = roundStates.get(groupInfo.groupId);
    if (!state) {
      state = {
        groupId: groupInfo.groupId,
        groupLabel: groupInfo.label,
        roundId: 0,
        active: false,
        origin: "user",
        parentTaskRunId: "",
        parentSessionId: "main-default",
        startedAt: "",
        lastActivityAt: 0,
        lastSeq: 0,
        settleTimer: null,
        members: new Map(),
      };
      roundStates.set(groupInfo.groupId, state);
    } else {
      state.groupLabel = groupInfo.label;
    }
    return state;
  }

  function clearSettleTimer(state) {
    if (state && state.settleTimer) {
      clearTimeout(state.settleTimer);
      state.settleTimer = null;
    }
  }

  function beginOrContinueRound(state, { origin = "user", parentTaskRunId = "", parentSessionId = "" } = {}) {
    clearSettleTimer(state);
    if (!state.active) {
      state.active = true;
      state.roundId += 1;
      state.origin = origin;
      state.parentTaskRunId = parentTaskRunId || "";
      state.parentSessionId = parentSessionId || "main-default";
      state.startedAt = nowIso();
      state.members.clear();
    } else {
      if (origin === "controller") state.origin = "controller";
      if (parentTaskRunId && !state.parentTaskRunId) state.parentTaskRunId = parentTaskRunId;
      if (parentSessionId && state.parentSessionId === "main-default") state.parentSessionId = parentSessionId;
    }
    state.lastActivityAt = Date.now();
  }

  function ensureMemberRecord(state, subscriberId, groupInfo) {
    let rec = state.members.get(subscriberId);
    if (!rec) {
      const meta = groupInfo.members.find((m) => m.subscriberId === subscriberId);
      rec = {
        subscriberId,
        nickname: meta?.nickname || subscriberId,
        role: meta?.role || "",
        status: "idle",
        lastReply: "",
        lastError: "",
        deltaBuf: "",
        turnsInRound: 0,
        updatedAt: "",
      };
      state.members.set(subscriberId, rec);
    }
    return rec;
  }

  function applyEvent(evt, snapshot) {
    const { groupsById, memberToGroups } = snapshot;
    const seq = Number(evt.seq) || 0;
    const ts = asTrimmed(evt.timestamp || evt.ts) || nowIso();
    const data = evt.data && typeof evt.data === "object" ? evt.data : {};

    if (evt.event === "agent_surface") {
      const subscriberId = asTrimmed(data.subscriber || evt.publisher);
      const surface = data.surface && typeof data.surface === "object" ? data.surface : null;
      if (!subscriberId || !surface || !surface.type) return;
      const ownedGroups = memberToGroups.get(subscriberId);
      if (!ownedGroups || ownedGroups.size === 0) return;

      for (const groupId of ownedGroups) {
        const groupInfo = groupsById.get(groupId);
        if (!groupInfo) continue;
        const state = ensureRoundState(groupInfo);
        if (seq > state.lastSeq) state.lastSeq = seq;

        if (surface.type === "task_started") {
          const pub = asTrimmed(surface.publisher);
          const isControllerOrigin = pub === "ufoo-agent"
            || Boolean(asTrimmed(surface.parentTaskRunId))
            || surface.requestKind === "worker-task";
          beginOrContinueRound(state, {
            origin: isControllerOrigin ? "controller" : "user",
            parentTaskRunId: asTrimmed(surface.parentTaskRunId),
            parentSessionId: asTrimmed(surface.parentSessionId),
          });
          const rec = ensureMemberRecord(state, subscriberId, groupInfo);
          rec.status = "running";
          rec.deltaBuf = "";
          rec.lastError = "";
          rec.updatedAt = ts;
        } else if (surface.type === "text_delta") {
          if (!state.active) beginOrContinueRound(state);
          const rec = ensureMemberRecord(state, subscriberId, groupInfo);
          if (rec.status !== "running") rec.status = "running";
          const delta = String(surface.delta || "");
          if (delta && rec.deltaBuf.length < MAX_DELTA_BUFFER_CHARS) {
            rec.deltaBuf += delta.slice(0, MAX_DELTA_BUFFER_CHARS - rec.deltaBuf.length);
          }
          rec.updatedAt = ts;
          state.lastActivityAt = Date.now();
        } else if (surface.type === "task_completed" || surface.type === "task_paused") {
          if (!state.active) beginOrContinueRound(state);
          const rec = ensureMemberRecord(state, subscriberId, groupInfo);
          const reply = asTrimmed(surface.finalText || "") || asTrimmed(rec.deltaBuf);
          rec.status = surface.type === "task_paused" ? "waiting_user" : "completed";
          if (reply) rec.lastReply = reply;
          rec.deltaBuf = "";
          rec.turnsInRound += 1;
          rec.updatedAt = ts;
          state.lastActivityAt = Date.now();
        } else if (surface.type === "task_failed" || surface.type === "task_cancelled") {
          if (!state.active) beginOrContinueRound(state);
          const rec = ensureMemberRecord(state, subscriberId, groupInfo);
          const partial = asTrimmed(rec.deltaBuf);
          if (partial) rec.lastReply = partial;
          rec.deltaBuf = "";
          rec.status = surface.type === "task_cancelled" ? "cancelled" : "failed";
          rec.lastError = asTrimmed(surface.error || (surface.type === "task_cancelled" ? "cancelled" : "task failed"));
          rec.turnsInRound += 1;
          rec.updatedAt = ts;
          state.lastActivityAt = Date.now();
        }
      }
      return;
    }

    if (evt.event === "message") {
      const msg = typeof data.message === "string" ? data.message : "";
      if (!msg.trim() || isStreamEnvelope(msg)) return;
      const publisher = asTrimmed(evt.publisher);
      const target = asTrimmed(evt.target);

      // If an external (non-surface) group member posts a message, capture it as their round output
      const pubGroups = memberToGroups.get(publisher);
      if (pubGroups && pubGroups.size > 0) {
        for (const groupId of pubGroups) {
          const groupInfo = groupsById.get(groupId);
          if (!groupInfo) continue;
          const state = ensureRoundState(groupInfo);
          if (seq > state.lastSeq) state.lastSeq = seq;
          if (!state.active) beginOrContinueRound(state);
          const rec = ensureMemberRecord(state, publisher, groupInfo);
          // Only overwrite reply if not currently streaming via internalRunner surface
          if (rec.status !== "running") {
            rec.lastReply = msg.trim();
            if (rec.turnsInRound === 0) {
              rec.turnsInRound = 1;
              rec.status = "completed";
            }
          }
          rec.updatedAt = ts;
          state.lastActivityAt = Date.now();
        }
      }

      // If a message targets a group member, reset settle timer so we wait for that handoff to run
      const targetGroups = memberToGroups.get(target);
      if (targetGroups && targetGroups.size > 0) {
        for (const groupId of targetGroups) {
          const groupInfo = groupsById.get(groupId);
          if (!groupInfo) continue;
          const state = ensureRoundState(groupInfo);
          clearSettleTimer(state);
          if (publisher === "ufoo-agent" && state.active) {
            state.origin = "controller";
          }
          if (seq > state.lastSeq) state.lastSeq = seq;
          state.lastActivityAt = Date.now();
        }
      }
    }
  }

  function hasPendingQueueMessages(groupInfo) {
    for (const member of groupInfo.members) {
      try {
        const pending = DeliveryQueue.forSubscriber(paths.busDir, member.subscriberId).readPending();
        if (Array.isArray(pending) && pending.length > 0) return true;
      } catch {
        // ignore unreadable queue
      }
    }
    return false;
  }

  function isGroupQuiescent(state, groupInfo, agents) {
    if (!state || !state.active) return false;
    let totalTurns = 0;
    for (const rec of state.members.values()) {
      if (rec.status === "running" || rec.status === "waiting_user") return false;
      totalTurns += rec.turnsInRound;
    }
    if (totalTurns <= 0) return false;

    for (const member of groupInfo.members) {
      const meta = agents[member.subscriberId];
      const act = asTrimmed(meta?.activity_state).toLowerCase();
      if (BUSY_STATES.has(act) || PAUSED_STATES.has(act)) return false;
    }

    if (hasPendingQueueMessages(groupInfo)) return false;
    return true;
  }

  function finalizeRound(groupId) {
    if (stopped) return;
    // Re-ingest latest events before concluding quiescence
    const snapshot = loadActiveGroupsAndAgents(projectRoot);
    const freshEvents = readIncrementalBusEvents();
    for (const evt of freshEvents) applyEvent(evt, snapshot);

    const state = roundStates.get(groupId);
    const groupInfo = snapshot.groupsById.get(groupId);
    if (!state || !groupInfo) {
      if (state) {
        clearSettleTimer(state);
        state.active = false;
      }
      return;
    }

    clearSettleTimer(state);
    if (!isGroupQuiescent(state, groupInfo, snapshot.agents)) return;

    state.active = false;
    if (!checkEnabled()) return;

    const members = groupInfo.members.map((member) => {
      const rec = state.members.get(member.subscriberId);
      const participated = Boolean(rec && rec.turnsInRound > 0);
      return {
        subscriberId: member.subscriberId,
        nickname: member.nickname,
        role: member.role,
        participated,
        turnsInRound: rec ? rec.turnsInRound : 0,
        status: participated ? rec.status : "idle",
        lastReply: participated ? clipMemberOutput(rec.lastReply, maxMemberOutputChars) : "",
        lastError: participated ? redactSecrets(rec.lastError || "") : "",
        updatedAt: rec?.updatedAt || "",
      };
    });

    const changedFiles = groupInfo.worktreePath ? readWorktreeStatusSummary(groupInfo.worktreePath) : [];
    const roundKey = createHash("sha256")
      .update(`${groupId}:${state.roundId}:${state.lastSeq}`)
      .digest("hex")
      .slice(0, 24);

    const rollup = {
      requestId: `group-round-${roundKey}`,
      groupId,
      groupLabel: groupInfo.label,
      kind: groupInfo.kind,
      roundId: state.roundId,
      origin: state.origin,
      parentTaskRunId: state.parentTaskRunId || "",
      parentSessionId: state.parentSessionId || "main-default",
      startedAt: state.startedAt,
      settledAt: nowIso(),
      worktreePath: groupInfo.worktreePath,
      changedFiles,
      members,
    };
    rollup.prompt = buildGroupRollupPrompt(rollup);

    Promise.resolve(onGroupSettled(rollup)).catch((err) => {
      log(`group round rollup dispatch failed (${groupId}): ${err?.message || String(err)}`);
    });
  }

  function evaluateAllGroups(snapshot) {
    for (const [groupId, state] of roundStates.entries()) {
      const groupInfo = snapshot.groupsById.get(groupId);
      if (!groupInfo) {
        clearSettleTimer(state);
        state.active = false;
        continue;
      }
      if (!state.active) continue;
      if (isGroupQuiescent(state, groupInfo, snapshot.agents)) {
        if (!state.settleTimer) {
          state.settleTimer = setTimeout(() => {
            state.settleTimer = null;
            finalizeRound(groupId);
          }, Math.max(10, settleDebounceMs));
          state.settleTimer.unref?.();
        }
      } else {
        clearSettleTimer(state);
      }
    }
  }

  function tick() {
    if (stopped) return;
    if (!initialized) {
      initialized = true;
      if (!startFromBeginning) {
        primeCursorsToEnd();
        return;
      }
    }
    const snapshot = loadActiveGroupsAndAgents(projectRoot);
    const events = readIncrementalBusEvents();
    if (events.length === 0 && !hasActiveRounds()) return;
    for (const evt of events) applyEvent(evt, snapshot);
    evaluateAllGroups(snapshot);
  }

  function hasActiveRounds() {
    for (const state of roundStates.values()) {
      if (state.active || state.settleTimer) return true;
    }
    return false;
  }

  function isMemberInBusyGroup(subscriberId) {
    const id = asTrimmed(subscriberId);
    if (!id) return false;
    const snapshot = loadActiveGroupsAndAgents(projectRoot);
    const owned = snapshot.memberToGroups.get(id);
    if (!owned || owned.size === 0) return false;
    for (const groupId of owned) {
      const groupInfo = snapshot.groupsById.get(groupId);
      if (!groupInfo || groupInfo.members.length < 2) continue;
      for (const m of groupInfo.members) {
        if (m.subscriberId === id) continue;
        const act = asTrimmed(snapshot.agents[m.subscriberId]?.activity_state).toLowerCase();
        if (BUSY_STATES.has(act)) return true;
        try {
          if (DeliveryQueue.forSubscriber(paths.busDir, m.subscriberId).readPending().length > 0) return true;
        } catch {}
      }
    }
    return false;
  }

  function start() {
    if (stopped) return;
    if (!initialized) {
      initialized = true;
      if (!startFromBeginning) primeCursorsToEnd();
    }
    if (!pollTimer && pollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        try { tick(); } catch (err) { log(`group round coordinator tick error: ${err?.message || String(err)}`); }
      }, pollIntervalMs);
      pollTimer.unref?.();
    }
  }

  function stop() {
    stopped = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    for (const state of roundStates.values()) {
      clearSettleTimer(state);
    }
    roundStates.clear();
  }

  return Object.freeze({
    start,
    stop,
    tick,
    notify: tick,
    hasActiveRounds,
    isMemberInBusyGroup,
  });
}

module.exports = {
  createGroupRoundCoordinator,
  buildGroupRollupPrompt,
};
