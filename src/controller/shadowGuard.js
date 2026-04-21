"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { getUfooPaths } = require("../ufoo/paths");

const DEFAULT_SHADOW_SAMPLING_RATE = 0.1;
const DEFAULT_SHADOW_DAILY_INPUT_TOKEN_LIMIT = 50000;
const DEFAULT_SHADOW_DAILY_OUTPUT_TOKEN_LIMIT = 10000;

const TIER2_MOCK_TOOL_NAMES = Object.freeze([
  "dispatch_message",
  "launch_agent",
  "rename_agent",
  "close_agent",
  "manage_cron",
]);

function hashMessageId(messageId) {
  const raw = String(messageId || "").trim();
  if (!raw) return 0;
  const digest = crypto.createHash("sha1").update(raw).digest();
  return digest.readUInt32BE(0);
}

function shouldSampleShadow({ messageId = "", samplingRate = DEFAULT_SHADOW_SAMPLING_RATE } = {}) {
  const rate = Number(samplingRate);
  if (!Number.isFinite(rate) || rate <= 0) return { sampled: false, rate: 0 };
  if (rate >= 1) return { sampled: true, rate: 1 };
  const bucket = hashMessageId(messageId) / 0xffffffff;
  return { sampled: bucket < rate, rate };
}

function getShadowBudgetPath(projectRoot, now = new Date()) {
  const { ufooDir } = getUfooPaths(projectRoot);
  const stamp = now.toISOString().slice(0, 10);
  return path.join(ufooDir, "shadow", `budget-${stamp}.json`);
}

function readShadowBudgetState(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return {
      input_tokens_used: Number(parsed.input_tokens_used) || 0,
      output_tokens_used: Number(parsed.output_tokens_used) || 0,
      tripped: Boolean(parsed.tripped),
      tripped_reason: String(parsed.tripped_reason || ""),
    };
  } catch {
    return { input_tokens_used: 0, output_tokens_used: 0, tripped: false, tripped_reason: "" };
  }
}

function writeShadowBudgetState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function createShadowBudgetBreaker({
  projectRoot,
  inputLimit = DEFAULT_SHADOW_DAILY_INPUT_TOKEN_LIMIT,
  outputLimit = DEFAULT_SHADOW_DAILY_OUTPUT_TOKEN_LIMIT,
  now = () => new Date(),
} = {}) {
  const resolveFile = () => getShadowBudgetPath(projectRoot, now());

  return {
    check() {
      const file = resolveFile();
      const state = readShadowBudgetState(file);
      if (state.tripped) {
        return { allowed: false, reason: state.tripped_reason || "shadow_budget_tripped", state };
      }
      if (state.input_tokens_used >= inputLimit) {
        return { allowed: false, reason: "shadow_input_budget_exceeded", state };
      }
      if (state.output_tokens_used >= outputLimit) {
        return { allowed: false, reason: "shadow_output_budget_exceeded", state };
      }
      return { allowed: true, state };
    },
    record({ inputTokens = 0, outputTokens = 0, tripped = false, trippedReason = "" } = {}) {
      const file = resolveFile();
      const state = readShadowBudgetState(file);
      state.input_tokens_used += Math.max(0, Number(inputTokens) || 0);
      state.output_tokens_used += Math.max(0, Number(outputTokens) || 0);
      if (tripped) {
        state.tripped = true;
        state.tripped_reason = String(trippedReason || "shadow_budget_tripped");
      } else if (state.input_tokens_used >= inputLimit) {
        state.tripped = true;
        state.tripped_reason = "shadow_input_budget_exceeded";
      } else if (state.output_tokens_used >= outputLimit) {
        state.tripped = true;
        state.tripped_reason = "shadow_output_budget_exceeded";
      }
      writeShadowBudgetState(file, state);
      return state;
    },
    tripForProviderRateLimit(reason = "shadow_provider_rate_limit") {
      const file = resolveFile();
      const state = readShadowBudgetState(file);
      state.tripped = true;
      state.tripped_reason = reason;
      writeShadowBudgetState(file, state);
      return state;
    },
  };
}

