"use strict";

const fs = require("fs");
const path = require("path");
const { createResourceLease } = require("../../agents/runtime/tasks/resourceLease");

function createWorkspaceAccess({ projectRoot, externalWriters = () => [] } = {}) {
  const root = fs.realpathSync(projectRoot);
  const key = (workspaceRoot) => fs.realpathSync(workspaceRoot || root);
  const stores = new Map();
  function storeFor(workspaceRoot) {
    const workspace = key(workspaceRoot);
    if (!stores.has(workspace)) stores.set(workspace, createResourceLease({ file: path.join(workspace, ".ufoo", "agent", "runtime", "workspace-leases.json") }));
    return stores.get(workspace);
  }
  // All hosts accessing the same directory use its lease, including a native
  // ucode opened directly in a linked worktree.
  const leases = Object.freeze(Object.fromEntries(["acquire", "release", "run"].map((method) => [method,
    (args, ...rest) => storeFor(args.key)[method]({ ...args, key: key(args.key) }, ...rest)])));
  return Object.freeze({
    leases,
    async run(context, operation) {
      if (!["write", "edit", "bash"].includes(context.tool)) return operation();
      const workspace = key(context.workspaceRoot);
      const writers = workspace === root ? externalWriters(context) : [];
      if (writers.length) return { ok: false, code: "workspace_busy", error: "external workers own or may write this workspace", owners: writers };
      return leases.run({ key: workspace, ownerId: context.taskRunId || context.sessionId || `process-${process.pid}`, signal: context.signal }, operation);
    },
    async runTask(context, operation) {
      const workspace = key(context.workspaceRoot);
      return leases.run({ key: workspace, ownerId: context.taskRunId, signal: context.signal, wait: true }, operation);
    },
  });
}

module.exports = { createWorkspaceAccess };
