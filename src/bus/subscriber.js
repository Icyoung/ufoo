const fs = require("fs");
const { getTimestamp, isAgentPidAlive, isMetaActive, isValidTty, getTtyProcessInfo } = require("./utils");
const NicknameManager = require("./nickname");
const { spawnSync } = require("child_process");

function detectTerminalAppFromEnv() {
  const termProgram = process.env.TERM_PROGRAM || "";
  if (process.env.ITERM_SESSION_ID || termProgram === "iTerm.app") return "iterm2";
  if (termProgram === "Apple_Terminal") return "terminal";
  return termProgram || "";
}

/**
 * 获取当前终端的 tty 路径
 */
function resolveTtyFromPath(fdPath) {
  try {
    const real = fs.realpathSync(fdPath);
    if (real && real.startsWith("/dev/")) {
      return real;
    }
  } catch {
    // ignore
  }
  return "";
}

function normalizeTty(ttyPath) {
  if (!ttyPath) return "";
  const trimmed = String(ttyPath).trim();
  if (!trimmed || trimmed === "not a tty") return "";
  if (trimmed === "/dev/tty") return "";
  return trimmed;
}

function tryTtyWithStdin(fd) {
  try {
    const res = spawnSync("tty", {
      stdio: [fd, "pipe", "ignore"],
      encoding: "utf8",
    });
    if (res && res.status === 0) {
      const out = normalizeTty(res.stdout || "");
      if (out) return out;
    }
  } catch {
    // ignore
  }
  return "";
}

function getTtyPath() {
  // 0) Honor explicit ttyPath from node stdio if present (useful for tests)
  const stdinTtyPath = normalizeTty(process.stdin?.ttyPath || "");
  if (stdinTtyPath) return stdinTtyPath;

  // 1) Try stdin directly (inherits real tty if present)
  let ttyPath = tryTtyWithStdin(0);
  if (ttyPath) return ttyPath;

  // 2) Try controlling tty explicitly (works even if stdin is detached)
  try {
    const fd = fs.openSync("/dev/tty", "r");
    ttyPath = tryTtyWithStdin(fd);
    fs.closeSync(fd);
    if (ttyPath) return ttyPath;
  } catch {
    // ignore
  }

  // 3) Fallback to stdout/stderr device paths
  if (process.stdout.isTTY) {
    ttyPath = normalizeTty(resolveTtyFromPath("/dev/stdout"));
    if (ttyPath) return ttyPath;
  }
  if (process.stderr.isTTY) {
    ttyPath = normalizeTty(resolveTtyFromPath("/dev/stderr"));
    if (ttyPath) return ttyPath;
  }

  // Final fallback to controlling tty path (may be /dev/tty)
  return normalizeTty(resolveTtyFromPath("/dev/tty"));
}

function getJoinedPid() {
  const raw = process.env.UFOO_PARENT_PID || "";
  const parsed = parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return process.pid;
}

/**
 * 订阅者管理
 */
class SubscriberManager {
  constructor(busData, queueManager) {
    this.busData = busData;
    this.queueManager = queueManager;
  }