function snapshotDirectory(rootDir) {
  const entries = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    return { root: rootDir, entries };
  }

  const walk = (dir) => {
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of list) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        entries.push({
          path: abs,
          size: stat.size,
          ino: stat.ino,
          mtime_ms: Math.floor(stat.mtimeMs),
        });
      } catch {
        // ignore transient errors
      }
    }
  };

  walk(rootDir);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root: rootDir, entries };
}

function diffSnapshots(before = { entries: [] }, after = { entries: [] }) {
  const diffs = [];
  const beforeMap = new Map();
  for (const item of before.entries || []) beforeMap.set(item.path, item);
  const seen = new Set();

  for (const item of after.entries || []) {
    seen.add(item.path);
    const prior = beforeMap.get(item.path);
    if (!prior) {
      diffs.push({ path: item.path, kind: "added" });
      continue;
    }
    if (prior.size !== item.size || prior.ino !== item.ino) {
      diffs.push({ path: item.path, kind: "modified" });
    }
  }

  for (const item of before.entries || []) {
    if (!seen.has(item.path)) {
      diffs.push({ path: item.path, kind: "removed" });
    }
  }

  return diffs;
}

function resolveBusQueueRoot(projectRoot) {
  const { ufooDir } = getUfooPaths(projectRoot);
  return path.join(ufooDir, "bus", "queues");
}

function resolveMemoryRoot(projectRoot) {
  const { ufooDir } = getUfooPaths(projectRoot);
  return path.join(ufooDir, "memory");
}

function buildTier2ToolExecutor(ctx = {}) {
  const invocations = [];
  return {
    invocations,
    async execute(toolCall = {}) {
      const name = String(toolCall.name || "").trim();
      invocations.push({ name, arguments: toolCall.arguments || {} });
      if (TIER2_MOCK_TOOL_NAMES.includes(name)) {
        return {
          ok: true,
          mocked: true,
          shadow_only: true,
          name,
          result: { mocked: true, shadow_only: true },
        };
      }
      if (typeof ctx.fallback === "function") {
        return ctx.fallback(toolCall);
      }
      return {
        ok: false,
        error: { code: "shadow_only_tool_unavailable", message: `tool ${name} disabled in shadow mode` },
      };
    },
  };
}

function createShadowGuard({ projectRoot, now = () => new Date() } = {}) {
  const busQueueRoot = resolveBusQueueRoot(projectRoot);
  const memoryRoot = resolveMemoryRoot(projectRoot);
  const tier2 = buildTier2ToolExecutor();

  function takeSnapshot() {
    return {
      ts: now().toISOString(),
      bus_queue: snapshotDirectory(busQueueRoot),
      memory: snapshotDirectory(memoryRoot),
    };
  }

  function assertNoSideEffects(beforeSnapshot, afterSnapshot = takeSnapshot()) {
    const busDiff = diffSnapshots(beforeSnapshot.bus_queue, afterSnapshot.bus_queue);
    const memoryDiff = diffSnapshots(beforeSnapshot.memory, afterSnapshot.memory);
    const violations = [
      ...busDiff.map((d) => ({ scope: "bus_queue", ...d })),
      ...memoryDiff.map((d) => ({ scope: "memory", ...d })),
    ];
    return {
      ok: violations.length === 0,
      violations,
    };
  }

  function buildNoOpExecutors() {
    return {
      dispatchMessages: async () => undefined,
      handleOps: async () => [],
      ackBus: async () => 0,
      markPending: () => {},
      tier2ToolExecutor: tier2,
    };
  }

  return {
    projectRoot,
    busQueueRoot,
    memoryRoot,
    takeSnapshot,
    assertNoSideEffects,
    buildNoOpExecutors,
    tier2ToolInvocations: () => tier2.invocations.slice(),
  };
}

module.exports = {
  DEFAULT_SHADOW_DAILY_INPUT_TOKEN_LIMIT,
  DEFAULT_SHADOW_DAILY_OUTPUT_TOKEN_LIMIT,
  DEFAULT_SHADOW_SAMPLING_RATE,
  TIER2_MOCK_TOOL_NAMES,
  buildTier2ToolExecutor,
  createShadowBudgetBreaker,
  createShadowGuard,
  diffSnapshots,
  getShadowBudgetPath,
  hashMessageId,
  readShadowBudgetState,
  resolveBusQueueRoot,
  resolveMemoryRoot,
  shouldSampleShadow,
  snapshotDirectory,
  writeShadowBudgetState,
};
