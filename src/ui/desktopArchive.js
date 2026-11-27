"use strict";

const fs = require("fs");
const path = require("path");
const { writeFileAtomic } = require("../coordination/bus/utils");
const { withFileLock } = require("../coordination/state/fileLock");

function createDesktopArchive(controllerRoot) {
  const file = path.join(controllerRoot, ".ufoo", "ui", "desktop-archive.json");

  function read() {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { projects: [], sessions: [] };
    }
  }

  function update(entry, archived) {
    withFileLock(file, () => {
      const state = read();
      const key = entry.id ? "sessions" : "projects";
      const items = state[key];
      const index = items.findIndex((item) => item.root === entry.root && item.id === entry.id);
      if (archived === (index >= 0)) return;
      if (archived) items.push(entry);
      else items.splice(index, 1);
      writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    });
  }

  return {
    read,
    archiveProject: (root) => update({ root }, true),
    restoreProject: (root) => update({ root }, false),
    archiveSession: (root, id) => update({ root, id }, true),
    restoreSession: (root, id) => update({ root, id }, false),
    purgeSession: (root, id) => update({ root, id }, false),
  };
}

module.exports = { createDesktopArchive };
