"use strict";

const { Duplex } = require("stream");

const {
  createLocalProjectRuntimeGateway,
  createManagedProjectRuntimeGateway,
  createSocketProjectRuntimeGateway,
  resolveCallTimeoutMs,
} = require("../../../src/runtime/daemon/projectRuntimeGateway");
const {
  IPC_REQUEST_TYPES,
  IPC_RESPONSE_TYPES,
} = require("../../../src/runtime/contracts/eventContract");

function createRuntimeSocket(onRequest) {
  let buffer = "";
  return new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = onRequest(JSON.parse(line));
        if (response) this.push(`${JSON.stringify(response)}\n`);
      }
      callback();
    },
  });
}

describe("ProjectRuntimeGateway", () => {
  const managedGateways = [];

  afterEach(() => {
    for (const gateway of managedGateways.splice(0)) gateway.dispose();
  });

  test("does not arm a gateway timer for the default until-message wait", () => {
    expect(resolveCallTimeoutMs("wait_for_message", {})).toBeNull();
    expect(resolveCallTimeoutMs("wait_for_message", { timeout_seconds: 0 })).toBeNull();
    expect(resolveCallTimeoutMs("wait_for_message", { timeout_seconds: 12 })).toBe(17000);
  });

  test("local gateway delegates control-plane operations through one boundary", async () => {
    const registerAgent = jest.fn(async (projectRoot, args) => ({
      ok: true,
      project_root: projectRoot,
      subscriber: `codex:${args.session_id}`,
    }));
    const gateway = createLocalProjectRuntimeGateway({
      controlPlaneService: { registerAgent },
    });

    const result = await gateway.call("/tmp/project-a", "register_agent", {
      session_id: "session-a",
    });

    expect(result).toMatchObject({
      ok: true,
      project_root: "/tmp/project-a",
      subscriber: "codex:session-a",
    });
    expect(registerAgent).toHaveBeenCalledWith("/tmp/project-a", {
      session_id: "session-a",
    });
  });

  test("socket gateway sends a correlated call and returns the runtime result", async () => {
    const socket = createRuntimeSocket((request) => {
      if (request.type !== IPC_REQUEST_TYPES.CONTROL_PLANE_CALL) return null;
      return {
        type: IPC_RESPONSE_TYPES.CONTROL_PLANE_RESULT,
        request_id: request.request_id,
        ok: true,
        result: {
          operation: request.operation,
          args: request.arguments,
        },
      };
    });

    const gateway = createSocketProjectRuntimeGateway({
      connect: async () => socket,
      socketPath: () => "/virtual/project.sock",
      connectTimeoutMs: 1000,
      callTimeoutMs: 1000,
    });
    const result = await gateway.call("/tmp/project-b", "heartbeat_agent", {
      subscriber: "codex:b",
    });

    expect(result).toEqual({
      operation: "heartbeat_agent",
      args: { subscriber: "codex:b" },
    });
  });

  test("socket gateway preserves typed project runtime errors", async () => {
    const socket = createRuntimeSocket((request) => ({
      type: IPC_RESPONSE_TYPES.CONTROL_PLANE_RESULT,
      request_id: request.request_id,
      ok: false,
      error: {
        code: "subscriber_not_found",
        message: "subscriber missing",
      },
    }));
    const gateway = createSocketProjectRuntimeGateway({
      connect: async () => socket,
      socketPath: () => "/virtual/project.sock",
      connectTimeoutMs: 1000,
      callTimeoutMs: 1000,
    });

    await expect(gateway.call("/tmp/project-c", "poll_inbox", {
      subscriber: "codex:missing",
    })).rejects.toMatchObject({
      code: "subscriber_not_found",
      message: "subscriber missing",
    });
  });

  test("managed gateway routes local operations through isolated runtime instances", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const roots = [
      fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-managed-gateway-a-")),
      fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-managed-gateway-b-")),
    ];
    roots.forEach((root) => fs.mkdirSync(path.join(root, ".ufoo"), { recursive: true }));
    const registerAgent = jest.fn(async (projectRoot, args) => ({
      ok: true,
      project_root: projectRoot,
      subscriber: `codex:${args.session_id}`,
    }));
    const gateway = createManagedProjectRuntimeGateway({
      controlPlaneService: { registerAgent },
      managerOptions: { sweepIntervalMs: 0 },
    });
    managedGateways.push(gateway);
    try {
      const [first, second] = await Promise.all([
        gateway.call(roots[0], "register_agent", { session_id: "a" }, { requestId: "a" }),
        gateway.call(roots[1], "register_agent", { session_id: "b" }, { requestId: "b" }),
      ]);
      expect(first.project_root).toBe(fs.realpathSync(roots[0]));
      expect(second.project_root).toBe(fs.realpathSync(roots[1]));
      expect(gateway.status()).toMatchObject({
        runtime_count: 2,
        active_runtime_count: 2,
      });
    } finally {
      roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
    }
  });
});
