"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

const {
  GlobalDaemon,
  projectRuntimeRecoveryReasons,
} = require("../../../src/runtime/daemon/globalDaemon");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function initializeProject(name) {
  const root = fs.mkdtempSync(path.join("/tmp", `ufoo-gd-${name.slice(0, 8)}-`));
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
  return fs.realpathSync(root);
}

async function waitForSocket(sockPath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(sockPath)) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const runDir = path.dirname(sockPath);
  const files = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
  const logFile = path.join(runDir, "ufoo-daemon.log");
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  throw new Error(
    `socket did not become ready: ${sockPath}; files=${JSON.stringify(files)}; log=${JSON.stringify(log)}`
  );
}

function requestStatus(sockPath, projectRoot) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("status request timed out"));
    }, 5000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        type: "status",
        project_root: projectRoot,
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload.type !== "status") continue;
        clearTimeout(timer);
        socket.end();
        resolve(payload.data);
        return;
      }
    });
    socket.on("error", reject);
  });
}

function requestResponse(sockPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("daemon request timed out"));
    }, 5000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const payload = JSON.parse(line);
        if (payload.type !== "response" && payload.type !== "error") continue;
        clearTimeout(timer);
        socket.end();
        if (payload.type === "error") reject(new Error(payload.error));
        else resolve(payload.data);
        return;
      }
    });
    socket.on("error", reject);
  });
}