  async cleanupDuplicateTty(currentSubscriber, ttyPath) {
    if (!ttyPath) return;
    if (!this.busData.agents) return;

    const entries = Object.entries(this.busData.agents);
    for (const [id, meta] of entries) {
      if (id === currentSubscriber) continue;
      const metaTtyRaw = meta?.tty || "";
      const metaTty = isValidTty(metaTtyRaw)
        ? metaTtyRaw
        : (await this.queueManager.readTty(id));
      if (!metaTty) continue;
      if (metaTty === ttyPath) {
        // Remove stale subscriber using same tty
        delete this.busData.agents[id];
        try {
          const queueDir = this.queueManager.getQueueDir(id);
          if (queueDir) {
            fs.rmSync(queueDir, { recursive: true, force: true });
          }
          const offsetPath = this.queueManager.getOffsetPath(id);
          if (offsetPath) fs.rmSync(offsetPath, { force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  /**
   * 加入总线
   */
  async join(sessionId, agentType, nickname = null, options = {}) {
    // Special case: ufoo-agent uses fixed ID without suffix
    const subscriber = (sessionId === "ufoo-agent")
      ? "ufoo-agent"
      : `${agentType}:${sessionId}`;

    if (!this.busData.agents) {
      this.busData.agents = {};
    }

    const nicknameManager = new NicknameManager(this.busData);

    // 检查是否是重新加入（rejoin）
    const existingMeta = this.busData.agents[subscriber];
    let finalNickname = nickname;

    if (existingMeta && existingMeta.nickname) {
      // 重新加入，保留原昵称
      finalNickname = existingMeta.nickname;
    } else if (nickname) {
      // 新昵称，检查冲突
      if (nicknameManager.nicknameExists(nickname, subscriber)) {
        throw new Error(`Nickname "${nickname}" already exists`);
      }
      finalNickname = nickname;
    } else {
      // 自动生成昵称（并标记占用，避免并发重复）
      finalNickname = nicknameManager.generateAutoNickname(agentType);
      nicknameManager.setNickname(subscriber, finalNickname);
    }

    const explicitLaunchMode = typeof options.launchMode === "string"
      ? options.launchMode.trim()
      : "";
    const envLaunchMode = typeof process.env.UFOO_LAUNCH_MODE === "string"
      ? process.env.UFOO_LAUNCH_MODE.trim()
      : "";
    const preservedLaunchMode = existingMeta?.launch_mode || "";
    const inferredLaunchMode = process.env.TMUX_PANE ? "tmux" : "";
    const launchMode = explicitLaunchMode || envLaunchMode || preservedLaunchMode || inferredLaunchMode;
    const overridePid = Number.isFinite(options.parentPid) && options.parentPid > 0
      ? options.parentPid
      : null;
    const hasOverrideTty = Object.prototype.hasOwnProperty.call(options, "tty");
    const overrideTty = (typeof options.tty === "string" && isValidTty(options.tty.trim()))
      ? options.tty.trim()
      : "";
    const detectedTty = hasOverrideTty ? overrideTty : getTtyPath();
    const tty = overrideTty || (isValidTty(detectedTty) ? detectedTty : "");
    const preservedTty = !tty && launchMode !== "internal" && isValidTty(existingMeta?.tty)
      ? existingMeta.tty
      : "";
    const finalTty = tty || preservedTty;
    const ttyInfo = finalTty ? getTtyProcessInfo(finalTty) : null;

    // 清理同一 tty 的旧订阅者（避免重复启动污染）
    await this.cleanupDuplicateTty(subscriber, finalTty);

    // 更新订阅者信息（保留已有字段，如 provider_session_*）
    const preserved = existingMeta && typeof existingMeta === "object"
      ? { ...existingMeta }
      : {};
    const explicitTmuxPane = typeof options.tmuxPane === "string" ? options.tmuxPane.trim() : "";
    const envTmuxPane = typeof process.env.TMUX_PANE === "string" ? process.env.TMUX_PANE.trim() : "";
    const preservedTmuxPane = typeof existingMeta?.tmux_pane === "string" ? existingMeta.tmux_pane.trim() : "";
    const tmuxPane = explicitTmuxPane || envTmuxPane || preservedTmuxPane;

    this.busData.agents[subscriber] = {
      ...preserved,
      agent_type: agentType,
      nickname: finalNickname,
      status: "active",
      joined_at: existingMeta?.joined_at || getTimestamp(),
      last_seen: getTimestamp(),
      pid: overridePid || getJoinedPid(),
      tty: finalTty,
      tty_shell_pid: ttyInfo?.shellPid || 0,
      tmux_pane: tmuxPane,
      launch_mode: launchMode,
    };

    const terminalApp = options.terminalApp || detectTerminalAppFromEnv();
    if (terminalApp) {
      this.busData.agents[subscriber].terminal_app = terminalApp;
    }

    // 如果传入了 providerSessionId（从旧 session 恢复），设置它
    if (options.providerSessionId) {
      this.busData.agents[subscriber].provider_session_id = options.providerSessionId;
    }

    // 保存 tty 信息
    if (this.busData.agents[subscriber].tty) {
      await this.queueManager.saveTty(
        subscriber,
        this.busData.agents[subscriber].tty
      );
    } else {
      // 清理旧 tty 文件，避免错误注入
      try {
        const ttyPath = this.queueManager.getTtyPath(subscriber);
        if (ttyPath && fs.existsSync(ttyPath)) {
          fs.rmSync(ttyPath, { force: true });
        }
      } catch {
        // ignore
      }
    }

    // 创建队列目录
    this.queueManager.ensureQueueDir(subscriber);

    return { subscriber, nickname: finalNickname };
  }

  /**
   * 离开总线
   */
  async leave(subscriber) {
    if (!this.busData.agents || !this.busData.agents[subscriber]) {
      return false;
    }

    this.busData.agents[subscriber].status = "inactive";
    this.busData.agents[subscriber].last_seen = getTimestamp();

    return true;
  }

  /**
   * 重命名订阅者
   */
  async rename(subscriber, newNickname) {
    if (!this.busData.agents || !this.busData.agents[subscriber]) {
      throw new Error(`Subscriber "${subscriber}" not found`);
    }

    const nicknameManager = new NicknameManager(this.busData);

    // 检查昵称冲突
    if (nicknameManager.nicknameExists(newNickname, subscriber)) {
      throw new Error(`Nickname "${newNickname}" already exists`);
    }

    const oldNickname = this.busData.agents[subscriber].nickname;
    this.busData.agents[subscriber].nickname = newNickname;

    return { subscriber, oldNickname, newNickname };
  }

  /**
   * 获取所有在线订阅者
   */
  getActiveSubscribers() {
    if (!this.busData.agents) return [];

    return Object.entries(this.busData.agents)
      .filter(([, meta]) => isMetaActive(meta))
      .map(([id, meta]) => ({ id, ...meta }));
  }

  /**
   * 获取订阅者信息
   */
  getSubscriber(subscriber) {
    return this.busData.agents?.[subscriber] || null;
  }

  /**
   * 更新订阅者的最后活动时间
   */
  updateLastSeen(subscriber) {
    if (this.busData.agents && this.busData.agents[subscriber]) {
      this.busData.agents[subscriber].last_seen = getTimestamp();
    }
  }

  /**
   * 清理不活跃的订阅者
   */
  cleanupInactive() {
    if (!this.busData.agents) return;

    for (const [id, meta] of Object.entries(this.busData.agents)) {
      if (meta.status === "active" && !isMetaActive(meta)) {
        meta.status = "inactive";
        meta.last_seen = getTimestamp();
      }
    }
  }
}

module.exports = SubscriberManager;
