const path = require("path");
const { startDaemon, stopDaemon, isRunning } = require("./index");
const { loadConfig, defaultAgentModelForProvider } = require("../config");
const { resolveNodeExecutable } = require("../utils/nodeExecutable");

function runDaemonCli(argv) {
  const cmd = argv[1] || "start";
  const projectRoot = process.cwd();
  const config = loadConfig(projectRoot);
  const envProvider = process.env.UFOO_AGENT_PROVIDER;
  const provider = envProvider || config.agentProvider || "codex-cli";
  const model =
    process.env.UFOO_AGENT_MODEL
    || (envProvider && envProvider !== config.agentProvider ? "" : config.agentModel)
    || defaultAgentModelForProvider(provider);
  const resumeMode = process.env.UFOO_FORCE_RESUME === "1" ? "force" : "auto";
  const launchMode = config.launchMode || "terminal";

  if (cmd === "start" || cmd === "--start") {
    if (isRunning(projectRoot)) return;
    if (!process.env.UFOO_DAEMON_CHILD) {
      const { spawn } = require("child_process");
      const child = spawn(resolveNodeExecutable(), [path.join(__dirname, "..", "..", "bin", "ufoo.js"), "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, UFOO_DAEMON_CHILD: "1" },
        cwd: projectRoot,
      });
      child.unref();
      return;
    }
    startDaemon({ projectRoot, provider, model, resumeMode });
    return;
  }
  if (cmd === "stop" || cmd === "--stop") {
    if (!stopDaemon(projectRoot, { source: process.env.UFOO_DAEMON_STOP_SOURCE || `daemon-cli:${cmd} pid=${process.pid}` })) {
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "restart" || cmd === "--restart") {
    // Stop if running
    if (isRunning(projectRoot)) {
      const stopped = stopDaemon(projectRoot, { source: process.env.UFOO_DAEMON_STOP_SOURCE || `daemon-cli:${cmd} pid=${process.pid}` });
      // Wait for clean shutdown
      let attempts = 0;
      while (isRunning(projectRoot) && attempts < 50) {
        attempts++;
        require("child_process").spawnSync("sleep", ["0.1"]);
      }
      if (!stopped && isRunning(projectRoot)) {
        process.exitCode = 1;
        return;
      }
    }
    // Start fresh daemon
    if (!process.env.UFOO_DAEMON_CHILD) {
      const { spawn } = require("child_process");
      const childEnv = { ...process.env, UFOO_DAEMON_CHILD: "1" };
      const child = spawn(resolveNodeExecutable(), [path.join(__dirname, "..", "..", "bin", "ufoo.js"), "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: childEnv,
        cwd: projectRoot,
      });
      child.unref();
      return;
    }
    // Manual restart does not auto-resume; crash-recovery is handled on next auto start with stale lock detection.
    startDaemon({ projectRoot, provider, model, resumeMode: "none" });
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
