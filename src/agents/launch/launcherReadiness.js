"use strict";

const fs = require("fs");
const { readJSON } = require("../../coordination/bus/utils");
const { getUfooPaths } = require("../../coordination/state/paths");
const { updateAgentsData } = require("../../coordination/state/agentsStore");

function setLauncherReady(projectRoot, subscriber, ready) {
  if (!subscriber) return false;
  try {
    const file = getUfooPaths(projectRoot).agentsFile;
    if (!fs.existsSync(file)) return false;
    return updateAgentsData(file, (data) => {
      const meta = data.agents && data.agents[subscriber];
      if (!meta || meta.status === "inactive") return false;
      meta.launcher_ready = ready;
      return true;
    });
  } catch {
    return false;
  }
}

function isLauncherReady(projectRoot, subscriber) {
  if (!subscriber) return false;
  try {
    const data = readJSON(getUfooPaths(projectRoot).agentsFile, null);
    const meta = data && data.agents && data.agents[subscriber];
    return Boolean(meta && meta.status !== "inactive" && meta.launcher_ready === true);
  } catch {
    return false;
  }
}

module.exports = { setLauncherReady, isLauncherReady };
