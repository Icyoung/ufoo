"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../coordination/bus/utils");
const { withFileLock } = require("../coordination/state/fileLock");

function emptyPrefs() {
  return {
    pinned: [],
    labels: [],
    archivedMeta: [],
  };
}

function normalizePrefs(raw) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    pinned: Array.isArray(base.pinned) ? base.pinned.filter((x) => x && x.root && x.id) : [],
    labels: Array.isArray(base.labels) ? base.labels.filter((x) => x && x.root && x.id && x.label) : [],
    archivedMeta: Array.isArray(base.archivedMeta) ? base.archivedMeta.filter((x) => x && x.root && x.id) : [],
  };
}

function createDesktopSessionPrefs(controllerRoot) {
  const file = path.join(controllerRoot, ".ufoo", "ui", "desktop-session-prefs.json");

  function read() {
    try {
      return normalizePrefs(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return emptyPrefs();
    }
  }

  function mutate(fn) {
    let result;
    withFileLock(file, () => {
      const state = read();
      const changed = fn(state);
      result = state;
      if (changed === false) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    });
    return result;
  }

  function setPinned(root, id, pinned) {
    const cleanRoot = String(root || "").trim();
    const cleanId = String(id || "").trim();
    if (!cleanRoot || !cleanId) return;
    mutate((state) => {
      const idx = state.pinned.findIndex((item) => item.root === cleanRoot && item.id === cleanId);
      if (pinned) {
        if (idx >= 0) return false;
        state.pinned.push({ root: cleanRoot, id: cleanId, pinnedAt: new Date().toISOString() });
        return true;
      }
      if (idx < 0) return false;
      state.pinned.splice(idx, 1);
      return true;
    });
  }

  function setLabel(root, id, label) {
    const cleanRoot = String(root || "").trim();
    const cleanId = String(id || "").trim();
    const cleanLabel = String(label || "").trim().slice(0, 80);
    if (!cleanRoot || !cleanId) return;
    mutate((state) => {
      const idx = state.labels.findIndex((item) => item.root === cleanRoot && item.id === cleanId);
      if (!cleanLabel) {
        if (idx < 0) return false;
        state.labels.splice(idx, 1);
        return true;
      }
      if (idx >= 0) {
        if (state.labels[idx].label === cleanLabel) return false;
        state.labels[idx].label = cleanLabel;
      } else {
        state.labels.push({ root: cleanRoot, id: cleanId, label: cleanLabel });
      }
      const archIdx = state.archivedMeta.findIndex((item) => item.root === cleanRoot && item.id === cleanId);
      if (archIdx >= 0) {
        state.archivedMeta[archIdx].label = cleanLabel;
      }
      return true;
    });
  }

  function setArchivedMeta(root, id, meta = {}) {
    const cleanRoot = String(root || "").trim();
    const cleanId = String(id || "").trim();
    if (!cleanRoot || !cleanId) return;
    mutate((state) => {
      const idx = state.archivedMeta.findIndex((item) => item.root === cleanRoot && item.id === cleanId);
      const existing = idx >= 0 ? state.archivedMeta[idx] : {};
      const entry = {
        root: cleanRoot,
        id: cleanId,
        label: String(meta.label || existing.label || cleanId).trim(),
        type: String(meta.type || existing.type || cleanId.split(":")[0] || "worker").trim(),
        archivedAt: String(meta.archivedAt || existing.archivedAt || new Date().toISOString()),
        worktreeBranch: String(meta.worktreeBranch ?? existing.worktreeBranch ?? ""),
        internal: meta.internal !== undefined ? Boolean(meta.internal) : Boolean(existing.internal),
      };
      if (idx >= 0) state.archivedMeta[idx] = entry;
      else state.archivedMeta.push(entry);
      return true;
    });
  }

  function clearArchivedMeta(root, id) {
    const cleanRoot = String(root || "").trim();
    const cleanId = String(id || "").trim();
    if (!cleanRoot || !cleanId) return;
    mutate((state) => {
      const idx = state.archivedMeta.findIndex((item) => item.root === cleanRoot && item.id === cleanId);
      if (idx < 0) return false;
      state.archivedMeta.splice(idx, 1);
      return true;
    });
  }

  function purgeSession(root, id) {
    const cleanRoot = String(root || "").trim();
    const cleanId = String(id || "").trim();
    if (!cleanRoot || !cleanId) return;
    mutate((state) => {
      const before = state.pinned.length + state.labels.length + state.archivedMeta.length;
      state.pinned = state.pinned.filter((item) => !(item.root === cleanRoot && item.id === cleanId));
      state.labels = state.labels.filter((item) => !(item.root === cleanRoot && item.id === cleanId));
      state.archivedMeta = state.archivedMeta.filter((item) => !(item.root === cleanRoot && item.id === cleanId));
      const after = state.pinned.length + state.labels.length + state.archivedMeta.length;
      return before !== after;
    });
  }

  function rekeySession(root, oldId, newId) {
    const cleanRoot = String(root || "").trim();
    const fromId = String(oldId || "").trim();
    const toId = String(newId || "").trim();
    if (!cleanRoot || !fromId || !toId || fromId === toId) return;
    mutate((state) => {
      let changed = false;
      for (const item of state.pinned) {
        if (item.root === cleanRoot && item.id === fromId) {
          item.id = toId;
          changed = true;
        }
      }
      for (const item of state.labels) {
        if (item.root === cleanRoot && item.id === fromId) {
          item.id = toId;
          changed = true;
        }
      }
      for (const item of state.archivedMeta) {
        if (item.root === cleanRoot && item.id === fromId) {
          item.id = toId;
          changed = true;
        }
      }
      return changed;
    });
  }

  return {
    read,
    setPinned,
    setLabel,
    setArchivedMeta,
    clearArchivedMeta,
    purgeSession,
    rekeySession,
  };
}

module.exports = { createDesktopSessionPrefs };
