const path = require("path");
const fs = require("fs");
const { startDaemon, stopDaemon, isRunning } = require("./index");
const { startGlobalDaemon } = require("./globalDaemon");
const { restartDaemonLifecycleSync } = require("./restart");
const {
  loadConfig,
  defaultAgentModelForProvider,
  normalizeDaemonTopology,
  saveGlobalDaemonConfig,
} = require("../../config");
const { resolveNodeExecutable } = require("../process/nodeExecutable");
const {
  isGlobalControllerProjectRoot,
  resolveGlobalControllerProjectRoot,
} = require("../projects");
const { getUfooPaths } = require("../../coordination/state/paths");

function spawnDaemonStart(projectRoot, daemonTopology = "") {
  const { spawn } = require("child_process");
  const child = spawn(resolveNodeExecutable(), [path.join(__dirname, "..", "..", "..", "bin", "ufoo.js"), "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      UFOO_DAEMON_CHILD: "1",
      ...(daemonTopology ? { UFOO_DAEMON_TOPOLOGY: daemonTopology } : {}),
    },
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
  if (cmd === "topology" || cmd === "--topology") {
    const requested = String(argv[2] || "").trim().toLowerCase();
    if (!["project", "hybrid", "global"].includes(requested)) {
      throw new Error("daemon topology requires project|hybrid|global");
    }
    const saved = saveGlobalDaemonConfig({ daemonTopology: requested });
    // eslint-disable-next-line no-console
    console.log(saved.daemonTopology);
    return;
  }
  const projectRoot = process.cwd();
  const config = loadConfig(projectRoot);
  const daemonTopology = normalizeDaemonTopology(
    process.env.UFOO_DAEMON_TOPOLOGY || config.daemonTopology
  );
  const daemonRoot = daemonTopology === "project"
    ? projectRoot
    : resolveGlobalControllerProjectRoot();
  if (daemonTopology !== "project") {
    fs.mkdirSync(getUfooPaths(daemonRoot).ufooDir, { recursive: true });
  }
  const envProvider = process.env.UFOO_AGENT_PROVIDER;
  const provider = envProvider || config.agentProvider || "codex-cli";
  const model =
    process.env.UFOO_AGENT_MODEL
    || (envProvider && envProvider !== config.agentProvider ? "" : config.agentModel)
    || defaultAgentModelForProvider(provider);
  const resumeMode = process.env.UFOO_FORCE_RESUME === "1" ? "force" : "auto";
  const useGlobalRuntimeHost =
    isGlobalControllerProjectRoot(daemonRoot)
    && daemonTopology !== "project";
  const startSelectedDaemon = (selectedResumeMode) => {
    if (useGlobalRuntimeHost) {
      return startGlobalDaemon({
        controllerRoot: daemonRoot,
        provider,
        model,
        resumeMode: selectedResumeMode,
        topology: daemonTopology,
      });
    }
    return startDaemon({
      projectRoot: daemonRoot,
      provider,
      model,
      resumeMode: selectedResumeMode,
    });
  };

  if (cmd === "start" || cmd === "--start") {
    if (isRunning(daemonRoot)) return;
    if (!process.env.UFOO_DAEMON_CHILD) {
      spawnDaemonStart(daemonRoot, daemonTopology);
      return;
    }
    startSelectedDaemon(resumeMode);
    return;
  }
  if (cmd === "stop" || cmd === "--stop") {
    if (!stopDaemon(daemonRoot, { source: process.env.UFOO_DAEMON_STOP_SOURCE || `daemon-cli:${cmd} pid=${process.pid}` })) {
      process.exitCode = 1;
    }
    return;
  }
  if (cmd === "restart" || cmd === "--restart") {
    const result = restartDaemonLifecycleSync({
      projectRoot: daemonRoot,
      isRunning,
      stopDaemon,
      startDaemon: () => {
        if (!process.env.UFOO_DAEMON_CHILD) return spawnDaemonStart(daemonRoot, daemonTopology);
        // Manual restart does not auto-resume; crash-recovery is handled on next auto start with stale lock detection.
        return startSelectedDaemon("none");
      },
      stopOptions: { source: process.env.UFOO_DAEMON_STOP_SOURCE || `daemon-cli:${cmd} pid=${process.pid}` },
      sleepSync,
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "status" || cmd === "--status") {
    const running = isRunning(daemonRoot);
    // eslint-disable-next-line no-console
    console.log(running ? "running" : "stopped");
    return;
  }

  throw new Error(`Unknown daemon command: ${cmd}`);
}

module.exports = { runDaemonCli };