describe("GlobalDaemon", () => {
  test("recovery policy selects live wrapper agents and durable cron work", () => {
    const liveRoot = initializeProject("recovery-live");
    const mcpOnlyRoot = initializeProject("recovery-mcp");
    const cronRoot = initializeProject("recovery-cron");
    try {
      fs.writeFileSync(getUfooPaths(liveRoot).agentsFile, JSON.stringify({
        agents: {
          "codex:live": {
            status: "active",
            pid: 41,
            launch_mode: "host",
          },
        },
      }));
      fs.writeFileSync(getUfooPaths(mcpOnlyRoot).agentsFile, JSON.stringify({
        agents: {
          "codex:mcp": {
            status: "active",
            pid: 42,
            mcp_bridge: true,
          },
        },
      }));
      fs.writeFileSync(
        path.join(getUfooPaths(cronRoot).runDir, "cron.tasks.json"),
        JSON.stringify({ version: 1, tasks: [{ id: "c1" }] })
      );
      const options = {
        isAgentPidAlive: (pid) => pid === 41,
      };

      expect(projectRuntimeRecoveryReasons(liveRoot, options))
        .toEqual(["live_host_agent"]);
      expect(projectRuntimeRecoveryReasons(mcpOnlyRoot, options)).toEqual([]);
      expect(projectRuntimeRecoveryReasons(cronRoot, options))
        .toEqual(["scheduled_task"]);
    } finally {
      fs.rmSync(liveRoot, { recursive: true, force: true });
      fs.rmSync(mcpOnlyRoot, { recursive: true, force: true });
      fs.rmSync(cronRoot, { recursive: true, force: true });
    }
  });

  test("rehydrates owned project runtimes after a global controller restart", async () => {
    const controllerRoot = initializeProject("controller-rehydrate");
    const liveRoot = initializeProject("rehydrate-live");
    const cronRoot = initializeProject("rehydrate-cron");
    const idleRoot = initializeProject("rehydrate-idle");
    const missingRoot = initializeProject("rehydrate-missing");
    fs.rmSync(missingRoot, { recursive: true, force: true });
    const starts = [];
    const handles = [];
    const daemon = new GlobalDaemon({
      controllerRoot,
      topology: "global",
      rehydrateProjects: true,
      listProjectRuntimes: () => [
        { project_root: liveRoot },
        { project_root: cronRoot },
        { project_root: idleRoot },
        { project_root: missingRoot },
      ],
      projectRuntimeRecoveryReasons: (projectRoot) => {
        if (projectRoot === liveRoot) return ["live_host_agent"];
        if (projectRoot === cronRoot) return ["scheduled_task"];
        return [];
      },
      startProjectRuntime: (options) => {
        starts.push(options.projectRoot);
        const handle = {
          cleanup: jest.fn(),
          status: () => ({ active: [] }),
          handleRequest: jest.fn(),
          runtime: { resource: () => null },
        };
        handles.push(handle);
        return handle;
      },
      loadProjectConfig: () => ({
        agentProvider: "codex-cli",
        agentModel: "",
      }),
      sweepIntervalMs: 0,
    });

    try {
      daemon.start();
      const recovery = await daemon.rehydrationPromise;

      expect(starts).toEqual([controllerRoot, liveRoot, cronRoot]);
      expect(recovery.state).toBe("complete");
      expect(recovery.restored).toEqual([
        { project_root: liveRoot, reasons: ["live_host_agent"] },
        { project_root: cronRoot, reasons: ["scheduled_task"] },
      ]);
      expect(recovery.skipped).toEqual(expect.arrayContaining([
        { project_root: idleRoot, reason: "no_live_runtime_owner" },
        { project_root: missingRoot, reason: "missing_project_root" },
      ]));
      expect(recovery.skipped_count).toBe(2);
      expect(daemon.status()).toMatchObject({
        runtime_count: 2,
        rehydration: { state: "complete" },
      });
      expect(daemon.projectRuntimeGateway.status()).toMatchObject({
        runtime_count: 2,
        rehydration: { state: "complete" },
      });
    } finally {
      daemon.stop("test");
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(liveRoot, { recursive: true, force: true });
      fs.rmSync(cronRoot, { recursive: true, force: true });
      fs.rmSync(idleRoot, { recursive: true, force: true });
      for (const handle of handles) expect(handle.cleanup).toHaveBeenCalled();
    }
  });

  test("hybrid routes global requests into isolated runtimes and exposes compatibility sockets", async () => {
    const controllerRoot = initializeProject("controller");
    const rootA = initializeProject("a");
    const rootB = initializeProject("b");
    const daemon = new GlobalDaemon({
      controllerRoot,
      topology: "hybrid",
    });

    try {
      daemon.start({ resumeMode: "none" });
      const controllerSocket = daemon.controller.socket_path;
      await waitForSocket(controllerSocket);

      const [statusA, statusB] = await Promise.all([
        requestStatus(controllerSocket, rootA),
        requestStatus(controllerSocket, rootB),
      ]);

      expect(statusA.runtime).toMatchObject({
        project_root: fs.realpathSync(rootA),
        topology: "hybrid",
        state: "active",
      });
      expect(statusB.runtime).toMatchObject({
        project_root: fs.realpathSync(rootB),
        topology: "hybrid",
        state: "active",
      });
      expect(daemon.status()).toMatchObject({
        topology: "hybrid",
        pid: process.pid,
        runtime_count: 2,
      });
      expect(fs.existsSync(getUfooPaths(rootA).ufooSock)).toBe(true);
      expect(fs.existsSync(getUfooPaths(rootB).ufooSock)).toBe(true);
      expect(fs.existsSync(getUfooPaths(rootA).ufooDaemonPid)).toBe(false);
      expect(fs.existsSync(getUfooPaths(rootB).ufooDaemonPid)).toBe(false);
      expect(fs.existsSync(path.join(getUfooPaths(rootA).runDir, "daemon.lock"))).toBe(false);
      expect(fs.existsSync(path.join(getUfooPaths(rootB).runDir, "daemon.lock"))).toBe(false);

      const routed = await daemon.request(rootA, {
        type: "list_recoverable_agents",
      });
      expect(routed).toMatchObject({
        ok: true,
        payload: {
          reply: "No recoverable agents",
        },
      });
    } finally {
      daemon.stop("test");
      expect(fs.existsSync(getUfooPaths(rootA).ufooSock)).toBe(false);
      expect(fs.existsSync(getUfooPaths(rootB).ufooSock)).toBe(false);
      expect(fs.existsSync(getUfooPaths(controllerRoot).ufooSock)).toBe(false);
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  }, 15000);

  test("serializes concurrent activation for the same project", async () => {
    const controllerRoot = initializeProject("controller-serialized");
    const rootA = initializeProject("serialized");
    let starts = 0;
    const fakeController = {
      cleanup: jest.fn(),
      status: () => ({ runtime: { project_root: controllerRoot } }),
      handleRequest: jest.fn(),
    };
    const fakeProject = {
      cleanup: jest.fn(),
      status: () => ({ runtime: { project_root: rootA } }),
      handleRequest: jest.fn(),
    };
    const daemon = new GlobalDaemon({
      controllerRoot,
      topology: "hybrid",
      startProjectRuntime: (options) => {
        if (options.projectRoot === fs.realpathSync(controllerRoot)) return fakeController;
        starts += 1;
        return fakeProject;
      },
      loadProjectConfig: () => ({
        agentProvider: "codex-cli",
        agentModel: "",
      }),
    });

    try {
      daemon.start();
      const [first, second] = await Promise.all([
        daemon.activateProject(rootA),
        daemon.activateProject(rootA),
      ]);
      expect(first).toBe(fakeProject);
      expect(second).toBe(fakeProject);
      expect(starts).toBe(1);
    } finally {
      daemon.stop("test");
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  });

  test("suspends an idle hosted runtime and lazily restores its compatibility socket", async () => {
    const controllerRoot = initializeProject("controller-idle");
    const rootA = initializeProject("idle");
    const daemon = new GlobalDaemon({
      controllerRoot,
      topology: "hybrid",
      idleGraceMs: 0,
      sweepIntervalMs: 0,
    });

    try {
      daemon.start({ resumeMode: "none" });
      await waitForSocket(daemon.controller.socket_path);
      await requestStatus(daemon.controller.socket_path, rootA);
      const compatibilitySocket = getUfooPaths(rootA).ufooSock;
      expect(fs.existsSync(compatibilitySocket)).toBe(true);

      expect(await daemon.runtimeManager.sweepIdle()).toBe(1);
      expect(fs.existsSync(compatibilitySocket)).toBe(false);
      expect(daemon.status().runtimes[0].state).toBe("dormant");

      const restored = await requestStatus(daemon.controller.socket_path, rootA);
      expect(restored.runtime.state).toBe("active");
      expect(fs.existsSync(compatibilitySocket)).toBe(true);
    } finally {
      daemon.stop("test");
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  }, 10000);

  test("global topology creates no project PID, lock, or compatibility socket", async () => {
    const controllerRoot = initializeProject("controller-final");
    const rootA = initializeProject("final");
    const daemon = new GlobalDaemon({
      controllerRoot,
      topology: "global",
      sweepIntervalMs: 0,
    });

    try {
      daemon.start({ resumeMode: "none" });
      await waitForSocket(daemon.controller.socket_path);
      const status = await requestStatus(daemon.controller.socket_path, rootA);
      expect(status.runtime).toMatchObject({
        project_root: rootA,
        topology: "global",
        state: "active",
      });
      expect(fs.existsSync(getUfooPaths(rootA).ufooSock)).toBe(false);
      expect(fs.existsSync(getUfooPaths(rootA).ufooDaemonPid)).toBe(false);
      expect(fs.existsSync(path.join(getUfooPaths(rootA).runDir, "daemon.lock"))).toBe(false);

      const agents = await daemon.projectRuntimeGateway.call(
        rootA,
        "list_agents",
        {},
        { toolCallId: "shared-manager-test" }
      );
      expect(agents).toBeTruthy();
      expect(daemon.projectRuntimeGateway.status().runtime_count).toBe(1);
      expect(daemon.status().runtime_count).toBe(1);

      const closed = await requestResponse(daemon.controller.socket_path, {
        type: "close_project_runtime",
        project_root: rootA,
        terminate_agents: false,
      });
      expect(closed).toMatchObject({
        ok: true,
        project_root: rootA,
        runtime_removed: true,
      });
      expect(daemon.status().runtime_count).toBe(0);
    } finally {
      daemon.stop("test");
      fs.rmSync(controllerRoot, { recursive: true, force: true });
      fs.rmSync(rootA, { recursive: true, force: true });
    }
  }, 10000);
});
