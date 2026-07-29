"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createProjectContext,
} = require("../../../src/runtime/daemon/projectContext");
const {
  createProjectRuntime,
  RUNTIME_STATES,
} = require("../../../src/runtime/daemon/projectRuntime");

function makeContext(name, generation = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ufoo-runtime-${name}-`));
  fs.mkdirSync(path.join(root, ".ufoo"), { recursive: true });
  return {
    root,
    context: createProjectContext({
      projectRoot: root,
      config: {
        daemonTopology: "hybrid",
        marker: name,
      },
      runtimeGeneration: generation,
    }),
  };
}

describe("ProjectRuntime", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps resources and request state isolated across project instances", async () => {
    const first = makeContext("first");
    const second = makeContext("second");
    roots.push(first.root, second.root);
    const runtimeA = createProjectRuntime(first.context);
    const runtimeB = createProjectRuntime(second.context);
    runtimeA.own("providerSessions", new Map([["agent", "session-a"]]));
    runtimeB.own("providerSessions", new Map([["agent", "session-b"]]));
    runtimeA.registerOperation("read", async (_args, call) => ({
      root: call.context.projectRoot,
      marker: call.context.config.marker,
      session: call.runtime.resource("providerSessions").get("agent"),
    }));
    runtimeB.registerOperation("read", async (_args, call) => ({
      root: call.context.projectRoot,
      marker: call.context.config.marker,
      session: call.runtime.resource("providerSessions").get("agent"),
    }));

    await Promise.all([runtimeA.activate(), runtimeB.activate()]);
    await expect(runtimeA.call("read", {}, { requestId: "same-id" })).resolves.toEqual({
      root: first.context.projectRoot,
      marker: "first",
      session: "session-a",
    });
    await expect(runtimeB.call("read", {}, { requestId: "same-id" })).resolves.toEqual({
      root: second.context.projectRoot,
      marker: "second",
      session: "session-b",
    });
    expect(runtimeA.resource("providerSessions")).not.toBe(runtimeB.resource("providerSessions"));
  });

  test("contains fatal handler failure to one runtime", async () => {
    const first = makeContext("failed");
    const second = makeContext("healthy");
    roots.push(first.root, second.root);
    const runtimeA = createProjectRuntime(first.context);
    const runtimeB = createProjectRuntime(second.context);
    runtimeA.registerOperation("explode", async () => {
      const err = new Error("project-only failure");
      err.code = "PROJECT_HANDLER_FATAL";
      err.runtimeFatal = true;
      throw err;
    });
    runtimeB.registerOperation("ping", async () => "pong");
    await Promise.all([runtimeA.activate(), runtimeB.activate()]);

    await expect(runtimeA.call("explode")).rejects.toThrow("project-only failure");
    expect(runtimeA.status()).toMatchObject({
      state: RUNTIME_STATES.FAILED,
      last_error: {
        code: "PROJECT_HANDLER_FATAL",
      },
    });
    expect(runtimeB.status().state).toBe(RUNTIME_STATES.ACTIVE);
    await expect(runtimeB.call("ping")).resolves.toBe("pong");
  });

  test("cancels one in-flight request without affecting another runtime", async () => {
    const first = makeContext("cancel-a");
    const second = makeContext("cancel-b");
    roots.push(first.root, second.root);
    const runtimeA = createProjectRuntime(first.context);
    const runtimeB = createProjectRuntime(second.context);
    const waitForAbort = async (_args, call) => new Promise((resolve) => {
      call.signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
    });
    runtimeA.registerOperation("wait", waitForAbort);
    runtimeB.registerOperation("ping", async () => "pong");
    await Promise.all([runtimeA.activate(), runtimeB.activate()]);

    const pending = runtimeA.call("wait", {}, { requestId: "wait-a" });
    expect(runtimeA.cancel("wait-a")).toBe(true);
    await expect(pending).resolves.toBe("cancelled");
    await expect(runtimeB.call("ping")).resolves.toBe("pong");
    expect(runtimeA.status().active_request_count).toBe(0);
  });

  test("supports explicit suspend and recover lifecycle", async () => {
    const entry = makeContext("lifecycle", 3);
    roots.push(entry.root);
    const hooks = [];
    const runtime = createProjectRuntime(entry.context, {
      onSuspend: async () => hooks.push("suspend"),
      onRecover: async () => hooks.push("recover"),
    });
    await runtime.activate();
    expect(runtime.canSuspend()).toBe(true);
    await runtime.suspend();
    expect(runtime.status()).toMatchObject({
      state: RUNTIME_STATES.DORMANT,
      generation: 3,
    });
    runtime.fail(new Error("failed"));
    await runtime.recover();
    expect(runtime.status().state).toBe(RUNTIME_STATES.ACTIVE);
    expect(hooks).toEqual(["suspend", "recover"]);
  });
});
