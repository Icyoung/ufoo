"use strict";

const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");

const { startDaemon } = require("../../../src/runtime/daemon");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function initializeProject() {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/ufoo-runner-retain-"));
  const paths = getUfooPaths(root);
  for (const dir of [
    paths.busQueuesDir,
    paths.busEventsDir,
    paths.busLogsDir,
    paths.busOffsetsDir,
    paths.agentDir,
    paths.runDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
      const ok = await new Promise((resolve) => {
        const socket = net.createConnection(sockPath);
        socket.once("connect", () => {
          socket.end();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      });
      if (ok) return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`socket did not become ready: ${sockPath}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("global daemon runner retention", () => {
  test("daemon replacement detaches a managed runner and the next runtime sees it as active", async () => {
    const projectRoot = initializeProject();
    const paths = getUfooPaths(projectRoot);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    let first;
    let second;
    try {
      first = startDaemon({
        projectRoot,
        provider: "codex-cli",
        model: "",
        resumeMode: "none",
        daemonTopology: "global",
      });
      await waitForSocket(first.socket_path);
      first.runtime.resource("processManager").register("codex:retained", child);
      fs.writeFileSync(paths.agentsFile, JSON.stringify({
        created_at: new Date().toISOString(),
        agents: {
          "codex:retained": {
            agent_type: "codex",
            nickname: "retained",
            status: "active",
            launch_mode: "internal",
            joined_at: new Date().toISOString(),
            last_seen: new Date().toISOString(),
            pid: child.pid,
          },
        },
      }, null, 2));

      first.cleanup("replace-global-daemon");
      first = null;
      expect(pidAlive(child.pid)).toBe(true);

      second = startDaemon({
        projectRoot,
        provider: "codex-cli",
        model: "",
        resumeMode: "none",
        daemonTopology: "global",
      });
      await waitForSocket(second.socket_path);
      expect(second.status().active).toContain("codex:retained");
      expect(pidAlive(child.pid)).toBe(true);
    } finally {
      if (first) first.cleanup("test-finally-first");
      if (second) second.cleanup("test-finally-second");
      if (child.pid && pidAlive(child.pid)) process.kill(child.pid, "SIGTERM");
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 10000);
});
