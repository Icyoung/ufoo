"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createShadowBudgetBreaker,
  createShadowGuard,
  diffSnapshots,
  getShadowBudgetPath,
  readShadowBudgetState,
  shouldSampleShadow,
  snapshotDirectory,
} = require("../../../src/controller/shadowGuard");

function mkTempProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-shadow-guard-"));
}

describe("shadowGuard", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = mkTempProjectRoot();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("shouldSampleShadow is deterministic for the same messageId", () => {
    const first = shouldSampleShadow({ messageId: "deadbeef", samplingRate: 0.5 });
    const second = shouldSampleShadow({ messageId: "deadbeef", samplingRate: 0.5 });
    expect(first).toEqual(second);
  });

  test("shouldSampleShadow honors 0 and 1 rate bounds", () => {
    expect(shouldSampleShadow({ messageId: "msg", samplingRate: 0 }).sampled).toBe(false);
    expect(shouldSampleShadow({ messageId: "msg", samplingRate: 1 }).sampled).toBe(true);
  });

  test("takeSnapshot captures bus queue and memory contents", () => {
    const busQueue = path.join(projectRoot, ".ufoo", "bus", "queues", "codex_1");
    const memoryDir = path.join(projectRoot, ".ufoo", "memory");
    fs.mkdirSync(busQueue, { recursive: true });
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(busQueue, "pending.jsonl"), "{}\n");
    fs.writeFileSync(path.join(memoryDir, "memory.jsonl"), "{}\n");

    const guard = createShadowGuard({ projectRoot });
    const snapshot = guard.takeSnapshot();
    expect(snapshot.bus_queue.entries.length).toBe(1);
    expect(snapshot.memory.entries.length).toBe(1);
  });

  test("assertNoSideEffects detects bus queue mutations", () => {
    const busQueue = path.join(projectRoot, ".ufoo", "bus", "queues", "codex_1");
    fs.mkdirSync(busQueue, { recursive: true });
    fs.writeFileSync(path.join(busQueue, "pending.jsonl"), "{}\n");

    const guard = createShadowGuard({ projectRoot });
    const before = guard.takeSnapshot();
    fs.appendFileSync(path.join(busQueue, "pending.jsonl"), "{\"shadow\": true}\n");
    const result = guard.assertNoSideEffects(before);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.scope === "bus_queue" && v.kind === "modified")).toBe(true);
  });

  test("assertNoSideEffects passes when nothing changes", () => {
    const busQueue = path.join(projectRoot, ".ufoo", "bus", "queues", "codex_1");
    fs.mkdirSync(busQueue, { recursive: true });
    fs.writeFileSync(path.join(busQueue, "pending.jsonl"), "{}\n");

    const guard = createShadowGuard({ projectRoot });
    const before = guard.takeSnapshot();
    const result = guard.assertNoSideEffects(before);
    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  test("assertNoSideEffects catches new memory files", () => {
    const memoryDir = path.join(projectRoot, ".ufoo", "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const guard = createShadowGuard({ projectRoot });
    const before = guard.takeSnapshot();
    fs.writeFileSync(path.join(memoryDir, "new.jsonl"), "{}\n");
    const result = guard.assertNoSideEffects(before);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.scope === "memory" && v.kind === "added")).toBe(true);
  });

  test("buildNoOpExecutors installs no-op dispatch/ops/ack and tier-2 mocks", async () => {
    const guard = createShadowGuard({ projectRoot });
    const executors = guard.buildNoOpExecutors();
    await expect(executors.dispatchMessages(projectRoot, [{}])).resolves.toBeUndefined();
    await expect(executors.handleOps(projectRoot, [{}], null)).resolves.toEqual([]);
    await expect(executors.ackBus(projectRoot, "x")).resolves.toBe(0);
    expect(() => executors.markPending("x")).not.toThrow();

    const dispatch = await executors.tier2ToolExecutor.execute({ name: "dispatch_message", arguments: { target: "codex:1" } });
    expect(dispatch).toEqual(expect.objectContaining({
      ok: true,
      mocked: true,
      shadow_only: true,
      name: "dispatch_message",
    }));
    const launch = await executors.tier2ToolExecutor.execute({ name: "launch_agent", arguments: { agent: "codex" } });
    expect(launch.mocked).toBe(true);
    expect(guard.tier2ToolInvocations()).toHaveLength(2);
  });

  test("createShadowBudgetBreaker trips when input budget exhausted", () => {
    const breaker = createShadowBudgetBreaker({
      projectRoot,
      inputLimit: 100,
      outputLimit: 100,
    });
    expect(breaker.check().allowed).toBe(true);
    breaker.record({ inputTokens: 80, outputTokens: 0 });
    expect(breaker.check().allowed).toBe(true);
    const state = breaker.record({ inputTokens: 30, outputTokens: 0 });
    expect(state.tripped).toBe(true);
    expect(state.tripped_reason).toBe("shadow_input_budget_exceeded");
    expect(breaker.check().allowed).toBe(false);
  });

  test("createShadowBudgetBreaker respects manual rate-limit trip", () => {
    const breaker = createShadowBudgetBreaker({ projectRoot });
    expect(breaker.check().allowed).toBe(true);
    breaker.tripForProviderRateLimit("shadow_provider_rate_limit");
    const check = breaker.check();
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("shadow_provider_rate_limit");
    const file = getShadowBudgetPath(projectRoot);
    const persisted = readShadowBudgetState(file);
    expect(persisted.tripped).toBe(true);
  });

  test("defaults enforce 50k input + 10k output daily budget", () => {
    const breaker = createShadowBudgetBreaker({ projectRoot });
    breaker.record({ inputTokens: 50000 });
    expect(breaker.check().allowed).toBe(false);

    const projectRootB = mkTempProjectRoot();
    const breakerB = createShadowBudgetBreaker({ projectRoot: projectRootB });
    breakerB.record({ outputTokens: 10000 });
    expect(breakerB.check().allowed).toBe(false);
    fs.rmSync(projectRootB, { recursive: true, force: true });
  });

  test("diffSnapshots produces empty diff when identical", () => {
    const snap = snapshotDirectory(path.join(projectRoot, "nonexistent"));
    expect(diffSnapshots(snap, snap)).toEqual([]);
  });
});
