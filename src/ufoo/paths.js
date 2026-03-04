const path = require("path");

function getUfooPaths(projectRoot) {
  const ufooDir = path.join(projectRoot, ".ufoo");
  const busDir = path.join(ufooDir, "bus");
  const agentDir = path.join(ufooDir, "agent");
  const agentsFile = path.join(agentDir, "all-agents.json");

  const busQueuesDir = path.join(busDir, "queues");
  const busEventsDir = path.join(busDir, "events");
  const busLogsDir = path.join(busDir, "logs");
  const busOffsetsDir = path.join(busDir, "offsets");

  const busDaemonDir = path.join(ufooDir, "daemon");
  const busDaemonPid = path.join(busDaemonDir, "daemon.pid");
  const busDaemonLog = path.join(busDaemonDir, "daemon.log");
  const busDaemonCountsDir = path.join(busDaemonDir, "counts");

  const runDir = path.join(ufooDir, "run");
  const groupsDir = path.join(ufooDir, "groups");
  const ufooDaemonPid = path.join(runDir, "ufoo-daemon.pid");
  const ufooDaemonLog = path.join(runDir, "ufoo-daemon.log");
  const ufooSock = path.join(runDir, "ufoo.sock");

  return {
    ufooDir,
    busDir,
    agentDir,
    agentsFile,
    busQueuesDir,
    busEventsDir,
    busLogsDir,
    busOffsetsDir,
    busDaemonDir,
    busDaemonPid,
    busDaemonLog,
    busDaemonCountsDir,
    runDir,
    groupsDir,
    ufooDaemonPid,
    ufooDaemonLog,
    ufooSock,
  };
}

module.exports = {
  getUfooPaths,
};
