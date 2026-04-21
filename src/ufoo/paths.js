const path = require("path");

function getUfooPaths(projectRoot) {
  const ufooDir = path.join(projectRoot, ".ufoo");
  const busDir = path.join(ufooDir, "bus");
  const agentDir = path.join(ufooDir, "agent");
  const memoryDir = path.join(ufooDir, "memory");
  const agentsFile = path.join(agentDir, "all-agents.json");
  const memoryFile = path.join(memoryDir, "memory.jsonl");

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
  const historyDir = path.join(ufooDir, "history");
  const ufooDaemonPid = path.join(runDir, "ufoo-daemon.pid");
  const ufooDaemonLog = path.join(runDir, "ufoo-daemon.log");
  const ufooSock = path.join(runDir, "ufoo.sock");

  return {
    ufooDir,
    busDir,
    agentDir,
    memoryDir,
    agentsFile,
    memoryFile,
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
    historyDir,
    ufooDaemonPid,
    ufooDaemonLog,
    ufooSock,
  };
}

module.exports = {
  getUfooPaths,
};
