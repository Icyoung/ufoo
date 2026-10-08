"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  startDaemon,
} = require("../../../src/runtime/daemon");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function initializeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ufoo-host-${name}-`));
  const paths = getUfooPaths(root);
  fs.mkdirSync(paths.busQueuesDir, { recursive: true });
  fs.mkdirSync(paths.busEventsDir, { recursive: true });
  fs.mkdirSync(paths.busLogsDir, { recursive: true });
  fs.mkdirSync(paths.busOffsetsDir, { recursive: true });
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.agentsFile, JSON.stringify({
    created_at: new Date().toISOString(),
    agents: {},
  }, null, 2));
  return root;
}

async function waitForSocket(sockPath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath)) {
      const connected = await new Promise((resolve) => {
        const socket = net.createConnection(sockPath);
        socket.once("connect", () => {
          socket.end();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      if (connected) return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`socket did not become ready: ${sockPath}`);
}

describe("multi-project daemon runtime host", () => {
  test("the default prompt and runtime IPC share one durable coding run across client disconnects", async () => {
    const root = initializeProject("native-ipc");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-host-home-"));
    const homeSpy = jest.spyOn(os, "homedir").mockReturnValue(home);
    const previousFetch = global.fetch;
    let daemon;
    const frames = [];
    const socket = { destroyed: false, write: (line) => frames.push(JSON.parse(line)) };
    try {
      fs.writeFileSync(path.join(root, ".ufoo/config.json"), JSON.stringify({ controllerMode: "main", ucodeProvider: "openai", ucodeApiKey: "isolated-test-key", ucodeModel: "test" }));
      fs.mkdirSync(path.join(home, ".ufoo"), { recursive: true });
      fs.writeFileSync(path.join(home, ".ufoo/config.json"), JSON.stringify({ ucodeProvider: "openai", ucodeApiKey: "isolated-test-key", ucodeModel: "test" }));
      global.fetch = jest.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "IPC native main completed." } }] }), { headers: { "content-type": "application/json" } }));
      daemon = startDaemon({ projectRoot: root, provider: "ucode", model: "test", resumeMode: "none", manageProcessState: false, listenProjectSocket: false });
      await daemon.handleRequest({ type: "prompt", request_id: "ipc-native", text: "inspect project" }, socket);
      expect(frames.find((frame) => frame.type === "error")).toBeUndefined();
      expect(frames.find((frame) => frame.type === "response").data.runtime.status).toBe("completed");
      socket.destroyed = true;
      await daemon.handleRequest({ type: "agent_runtime", operation: "submit", request_id: "ipc-background", text: "background task" }, socket);
      const agentHost = daemon.runtime.resource("agentHost");
      const task = Object.values(agentHost.getSession().snapshot().tasks).find((item) => item.request.requestId === "ipc-background");
      expect((await agentHost.getSession().wait(task.taskRunId)).status).toBe("completed");
      socket.destroyed = false;
      await daemon.handleRequest({ type: "agent_runtime", operation: "events", request_id: "ipc-replay", after_sequence: 0 }, socket);
      const replay = frames.find((frame) => frame.request_id === "ipc-replay").data.events;
      expect(replay.filter((event) => event.type === "task.completed")).toHaveLength(2);
      expect(JSON.stringify(replay)).not.toContain("isolated-test-key");
      await daemon.handleRequest({ type: "prompt", request_id: "ipc-native", text: "inspect project" }, socket);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      if (daemon) { await daemon.runtime.resource("agentHost").close(); daemon.cleanup("test-native-ipc"); }
      await new Promise((resolve) => setImmediate(resolve));
      global.fetch = previousFetch; homeSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
    }
  });
  test("runs two complete project runtimes in one process without shared resources", async () => {
    const rootA = initializeProject("a");
    const rootB = initializeProject("b");
    let hostA;
    let hostB;
    try {
      hostA = startDaemon({
        projectRoot: rootA,
        provider: "codex-cli",
        model: "",
        resumeMode: "none",
      });
      hostB = startDaemon({
        projectRoot: rootB,
        provider: "claude-cli",
        model: "",
        resumeMode: "none",
      });
      await Promise.all([
        waitForSocket(hostA.socket_path),
        waitForSocket(hostB.socket_path),
      ]);

      expect(hostA.context.projectId).not.toBe(hostB.context.projectId);
      expect(hostA.context.projectRoot).toBe(fs.realpathSync(rootA));
      expect(hostB.context.projectRoot).toBe(fs.realpathSync(rootB));
      for (const resource of [
        "processManager",
        "providerSessions",
        "sessionResolveHandles",
        "cronController",
        "groupOrchestrator",
        "ipcServer",
        "busBridge",
        "deliveryScheduler",
        "runtimeControlPlane",
      ]) {
        expect(hostA.runtime.resource(resource)).toBeTruthy();
        expect(hostB.runtime.resource(resource)).toBeTruthy();
        expect(hostA.runtime.resource(resource)).not.toBe(hostB.runtime.resource(resource));
      }
      expect(hostA.status().runtime.project_root).toBe(fs.realpathSync(rootA));
      expect(hostB.status().runtime.project_root).toBe(fs.realpathSync(rootB));

      hostA.cleanup("test-project-a");
      expect(fs.existsSync(hostA.socket_path)).toBe(false);
      expect(fs.existsSync(hostB.socket_path)).toBe(true);
      expect(hostB.runtime.status().state).toBe("active");
    } finally {
      if (hostA) hostA.cleanup("test-finally-a");
      if (hostB) hostB.cleanup("test-finally-b");
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  }, 10000);
});
