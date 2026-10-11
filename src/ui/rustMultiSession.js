"use strict";

/**
 * In-process split-pane session for the Rust TUI host.
 *
 * Both kinds use Tab to cycle focus and Esc / Ctrl+C to return focus to chat,
 * then close the split. Only Ctrl+C exits the application at the root.
 * Window modes are main, side and multi, including when no children exist.
 * They share draw and the multi.* pane wire:
 * - "multi"  — all internal agents
 * - "side"   — internal-only activate; single locked agent on the right
 *              (shares its pane renderer with multi)
 *
 * The Rust TUI owns TTY / layout / focus. Node owns internal pane buffers
 * and ships bounded, lossy `multi.pane.frame` events.
 */

const crypto = require("crypto");
const fs = require("fs");
const { getUfooPaths } = require("../coordination/state/paths");
const { isInternalAgentMeta } = require("../runtime/contracts/agentMode");
const { createPaneManager } = require("../app/chat/multiWindow/paneManager");
const { createAgentSurface } = require("./agentSurface");
const { readAgentSurfaceEvents, createAgentSurfaceReader } = require("../coordination/history/agentSurface");

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
    resolvePaneOptions = () => ({ mode: "internal" }),
    onInternalSubmit = () => {},
    publish = () => {},
    publishLossy = null,
    getLabel = (id) => id,
    projectRoot = "",
    getProjectRoot = () => projectRoot,
  } = options;

  let sessionId = null;
  let active = false;
  let kind = KIND_MULTI;
  let lockedAgentIds = [];
  let rev = 0;
  let viewportRev = 0;
  let focus = { target: "chat", agent_id: "" };
  let lastActiveAgentId = "";
  const paneSizes = new Map();
  const paneMeta = new Map();
  const dirty = new Set();
  let flushTimer = null;
  let paneManager = null;
  /** @type {Map<string, number>} last successful frame emit per agent */
  const lastEmitAt = new Map();
  const internalDrafts = new Map();
  const surfaces = new Map();
  const replayedAgents = new Set();
  let observationRoot = "";
  let surfaceReader = null;
  let surfaceWatch = null;
  let surfacePoll = null;
  let surfaceRefresh = null;

  function closeSurfaceObservation() {
    surfaceWatch?.close();
    surfaceWatch = null;
    clearInterval(surfacePoll);
    surfacePoll = null;
    clearTimeout(surfaceRefresh);
    surfaceRefresh = null;
  }

  function refreshSurfaceObservations() {
    if (!active) return;
    const root = getProjectRoot();
    if (!root) return;
    if (root !== observationRoot) {
      closeSurfaceObservation();
      observationRoot = root;
      surfaceReader = createAgentSurfaceReader(root);
    }
    for (const event of surfaceReader.read(listInternalAgentIds())) {
      acceptEvent(event.publisher, event.data.surface, event.seq);
    }
    if (!surfaceWatch) {
      try {
        const watch = fs.watch(getUfooPaths(root).busEventsDir, () => {
          if (surfaceRefresh) return;
          surfaceRefresh = setTimeout(() => {
            surfaceRefresh = null;
            refreshSurfaceObservations();
          }, 25);
          surfaceRefresh.unref?.();
        });
        surfaceWatch = watch;
        watch.unref?.();
        watch.on("error", () => {
          watch.close();
          if (surfaceWatch === watch) surfaceWatch = null;
        });
      } catch { /* Retry from the poll after the first provider event. */ }
    }
    if (!surfacePoll) {
      surfacePoll = setInterval(refreshSurfaceObservations, 500);
      surfacePoll.unref?.();
    }
  }

  function surfaceFor(agentId) {
    if (!isInternalAgentMeta(getAgentMeta(agentId))) return null;
    if (!surfaces.has(agentId)) {
      const surface = createAgentSurface();
      const opts = ensurePaneMeta(agentId);
      if (Array.isArray(opts.initialEntries)) {
        surface.apply("transcript.reset", { entries: opts.initialEntries });
      } else {
        const initial = (opts.initialLines || []).join("\n");
        if (initial) surface.apply("transcript.append", { kind: "meta", text: initial });
      }
      surfaces.set(agentId, { surface, seq: 0, structured: false });
    }
    return surfaces.get(agentId);
  }

  function syncActivity(agentId) {
    const view = surfaceFor(agentId);
    if (!view || view.structured) return;
    const meta = getAgentMeta(agentId) || {};
    const key = JSON.stringify([meta.activity_state, meta.activity_detail, meta.activity_since]);
    if (view.activityKey === key) return;
    view.activityKey = key;
    if (meta.activity_state) acceptEvent(agentId, { type: "activity", state: meta.activity_state,
      detail: meta.activity_detail || "", ts: meta.activity_since, started_at: Date.parse(meta.activity_since) || 0,
      authoritative: true });
  }

  function acceptEvent(agentId, event, seq = 0) {
    const view = surfaceFor(agentId);
    if (!view || (seq > 0 && seq <= view.seq)) return false;
    if (event.type === "submission_failed") {
      const pane = paneManager?.getPane(agentId);
      if (pane && !pane.internalInput) {
        pane.internalInput = String(event.message || "");
        pane.internalCursor = pane.internalInput.length;
      } else if (!pane && !internalDrafts.get(agentId)?.initialInput) {
        internalDrafts.set(agentId, { initialInput: String(event.message || ""), initialCursor: String(event.message || "").length });
      }
    }
    if (seq > 0) { view.seq = seq; view.structured = true; }
    if (event.type === "activity") event = { ...event, authoritative: !view.structured };
    const changed = view.surface.accept(event);
    if (changed) markDirty(agentId);
    return changed;
  }

  function replaySurfaces() {
    const ids = listInternalAgentIds().filter((id) => !replayedAgents.has(id));
    const root = getProjectRoot();
    if (!root || !ids.length) return;
    const events = readAgentSurfaceEvents(root, ids);
    for (const id of new Set(events.map((event) => event.publisher))) {
      const view = surfaceFor(id);
      if (view && !view.structured) view.surface.apply("transcript.reset", { entries: [] });
    }
    for (const event of events) {
      acceptEvent(event.publisher, event.data.surface, event.seq);
    }
    for (const id of ids) replayedAgents.add(id);
  }

  function rememberDraft(agentId) {
    const pane = paneManager && paneManager.getPane(agentId);
    if (pane && pane.mode === "internal") {
      internalDrafts.set(agentId, { initialInput: pane.internalInput, initialCursor: pane.internalCursor,
        inputRevision: pane.inputRevision, scrollOffset: pane.scrollOffset });
    }
  }

  function paneAgentIds() {
    const ids = listInternalAgentIds();
    if (kind === KIND_SIDE) {
      const selected = lockedAgentIds.find((id) => ids.includes(id)) || preferredAgentId(ids);
      lockedAgentIds = selected ? [selected] : [];
      return lockedAgentIds;
    }
    return ids;
  }

  function preferredAgentId(ids = listInternalAgentIds()) {
    return ids.includes(lastActiveAgentId) ? lastActiveAgentId : ids[0] || "";
  }

  function getMode() {
    return active ? kind : "main";
  }

  function currentPanesDesc() {
    return paneAgentIds().map((id) => {
      return {
        agent_id: id,
        label: String(getLabel(id) || id),
        mode: "internal",
      };
    });
  }

  function ensurePaneMeta(id) {
    if (paneMeta.has(id)) return paneMeta.get(id);
    let opts = { mode: "internal" };
    try {
      opts = resolvePaneOptions(id) || opts;
    } catch {
      // ignore
    }
    if (!opts.mode) opts = { ...opts, mode: "internal" };
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
        // re-emitting once the gap elapses (transcript snapshot is always current).
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
    const view = pane.surface.snapshot();
    const meta = (() => {
      try { return getAgentMeta(agentId) || {}; } catch { return {}; }
    })();
    const payload = {
      session_id: sessionId,
      agent_id: agentId,
      label: String(getLabel(agentId) || agentId),
      mode: "internal",
      entries: view.entries,
      status: view.status || String(meta.activity_state || "ready"),
      busy: view.busy,
      usage: view.usage,
      plan: view.plan,
      revision: view.revision,
      started_at: view.started_at,
      activity_detail: String(meta.activity_detail || ""),
      viewport_rev: viewportRev,
      scroll_offset: pane.scrollOffset,
    };
    payload.input = String(pane.internalInput || "");
    payload.cursor = Number.isFinite(pane.internalCursor) ? pane.internalCursor : 0;
    payload.input_revision = pane.inputRevision || 0;
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
      onPaneOutput: (agentId) => markDirty(agentId),
      onInternalSubmit: (agentId, message) => {
        markDirty(agentId);
        return onInternalSubmit(agentId, message);
      },
    });
    return paneManager;
  }

  function publishFrames() {
    if (!active || !paneManager) return;
    for (const id of paneManager.getAgentIds()) publishFrame(id);
  }

  function syncAgents() {
    const live = new Set(listInternalAgentIds());
    for (const id of surfaces.keys()) if (!live.has(id)) {
      surfaces.delete(id); replayedAgents.delete(id); internalDrafts.delete(id);
    }
    replaySurfaces();
    // Observe durable provider output independently of daemon inbox delivery.
    // This also covers daemons already running when the package was upgraded.
    refreshSurfaceObservations();
    for (const id of live) syncActivity(id);
    if (!paneManager) return;
    const ids = paneAgentIds();
    const existing = new Set(paneManager.getAgentIds());
    let changed = false;
    for (const id of ids) {
      const opts = ensurePaneMeta(id);
      const size = paneSizes.get(id) || { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
      if (!existing.has(id)) {
        paneManager.addAgent(id, size.cols, size.rows, { ...opts, surface: surfaceFor(id).surface, ...internalDrafts.get(id) });
        paneManager.sendResize(id, size.cols, size.rows, size.inputCols || size.cols);
        markDirty(id);
        changed = true;
      } else {
        markDirty(id);
      }
    }
    for (const id of existing) {
      if (!ids.includes(id)) {
        rememberDraft(id);
        paneManager.removeAgent(id);
        paneSizes.delete(id);
        paneMeta.delete(id);
        dirty.delete(id);
        changed = true;
      }
    }
    // Only republish window.set when membership actually changes. Spamming
    // window.set on every daemon status tick forced Rust to bump viewport_rev
    // and drop in-flight pane frames (focus switching felt stuck).
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
    publish("window.set", {
      session_id: sessionId,
      active,
      mode: getMode(),
      rev,
      panes,
      focus,
      viewport_rev: viewportRev,
    });
  }

  /**
   * @param {object} [options]
   * @param {"multi"|"side"} [options.kind]
   * @param {string[]} [options.agentIds] — optional selected child for kind "side"
   * @param {{ target?: string, agent_id?: string }} [options.focus]
   */
  function start(options = {}) {
    const nextKind = options.kind === KIND_SIDE ? KIND_SIDE : KIND_MULTI;
    if (active && kind === nextKind && nextKind === KIND_MULTI) {
      return { ok: true, session_id: sessionId, mode: getMode() };
    }
    let ids;
    if (nextKind === KIND_SIDE) {
      const raw = Array.isArray(options.agentIds) ? options.agentIds : [];
      const id = String(raw[0] || "").trim() || preferredAgentId();
      if (id && !listInternalAgentIds().includes(id)) return { ok: false, error: "Dashboard supports active internal agents only" };
      ids = id ? [id] : [];
    } else {
      ids = normalizeAgentList(getActiveAgents).filter((id) => isInternalAgentMeta(getAgentMeta(id)));
    }

    const previousFocus = active ? { ...focus } : null;
    if (active) stop();
    lockedAgentIds = nextKind === KIND_SIDE ? ids.slice() : [];

    kind = nextKind;
    sessionId = generateSessionId(kind);
    active = true;
    rev = 1;
    viewportRev = 0;
    const focusOpt = options.focus && typeof options.focus === "object" ? options.focus
      : nextKind === KIND_MULTI ? previousFocus : null;
    if (focusOpt && focusOpt.target === "agent" && ids.includes(String(focusOpt.agent_id || "").trim())) {
      focus = {
        target: "agent",
        agent_id: String(focusOpt.agent_id).trim(),
      };
    } else if (!focusOpt && nextKind === KIND_SIDE && ids.length) {
      focus = { target: "agent", agent_id: ids[0] };
    } else {
      focus = { target: "chat", agent_id: "" };
    }
    if (focus.target === "agent") lastActiveAgentId = focus.agent_id;
    paneSizes.clear();
    paneMeta.clear();
    dirty.clear();
    lastEmitAt.clear();
    ensurePaneManager();
    syncAgents();
    publishSet();
    publishFrames();
    return { ok: true, session_id: sessionId, mode: getMode() };
  }

  function stop({ clearDrafts = false } = {}) {
    closeSurfaceObservation();
    if (clearDrafts) {
      lastActiveAgentId = "";
      internalDrafts.clear(); surfaces.clear(); replayedAgents.clear();
      surfaceReader = null; observationRoot = "";
    }
    if (!active && !paneManager) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    dirty.clear();
    if (paneManager) {
      if (!clearDrafts) for (const id of paneManager.getAgentIds()) rememberDraft(id);
      try { paneManager.disconnectAll(); } catch {}
      paneManager = null;
    }
    paneSizes.clear();
    paneMeta.clear();
    lastEmitAt.clear();
    active = false;
    publish("window.set", {
      session_id: sessionId,
      active: false,
      mode: "main",
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

  function setLayout(layout = "cycle", agentId = "") {
    const mode = layout === "cycle"
      ? getMode() === "main" ? "side" : getMode() === "side" ? "multi" : "main"
      : layout;
    if (mode === "main") {
      stop();
      return { ok: true, mode: "main" };
    }
    if (mode === "multi") return start({ kind: KIND_MULTI });
    if (mode === "side") return start({ kind: KIND_SIDE, agentIds: [agentId], focus: { ...focus } });
    return { ok: false, error: "unknown layout" };
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
      const inputCols = Math.max(1, Math.floor(Number(spec.input_cols) || cols));
      paneSizes.set(id, { cols, rows, inputCols });
      if (paneManager.getPane(id)) {
        try { paneManager.sendResize(id, cols, rows, inputCols); } catch {}
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
    const pane = paneManager.getPane(agentId);
    if (!pane || !listInternalAgentIds().includes(agentId)) return { ok: false, error: "Unknown internal agent" };
    if (typeof payload.input === "string") {
      const revision = Number(payload.input_revision);
      if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, error: "invalid input_revision" };
      if (revision <= (pane.inputRevision || 0)) return { ok: true, stale: true };
      pane.inputRevision = revision;
      pane.internalInput = payload.input;
      pane.internalCursor = Math.max(0, Math.min(payload.input.length, Math.trunc(Number(payload.cursor) || 0)));
      if (payload.submit === true) paneManager.sendInputToAgent(agentId, "\r");
      markDirty(agentId);
      return { ok: true, agent_id: agentId, input_revision: revision };
    }
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

  function handleScroll(payload = {}) {
    if (!active || !paneManager) return { ok: false, error: "multi not active" };
    if (payload.session_id && payload.session_id !== sessionId) return { ok: false, error: "stale session_id" };
    const agentId = String(payload.agent_id || "").trim();
    const lines = Math.max(-2000, Math.min(2000, Math.trunc(Number(payload.lines) || 0)));
    const maxOffset = Number.isFinite(Number(payload.max_offset)) ? Math.max(0, Number(payload.max_offset)) : 2000;
    const pane = paneManager.getPane(agentId);
    if (!pane) return { ok: false, error: "agent pane not found" };
    if (Number.isFinite(Number(payload.offset))) {
      pane.scrollOffset = Math.max(0, Math.min(maxOffset, Math.trunc(Number(payload.offset))));
      markDirty(agentId);
    } else paneManager.scrollPane(agentId, lines, maxOffset);
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
      lastActiveAgentId = agentId;
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
    if (!active) return { active: false, mode: "main" };
    return {
      active: true,
      mode: getMode(),
      session_id: sessionId,
      rev,
      viewport_rev: viewportRev,
      focus,
      panes: currentPanesDesc(),
    };
  }

  function listInternalAgentIds() {
    return normalizeAgentList(getActiveAgents).filter((id) => isInternalAgentMeta(getAgentMeta(id)));
  }

  function handleExpand(payload = {}) {
    if (!active || payload.session_id !== sessionId) return { ok: false, error: "stale session_id" };
    const view = surfaces.get(payload.agent_id);
    if (!view || !paneManager?.getPane(payload.agent_id)) return { ok: false, error: "agent pane not found" };
    view.surface.toggleExpanded();
    markDirty(payload.agent_id);
    return { ok: true };
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
    setLayout,
    getMode,
    stop,
    isActive,
    getSessionId,
    getKind,
    isMultiKind,
    isSideKind,
    getSnapshot,
    handleViewport,
    handleRaw,
    handleScroll,
    handleFocus,
    focusAgent,
    handleExit,
    syncAgents,
    markDirty,
    writeToPane,
    listInternalAgentIds,
    acceptEvent,
    publishFrames,
    hasStructuredEvents: (id) => Boolean(surfaces.get(id)?.structured),
    handleExpand,
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
