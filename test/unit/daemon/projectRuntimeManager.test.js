"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ProjectRuntimeManager,
} = require("../../../src/runtime/daemon/projectRuntimeManager");
const {
  RUNTIME_STATES,
} = require("../../../src/runtime/daemon/projectRuntime");

function makeRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ufoo-manager-${name}-`));
  fs.mkdirSync(path.join(root, ".ufoo"), { recursive: true });
  return root;
}

describe("ProjectRuntimeManager", () => {
  const roots = [];
  const managers = [];

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function createManager(options = {}) {
    const activations = new Map();
    const manager = new ProjectRuntimeManager({
      sweepIntervalMs: 0,
      configureRuntime: (runtime, context) => {
        runtime.registerOperation("identity", async () => ({
          project_id: context.projectId,
          project_root: context.projectRoot,
          generation: context.runtimeGeneration,
        }));
        runtime.registerOperation("wait", async (_args, call) => new Promise((resolve) => {
          call.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
        }));
        runtime.registerOperation("fatal", async () => {
          const err = new Error("fatal project handler");
          err.runtimeFatal = true;
          throw err;
        });
        const originalActivate = runtime.activate.bind(runtime);
        runtime.activate = async () => {
          activations.set(context.projectId, (activations.get(context.projectId) || 0) + 1);
          return originalActivate();
        };
      },
      ...options,
    });
    manager.activations = activations;
    managers.push(manager);
    return manager;
  }

  test("serializes activation per project and routes several projects independently", async () => {
    const rootA = makeRoot("a");
    const rootB = makeRoot("b");
    roots.push(rootA, rootB);
    const manager = createManager();

    const [a1, a2, b] = await Promise.all([
      manager.call(rootA, "identity", {}, { requestId: "a-1" }),
      manager.call(rootA, "identity", {}, { requestId: "a-2" }),
      manager.call(rootB, "identity", {}, { requestId: "b-1" }),
    ]);
    expect(a1.project_id).toBe(a2.project_id);
    expect(a1.project_id).not.toBe(b.project_id);
    expect(a1.project_root).toBe(fs.realpathSync(rootA));
    expect(b.project_root).toBe(fs.realpathSync(rootB));
    expect(manager.activations.get(a1.project_id)).toBe(1);
    expect(manager.status()).toMatchObject({
      runtime_count: 2,
      active_runtime_count: 2,
    });
  });

  test("cancels a project request by project root and request id", async () => {
    const root = makeRoot("cancel");
    roots.push(root);
    const manager = createManager();
    const pending = manager.call(root, "wait", {}, { requestId: "wait-1" });
    while (!manager.entryForRoot(root)?.runtime.activeRequests.has("wait-1")) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(manager.cancel(root, "wait-1")).toBe(true);
    await expect(pending).resolves.toBe("cancelled");
    expect(manager.status().active_request_count).toBe(0);
  });

  test("recycles only the failed project with a higher generation", async () => {
    const rootA = makeRoot("failed");
    const rootB = makeRoot("healthy");
    roots.push(rootA, rootB);
    const manager = createManager();
    const firstA = await manager.call(rootA, "identity");
    const firstB = await manager.call(rootB, "identity");
    await expect(manager.call(rootA, "fatal")).rejects.toThrow("fatal project handler");
    expect(manager.entryForRoot(rootA).runtime.state).toBe(RUNTIME_STATES.FAILED);
    expect(manager.entryForRoot(rootB).runtime.state).toBe(RUNTIME_STATES.ACTIVE);

    const secondA = await manager.call(rootA, "identity");
    const secondB = await manager.call(rootB, "identity");
    expect(secondA.generation).toBe(firstA.generation + 1);
    expect(secondB.generation).toBe(firstB.generation);
  });

  test("suspends idle runtimes and enforces active runtime pressure", async () => {
    let nowMs = Date.parse("2026-07-29T00:00:00.000Z");
    const rootA = makeRoot("idle-a");
    const rootB = makeRoot("idle-b");
    roots.push(rootA, rootB);
    const manager = createManager({
      idleGraceMs: 1000,
      maxActiveRuntimes: 1,
      now: () => nowMs,
    });
    await manager.call(rootA, "identity");
    nowMs += 2000;
    await manager.call(rootB, "identity");
    expect(manager.entryForRoot(rootA).runtime.state).toBe(RUNTIME_STATES.DORMANT);
    expect(manager.entryForRoot(rootB).runtime.state).toBe(RUNTIME_STATES.ACTIVE);
    expect(manager.status().active_runtime_count).toBe(1);
  });

  test("rejects unauthorized roots before creating runtime state", async () => {
    const root = makeRoot("denied");
    roots.push(root);
    const manager = createManager({
      authorizeProjectRoot: () => false,
    });
    await expect(manager.call(root, "identity")).rejects.toMatchObject({
      code: "PROJECT_RUNTIME_ACCESS_DENIED",
    });
    expect(manager.status().runtime_count).toBe(0);
  });
});
