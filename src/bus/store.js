"use strict";

const fs = require("fs");
const path = require("path");
const { getTimestamp, ensureDir, safeNameToSubscriber, getTtyProcessInfo } = require("./utils");
const { getUfooPaths } = require("../ufoo/paths");
const { loadAgentsData, saveAgentsData } = require("../ufoo/agentsStore");

function readQueueTty(queueDir) {
  try {
    const value = fs.readFileSync(path.join(queueDir, "tty"), "utf8").trim();
    return value || "";
  } catch {
    return "";
  }
}

function buildUsedNicknameSet(agents = {}) {
  const set = new Set();
  for (const meta of Object.values(agents || {})) {
    if (!meta || meta.status !== "active") continue;
    const nick = meta && typeof meta.nickname === "string" ? meta.nickname : "";
    if (nick) set.add(nick);
  }
  return set;
}

function recoverQueueEntry(data, subscriber, queueDir, usedNicknames, now) {
  if (!subscriber || data.agents[subscriber]) return false;

  if (subscriber === "ufoo-agent") {
    const tty = readQueueTty(queueDir);
    const ttyInfo = tty ? getTtyProcessInfo(tty) : null;
    data.agents[subscriber] = {
      agent_type: "ufoo-agent",
      nickname: "ufoo-agent",
      status: "active",
      joined_at: now,
      last_seen: now,
      pid: 0,
      tty,
      tty_shell_pid: ttyInfo && ttyInfo.shellPid ? ttyInfo.shellPid : 0,
      tmux_pane: "",
      launch_mode: "",
    };
    return true;
  }
  return false;
}

function reconcileReservedControllerAliases(data, now) {
  if (!data.agents || !data.agents["ufoo-agent"]) return false;

  let changed = false;
  for (const [id, meta] of Object.entries(data.agents)) {
    if (!id.startsWith("ufoo-agent:")) continue;
    if (!meta || meta.status !== "active") continue;
    if (String(meta.agent_type || "").trim() !== "ufoo-agent") continue;
    const hasRuntimeBinding = Boolean(
      meta.tty
      || meta.tmux_pane
      || meta.host_inject_sock
      || meta.host_daemon_sock
    );
    if (hasRuntimeBinding) continue;
    meta.status = "inactive";
    meta.last_seen = now;
    changed = true;
  }
  return changed;
}

class BusStore {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.paths = getUfooPaths(projectRoot);
    this.busDir = this.paths.busDir;
    this.agentsFile = this.paths.agentsFile;
    this.eventsDir = this.paths.busEventsDir;
    this.logsDir = this.paths.busLogsDir;
  }

  ensure() {
    if (!fs.existsSync(this.busDir) || !fs.existsSync(this.paths.agentDir)) {
      throw new Error(
        "Event bus not initialized. Please run: ufoo bus init or /uinit"
      );
    }
  }

  load() {
    const data = loadAgentsData(this.agentsFile);
    if (!data.agents || typeof data.agents !== "object") {
      data.agents = {};
    }

    const queueRoot = path.join(this.busDir, "queues");
    if (!fs.existsSync(queueRoot)) return data;

    const usedNicknames = buildUsedNicknameSet(data.agents);
    const now = getTimestamp();
    let recovered = false;

    for (const entry of fs.readdirSync(queueRoot)) {
      const queueDir = path.join(queueRoot, entry);
      let stat;
      try {
        stat = fs.statSync(queueDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const subscriber = safeNameToSubscriber(entry);
      recovered = recoverQueueEntry(data, subscriber, queueDir, usedNicknames, now) || recovered;
    }

    recovered = reconcileReservedControllerAliases(data, now) || recovered;

    if (recovered) {
      saveAgentsData(this.agentsFile, data);
    }
    return data;
  }

  save(busData) {
    if (busData) {
      saveAgentsData(this.agentsFile, busData);
    }
  }

  init() {
    ensureDir(this.busDir);
    ensureDir(this.paths.agentDir);
    ensureDir(this.eventsDir);
    ensureDir(path.join(this.busDir, "queues"));
    ensureDir(this.logsDir);
    ensureDir(path.join(this.busDir, "offsets"));
    ensureDir(this.paths.busDaemonDir);
    ensureDir(this.paths.busDaemonCountsDir);

    if (!fs.existsSync(this.agentsFile)) {
      const busData = {
        created_at: getTimestamp(),
        agents: {},
      };
      saveAgentsData(this.agentsFile, busData);
    }
  }

  getCurrentSubscriber(busData) {
    if (process.env.UFOO_SUBSCRIBER_ID) {
      return process.env.UFOO_SUBSCRIBER_ID;
    }

    if (!fs.existsSync(this.agentsFile)) {
      return null;
    }

    const sessionFile = path.join(this.paths.agentDir, "session.txt");
    if (fs.existsSync(sessionFile)) {
      const sessionId = fs.readFileSync(sessionFile, "utf8").trim();
      if (sessionId) {
        return sessionId;
      }
    }

    let currentTty = null;
    try {
      const ttyPath = fs.realpathSync("/dev/tty");
      if (ttyPath && ttyPath.startsWith("/dev/")) {
        currentTty = ttyPath;
      }
    } catch {
      // tty not available
    }

    if (currentTty && busData && busData.agents) {
      for (const [id, meta] of Object.entries(busData.agents)) {
        if (meta.tty === currentTty) {
          return id;
        }
      }
    }

    return null;
  }
}

module.exports = { BusStore };
