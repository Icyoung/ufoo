"use strict";

/**
 * Tool runtime descriptors, resource locks, and node claim leases.
 * Used by the plan graph scheduler — not a second tool ABI.
 */

const { randomUUID } = require("crypto");

const DEFAULT_LEASE_MS = 120000;

const TOOL_DESCRIPTORS = Object.freeze({
  read: {
    sideEffect: "none",
    supportsCancellation: true,
    retryClass: "safe",
    resourceKeys(args = {}) {
      const path = String(args.path || "").trim();
      // Share the file key with write/edit so mixed batches stay conflict-free.
      return path ? [`file:${path}`] : [];
    },
  },
  artifact_read: {
    sideEffect: "none",
    supportsCancellation: true,
    retryClass: "safe",
    resourceKeys(args = {}) {
      const id = String(args.artifactId || args.id || "").trim();
      return id ? [`artifact:${id}`] : [];
    },
  },
  write: {
    sideEffect: "workspace",
    supportsCancellation: false,
    retryClass: "unsafe",
    resourceKeys(args = {}) {
      const path = String(args.path || "").trim();
      return path ? [`file:${path}`] : ["workspace:*"];
    },
  },
  edit: {
    sideEffect: "workspace",
    supportsCancellation: false,
    retryClass: "unsafe",
    resourceKeys(args = {}) {
      const path = String(args.path || "").trim();
      return path ? [`file:${path}`] : ["workspace:*"];
    },
  },
  bash: {
    sideEffect: "workspace",
    supportsCancellation: true,
    retryClass: "conditional",
    resourceKeys() {
      return ["workspace:*"];
    },
  },
});

function getToolDescriptor(tool = "") {
  const name = String(tool || "").trim().toLowerCase();
  return TOOL_DESCRIPTORS[name] || {
    sideEffect: "external",
    supportsCancellation: false,
    retryClass: "unsafe",
    resourceKeys: () => ["workspace:*"],
  };
}

function createLease({
  workerId = "local",
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now(),
} = {}) {
  const ttl = Number.isFinite(leaseMs) ? Math.max(1000, Math.floor(leaseMs)) : DEFAULT_LEASE_MS;
  return {
    id: `lease_${randomUUID().slice(0, 8)}`,
    workerId: String(workerId || "local"),
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  };
}

function isLeaseExpired(lease = null, now = Date.now()) {
  if (!lease || !lease.expiresAt) return true;
  const exp = Date.parse(String(lease.expiresAt));
  if (!Number.isFinite(exp)) return true;
  return now >= exp;
}

function recoverExpiredLeases(nodeMap = new Map(), {
  now = Date.now(),
} = {}) {
  const recovered = [];
  for (const node of nodeMap.values()) {
    if (node.status !== "running") continue;
    if (!isLeaseExpired(node.lease, now)) continue;
    const descriptor = getToolDescriptor(node.tool);
    if (descriptor.retryClass === "safe") {
      node.status = "pending";
      node.lease = null;
      node.error = "lease expired; retrying";
      recovered.push({ id: node.id, action: "retry" });
    } else {
      node.status = "failed";
      node.error = "lease expired; unsafe to auto-retry";
      node.lease = null;
      recovered.push({ id: node.id, action: "fail" });
    }
  }
  return recovered;
}

function resourcesConflict(a = [], b = []) {
  const setB = new Set(b);
  for (const key of a) {
    if (setB.has(key)) return true;
    if (key === "workspace:*" && b.length > 0) return true;
    if (setB.has("workspace:*") && a.length > 0) return true;
  }
  return false;
}

/**
 * Claim a conflict-free batch of ready tool nodes.
 * parallel=false → at most one. Locks are advisory within a single advance pass.
 */
function claimSafeReadyToolBatch(readyTools = [], {
  parallel = true,
  resolveArgs = (node) => node.args || {},
  workerId = "local",
  leaseMs = DEFAULT_LEASE_MS,
  now = Date.now(),
  maxBatch = 8,
} = {}) {
  const claimed = [];
  const held = [];

  for (const node of readyTools) {
    if (!parallel && claimed.length >= 1) break;
    if (claimed.length >= maxBatch) break;

    const args = resolveArgs(node) || {};
    const descriptor = getToolDescriptor(node.tool);
    const keys = typeof descriptor.resourceKeys === "function"
      ? descriptor.resourceKeys(args)
      : [];

    const conflict = held.some((entry) => resourcesConflict(entry.keys, keys));
    if (conflict) continue;

    node.status = "running";
    node.attempt = (Number(node.attempt) || 0) + 1;
    node.lease = createLease({ workerId, leaseMs, now });
    node.executionId = `exec_${node.id}_${node.attempt}_${randomUUID().slice(0, 6)}`;
    claimed.push(node);
    held.push({ keys, nodeId: node.id });
  }

  return claimed;
}

module.exports = {
  DEFAULT_LEASE_MS,
  TOOL_DESCRIPTORS,
  getToolDescriptor,
  createLease,
  isLeaseExpired,
  recoverExpiredLeases,
  resourcesConflict,
  claimSafeReadyToolBatch,
};
