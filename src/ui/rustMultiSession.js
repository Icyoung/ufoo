"use strict";

/**
 * In-process split-pane session for the Rust TUI host.
 *
 * Two kinds share the same draw/keys (Ctrl+W / Ctrl+Q) and multi.* wire:
 * - "multi"  — /multi; panes track all active agents
 * - "side"   — internal-only activate; single locked agent on the right
 *              (not a user-facing mode name; looks like multi with one agent)
 *
 * The Rust TUI owns TTY / layout / focus. Node owns paneManager (VT +
 * inject.sock) and ships bounded, lossy `multi.pane.frame` events.
 */

const crypto = require("crypto");
const { createPaneManager } = require("../app/chat/multiWindow/paneManager");
const { vtScreenToAnsiLines } = require("../app/chat/multiWindow/vtFrame");

const DEFAULT_COLS = 40;
const DEFAULT_ROWS = 12;
const FLUSH_MS = 60;
const MAX_FLUSH_MS = 140;
const MIN_EMIT_GAP_MS = 35;
const KIND_MULTI = "multi";
const KIND_SIDE = "side";

function generateSessionId(kind = KIND_MULTI) {
  const rand = crypto.randomBytes(4).toString("hex");
  const prefix = kind === KIND_SIDE ? "side" : "multi";
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

function normalizeAgentList(getActiveAgents) {
  try {
    const raw = typeof getActiveAgents === "function" ? getActiveAgents() : [];
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
      const id = String(item || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function createRustMultiSession(options = {}) {
  const {
    getActiveAgents = () => [],
    getAgentMeta = () => ({}),
    getInjectSockPath = () => "",
    resolvePaneOptions = () => ({ mode: "socket" }),
    onInternalSubmit = () => {},
    publish = () => {},
    publishLossy = null,
    getLabel = (id) => id,
  } = options;

  let sessionId = null;
  let active = false;
  let kind = KIND_MULTI;
  let lockedAgentIds = [];
  let rev = 0;
  let viewportRev = 0;
  let focus = { target: "chat", agent_id: "" };
  const paneSizes = new Map();
  const paneMeta = new Map();
  const dirty = new Set();
  let flushTimer = null;
  let paneManager = null;
  /** @type {Map<string, number>} last successful frame emit per agent */
  const lastEmitAt = new Map();

  function paneAgentIds() {
    if (kind === KIND_SIDE && lockedAgentIds.length > 0) {
      return lockedAgentIds.slice();
    }
    return normalizeAgentList(getActiveAgents);
  }

  function currentPanesDesc() {
    return paneAgentIds().map((id) => {
      const opts = paneMeta.get(id) || (() => {
        try { return resolvePaneOptions(id) || {}; } catch { return {}; }
      })();
      return {
        agent_id: id,
        label: String(getLabel(id) || id),
        mode: opts.mode === "internal" ? "internal" : "socket",
      };
    });
  }

  function ensurePaneMeta(id) {
    if (paneMeta.has(id)) return paneMeta.get(id);
    let opts = { mode: "socket" };
    try {
      opts = resolvePaneOptions(id) || opts;
    } catch {
      // ignore
    }
    if (!opts.mode) opts.mode = "socket";
    paneMeta.set(id, opts);
    return opts;
  }

  function scheduleFlush() {
    if (!active) return;
    if (flushTimer) return;
    // Under load (many dirty panes), back off flush interval so we emit
    // fewer full-screen snapshots while still latest-wins per pane.
    const load = dirty.size;
    const delay = load > 3
      ? Math.min(MAX_FLUSH_MS, FLUSH_MS + (load - 3) * 15)
      : FLUSH_MS;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushDirty();
    }, delay);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function flushDirty() {
    if (!active || !paneManager) return;
    const ids = [...dirty];
    dirty.clear();
    const now = Date.now();
    let deferred = false;
    for (const id of ids) {
      const last = lastEmitAt.get(id) || 0;
      if (now - last < MIN_EMIT_GAP_MS) {
        // Keep dirty; schedule another pass — drop intermediate by only
        // re-emitting once the gap elapses (VT snapshot is always current).
        dirty.add(id);
        deferred = true;
        continue;
      }
      publishFrame(id);
      lastEmitAt.set(id, now);
    }
    if (deferred) scheduleFlush();
  }

  function publishFrame(agentId) {
    if (!active || !paneManager) return;
    const pane = paneManager.getPane(agentId);
    if (!pane) return;
    const size = paneSizes.get(agentId) || { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
    const lines = vtScreenToAnsiLines(pane.vt, {
      maxCols: Math.max(1, size.cols),
      maxRows: Math.max(1, size.rows),
    });
    const opts = paneMeta.get(agentId) || {};
    const meta = (() => {
      try { return getAgentMeta(agentId) || {}; } catch { return {}; }
    })();
    const payload = {
      session_id: sessionId,
      agent_id: agentId,
      label: String(getLabel(agentId) || agentId),
      mode: opts.mode === "internal" ? "internal" : "socket",
      lines,
      status: String(meta.activity_state || meta.state || "ready"),
      viewport_rev: viewportRev,
    };
    if (opts.mode === "internal") {
      payload.input = String(pane.internalInput || "");
      payload.cursor = Number.isFinite(pane.internalCursor) ? pane.internalCursor : 0;
    }
    const emit = typeof publishLossy === "function" ? publishLossy : publish;
    try { emit("multi.pane.frame", payload); } catch {}
  }

  function markDirty(agentId) {
    if (!active) return;
    dirty.add(agentId);
    if (!paneManager || !paneManager.getPane(agentId)) return;
    scheduleFlush();
  }

  function ensurePaneManager() {
    if (paneManager) return paneManager;
    paneManager = createPaneManager({
      getInjectSockPath,
      onPaneOutput: (agentId) => markDirty(agentId),
      onInternalSubmit: (agentId, message) => {
        try { onInternalSubmit(agentId, message); } catch {}
        markDirty(agentId);
      },
    });
    return paneManager;
  }

  function syncAgents() {
    if (!paneManager) return;
    const ids = paneAgentIds();
    const existing = new Set(paneManager.getAgentIds());
    let changed = false;
    for (const id of ids) {
      const opts = ensurePaneMeta(id);
      const size = paneSizes.get(id) || { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
      if (!existing.has(id)) {
        paneManager.addAgent(id, size.cols, size.rows, opts);
        markDirty(id);
        changed = true;
      }
    }
    for (const id of existing) {
      if (!ids.includes(id)) {
        paneManager.removeAgent(id);
        paneSizes.delete(id);
        paneMeta.delete(id);
        dirty.delete(id);
        changed = true;
      }
    }
    // Only republish multi.set when membership actually changes. Spamming
    // multi.set on every daemon status tick forced Rust to bump viewport_rev
    // and drop in-flight pane frames (Ctrl+W felt stuck).
    if (active && changed) {
      rev += 1;
      publishSet();
    }
  }

  function publishSet() {
    const panes = currentPanesDesc();
    // Focus fallback: if focused agent no longer exists, drop to chat.
    if (focus.target === "agent") {
      const stillActive = panes.some((p) => p.agent_id === focus.agent_id);
      if (!stillActive) {
        focus = { target: "chat", agent_id: "" };
      }
    }
    publish("multi.set", {
      session_id: sessionId,
      active,
      kind,
      rev,
      panes,
      focus,
      viewport_rev: viewportRev,
    });
  }

  /**
   * @param {object} [options]
   * @param {"multi"|"side"} [options.kind]
   * @param {string[]} [options.agentIds] — required for kind "side" (exactly one)
   * @param {{ target?: string, agent_id?: string }} [options.focus]
   */
  function start(options = {}) {
    const nextKind = options.kind === KIND_SIDE ? KIND_SIDE : KIND_MULTI;
    if (active && kind === nextKind && nextKind === KIND_MULTI) {
      return { ok: true, session_id: sessionId, kind };
    }
    if (active) {
      stop();
    }

    let ids;
    if (nextKind === KIND_SIDE) {
      const raw = Array.isArray(options.agentIds) ? options.agentIds : [];
      const id = String(raw[0] || "").trim();
      if (!id) {
        return { ok: false, error: "side requires one agent_id" };
      }
      ids = [id];
      lockedAgentIds = [id];
    } else {
      lockedAgentIds = [];
      ids = normalizeAgentList(getActiveAgents);
      if (ids.length === 0) {
        return { ok: false, error: "No active agents for multi-window mode" };
      }
    }

    kind = nextKind;
    sessionId = generateSessionId(kind);
    active = true;
    rev = 1;
    viewportRev = 0;
    const focusOpt = options.focus && typeof options.focus === "object" ? options.focus : null;
    if (focusOpt && focusOpt.target === "agent" && String(focusOpt.agent_id || "").trim()) {
      focus = {
        target: "agent",
        agent_id: String(focusOpt.agent_id).trim(),
      };
    } else if (nextKind === KIND_SIDE) {
      focus = { target: "agent", agent_id: ids[0] };
    } else {
      focus = { target: "chat", agent_id: "" };
    }
    paneSizes.clear();
    paneMeta.clear();
    dirty.clear();
    lastEmitAt.clear();
    ensurePaneManager();
    syncAgents();
    publishSet();
    return { ok: true, session_id: sessionId, kind };
  }

  function stop() {
    if (!active && !paneManager) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    dirty.clear();
    if (paneManager) {
      try { paneManager.disconnectAll(); } catch {}
      paneManager = null;
    }
    paneSizes.clear();
    paneMeta.clear();
    lastEmitAt.clear();
    active = false;
    publish("multi.set", {
      session_id: sessionId,
      active: false,
      kind,
      rev: rev + 1,
      panes: [],
      focus: { target: "chat", agent_id: "" },
      viewport_rev: viewportRev,
    });
    sessionId = null;
    kind = KIND_MULTI;
    lockedAgentIds = [];
    rev = 0;
    viewportRev = 0;
    focus = { target: "chat", agent_id: "" };
  }

  function handleViewport(payload = {}) {
    if (!active || !paneManager) return { ok: false, error: "multi not active" };
    if (payload.session_id && payload.session_id !== sessionId) {
      return { ok: false, error: "stale session_id" };
    }
    const incomingRev = Number(payload.viewport_rev);
    if (Number.isFinite(incomingRev) && incomingRev > viewportRev) {
      viewportRev = Math.floor(incomingRev);
    } else {
      viewportRev += 1;
    }
    const panes = Array.isArray(payload.panes) ? payload.panes : [];
    for (const spec of panes) {
      const id = String(spec && spec.agent_id || "").trim();
      if (!id) continue;
      const cols = Math.max(1, Math.floor(Number(spec.cols) || DEFAULT_COLS));
      const rows = Math.max(1, Math.floor(Number(spec.rows) || DEFAULT_ROWS));
      paneSizes.set(id, { cols, rows });
      if (paneManager.getPane(id)) {
        try { paneManager.sendResize(id, cols, rows); } catch {}
        markDirty(id);
      }
    }
    return { ok: true, viewport_rev: viewportRev };
  }

  function handleRaw(payload = {}) {
    if (!active || !paneManager) return { ok: false, error: "multi not active" };
    if (payload.session_id && payload.session_id !== sessionId) {
      return { ok: false, error: "stale session_id" };
    }
    const agentId = String(payload.agent_id || "").trim();
    if (!agentId) return { ok: false, error: "missing agent_id" };
    let data = "";
    if (payload.data_encoding === "base64" && typeof payload.data === "string") {
      try { data = Buffer.from(payload.data, "base64").toString("utf8"); } catch { data = ""; }
    } else if (typeof payload.data === "string") {
      data = payload.data;
    }
    if (!data) return { ok: false, error: "empty data" };
    try { paneManager.sendInputToAgent(agentId, data); } catch {}
    return { ok: true };
  }

  function handleFocus(payload = {}) {
    if (!active || !paneManager) return { ok: false, error: "multi not active" };
    if (payload.session_id && payload.session_id !== sessionId) {
      return { ok: false, error: "stale session_id" };
    }
    const target = payload.target === "agent" ? "agent" : "chat";
    const agentId = String(payload.agent_id || "").trim();
    if (target === "agent" && agentId && paneManager.getPane(agentId)) {
      focus = { target, agent_id: agentId };
      try { paneManager.setFocused(agentId); } catch {}
    } else {
      focus = { target: "chat", agent_id: "" };
    }
    return { ok: true, focus };
  }

  /** Activate an agent pane inside the split (no fullscreen handoff). */
  function focusAgent(agentId) {
    if (!active || !paneManager) return { ok: false, error: "multi not active" };
    const id = String(agentId || "").trim();
    if (!id) return { ok: false, error: "missing agent_id" };
    if (!paneManager.getPane(id)) {
      try { syncAgents(); } catch {}
    }
    if (!paneManager.getPane(id)) {
      return { ok: false, error: "agent pane not found" };
    }
    const result = handleFocus({
      session_id: sessionId,
      target: "agent",
      agent_id: id,
    });
    if (result && result.ok) {
      publishSet();
    }
    return result;
  }

  function handleExit() {
    if (!active) return { ok: true };
    stop();
    return { ok: true };
  }

  function isActive() { return active; }
  function getSessionId() { return sessionId; }
  function getKind() { return active ? kind : ""; }
  function isMultiKind() { return active && kind === KIND_MULTI; }
  function isSideKind() { return active && kind === KIND_SIDE; }

  function getSnapshot() {
    if (!active) return { active: false, kind: "" };
    return {
      active: true,
      kind,
      session_id: sessionId,
      rev,
      viewport_rev: viewportRev,
      focus,
      panes: currentPanesDesc(),
    };
  }

  function listInternalAgentIds() {
    const out = [];
    for (const id of paneAgentIds()) {
      const opts = paneMeta.get(id) || ensurePaneMeta(id);
      if (opts && opts.mode === "internal") out.push(id);
    }
    return out;
  }

  function writeToPane(agentId, data) {
    if (!paneManager) return false;
    try {
      const ok = paneManager.writeToPane(agentId, data);
      if (ok) markDirty(agentId);
      return ok;
    } catch {
      return false;
    }
  }

  return {
    start,
    stop,
    isActive,
    getSessionId,
    getKind,
    isMultiKind,
    isSideKind,
    getSnapshot,
    handleViewport,
    handleRaw,
    handleFocus,
    focusAgent,
    handleExit,
    syncAgents,
    markDirty,
    writeToPane,
    listInternalAgentIds,
  };
}

module.exports = {
  createRustMultiSession,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  FLUSH_MS,
  MAX_FLUSH_MS,
  MIN_EMIT_GAP_MS,
  KIND_MULTI,
  KIND_SIDE,
};
