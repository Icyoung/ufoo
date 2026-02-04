const path = require("path");
const { startDaemon, stopDaemon, isRunning } = require("./index");
const { loadConfig } = require("../config");

function runDaemonCli(argv) {
  const cmd = argv[1] || "start";
  const projectRoot = process.cwd();
  const config = loadConfig(projectRoot);
  const provider = process.env.UFOO_AGENT_PROVIDER || config.agentProvider || "codex-cli";
  const model =
    process.env.UFOO_AGENT_MODEL || config.agentModel || (provider === "claude-cli" ? "opus" : "");

  if (cmd === "start" || cmd === "--start") {
    if (isRunning(projectRoot)) return;
    if (!process.env.UFOO_DAEMON_CHILD) {
      const { spawn } = require("child_process");
      const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "bin", "ufoo.js"), "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, UFOO_DAEMON_CHILD: "1" },
        cwd: projectRoot,
      });
      child.unref();
      return;
    }
    startDaemon({ projectRoot, provider, model });
    return;
  }
  if (cmd === "stop" || cmd === "--stop") {
    stopDaemon(projectRoot);
    return;
  }
  if (cmd === "restart" || cmd === "--restart") {
    // Stop if running
    if (isRunning(projectRoot)) {
      stopDaemon(projectRoot);
      // Wait for clean shutdown
      let attempts = 0;
      while (isRunning(projectRoot) && attempts < 50) {
        attempts++;
        require("child_process").spawnSync("sleep", ["0.1"]);
      }
    }
    // Start fresh daemon
    if (!process.env.UFOO_DAEMON_CHILD) {
      const { spawn } = require("child_process");
      const child = spawn(process.execPath, [path.join(__dirname, "..", "..", "bin", "ufoo.js"), "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, UFOO_DAEMON_CHILD: "1" },
        cwd: projectRoot,
      });
      child.unref();
      return;
    }
    startDaemon({ projectRoot, provider, model });
    return;
  }
  if (cmd === "status" || cmd === "--status") {
    const running = isRunning(projectRoot);
    // eslint-disable-next-line no-console
    console.log(running ? "running" : "stopped");
    return;
  }

  throw new Error(`Unknown daemon command: ${cmd}`);
}

module.exports = { runDaemonCli };
