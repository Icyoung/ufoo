"use strict";

const path = require("path");

const { loadConfig } = require("../../config");
const { getUfooPaths } = require("../../coordination/state/paths");
const {
  buildProjectId,
  canonicalProjectRoot,
} = require("../projects");

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value == null ? {} : value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createProjectContext(options = {}) {
  const projectRoot = canonicalProjectRoot(options.projectRoot);
  const configSnapshot = cloneJson(options.config || loadConfig(projectRoot));
  const runtimeGeneration = Number.isInteger(options.runtimeGeneration)
    && options.runtimeGeneration > 0
    ? options.runtimeGeneration
    : 1;
  const context = {
    projectId: options.projectId || buildProjectId(projectRoot),
    projectRoot,
    projectName: options.projectName || path.basename(projectRoot),
    paths: getUfooPaths(projectRoot),
    config: configSnapshot,
    provider: String(options.provider || configSnapshot.agentProvider || ""),
    model: String(options.model || configSnapshot.agentModel || ""),
    daemonTopology: String(options.daemonTopology || configSnapshot.daemonTopology || "global"),
    runtimeGeneration,
  };
  return deepFreeze(context);
}

module.exports = {
  createProjectContext,
  deepFreeze,
};
