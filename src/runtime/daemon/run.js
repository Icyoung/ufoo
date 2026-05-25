const path = require("path");
const { startDaemon, stopDaemon, isRunning } = require("./index");
const { restartDaemonLifecycleSync } = require("./restart");
const { loadConfig, defaultAgentModelForProvider } = require("../../config");
const { resolveNodeExecutable } = require("../process/nodeExecutable");

function spawnDaemonStart(projectRoot) {
  const { spawn } = require("child_process");
  const child = spawn(resolveNodeExecutable(), [path.join(__dirname, "..", "..", "..", "bin", "ufoo.js"), "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, UFOO_DAEMON_CHILD: "1" },
    cwd: projectRoot,
  });
  child.unref();
  return child;
}

function sleepSync(ms) {
  require("child_process").spawnSync("sleep", [String(ms / 1000)]);
}

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
      spawnDaemonStart(projectRoot);
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
    const result = restartDaemonLifecycleSync({
      projectRoot,
      isRunning,
      stopDaemon,
      startDaemon: () => {
        if (!process.env.UFOO_DAEMON_CHILD) return spawnDaemonStart(projectRoot);
        // Manual restart does not auto-resume; crash-recovery is handled on next auto start with stale lock detection.
        return startDaemon({ projectRoot, provider, model, resumeMode: "none" });
      },
      stopOptions: { source: process.env.UFOO_DAEMON_STOP_SOURCE || `daemon-cli:${cmd} pid=${process.pid}` },
      sleepSync,
    });
    if (!result.ok) process.exitCode = 1;
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
