"use strict";

const fs = require("fs");

const {
  loadConfig,
  normalizeDaemonTopology,
} = require("../../config");
const { getUfooPaths } = require("../../coordination/state/paths");
const {
  normalizeProjectRoot,
  resolveGlobalControllerProjectRoot,
} = require("../projects");

function isSocketFile(filePath) {
  try {
    return fs.statSync(filePath).isSocket();
  } catch {
    return false;
  }
}

function resolveEffectiveDaemonTopology(projectRoot, options = {}) {
  const config = options.config || loadConfig(projectRoot);
  return normalizeDaemonTopology(
    options.topology
    || process.env.UFOO_DAEMON_TOPOLOGY
    || config.daemonTopology
  );
}

function resolveDaemonEndpoint(projectRoot, options = {}) {
  const canonicalRoot = normalizeProjectRoot(projectRoot);
  const controllerRoot = normalizeProjectRoot(
    options.controllerRoot || resolveGlobalControllerProjectRoot()
  );
  const topology = resolveEffectiveDaemonTopology(canonicalRoot, options);
  const projectSocket = getUfooPaths(canonicalRoot).ufooSock;
  const globalSocket = getUfooPaths(controllerRoot).ufooSock;
  let scope = "project";
  let sockPath = projectSocket;

  if (canonicalRoot === controllerRoot || topology === "global") {
    scope = "global";
    sockPath = globalSocket;
  } else if (topology === "hybrid") {
    const preferCompatibilitySocket = options.preferCompatibilitySocket !== false;
    if (!preferCompatibilitySocket || !isSocketFile(projectSocket)) {
      scope = "global";
      sockPath = globalSocket;
    }
  }

  return {
    topology,
    scope,
    socketPath: sockPath,
    projectRoot: canonicalRoot,
    controllerRoot,
    routeProjectRoot: scope === "global" && canonicalRoot !== controllerRoot
      ? canonicalRoot
      : "",
  };
}

function routeDaemonRequest(endpoint, request = {}) {
  if (!endpoint || !endpoint.routeProjectRoot) return { ...request };
  return {
    ...request,
    project_root: request.project_root || request.projectRoot || endpoint.routeProjectRoot,
  };
}

module.exports = {
  isSocketFile,
  resolveEffectiveDaemonTopology,
  resolveDaemonEndpoint,
  routeDaemonRequest,
};
