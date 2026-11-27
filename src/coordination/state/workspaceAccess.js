"use strict";

const fs = require("fs");
const path = require("path");
const { createResourceLease } = require("../../agents/runtime/tasks/resourceLease");

/**
 * Shared-repo workspace access helper.
 *
 * Agents collaborate directly in the shared repository without whole-repo
 * write blocking; explicit resource leases remain available for callers that
 * opt into serialized access on a specific key.
 */
function createWorkspaceAccess({ projectRoot } = {}) {
  const root = fs.realpathSync(projectRoot);
  const key = (workspaceRoot) => fs.realpathSync(workspaceRoot || root);
  const stores = new Map();
  function storeFor(workspaceRoot) {
    const workspace = key(workspaceRoot);
    if (!stores.has(workspace)) stores.set(workspace, createResourceLease({ file: path.join(workspace, ".ufoo", "agent", "runtime", "workspace-leases.json") }));
    return stores.get(workspace);
  }
  const leases = Object.freeze(Object.fromEntries(["acquire", "release", "run"].map((method) => [method,
    (args, ...rest) => storeFor(args.key)[method]({ ...args, key: key(args.key) }, ...rest)])));
  return Object.freeze({
    leases,
    async run(_context, operation) {
      return operation();
    },
    async runTask(_context, operation) {
      return operation();
    },
  });
}

module.exports = { createWorkspaceAccess };
