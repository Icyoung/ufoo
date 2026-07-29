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
