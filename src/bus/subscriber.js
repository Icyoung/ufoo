const fs = require("fs");
const { getTimestamp, isAgentPidAlive, isValidTty } = require("./utils");
const NicknameManager = require("./nickname");
const { spawnSync } = require("child_process");

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
    if (!this.busData.subscribers) return;

    const entries = Object.entries(this.busData.subscribers);
    for (const [id, meta] of entries) {
      if (id === currentSubscriber) continue;
      const metaTtyRaw = meta?.tty || "";
      const metaTty = isValidTty(metaTtyRaw)
        ? metaTtyRaw
        : (await this.queueManager.readTty(id));
      if (!metaTty) continue;
      if (metaTty === ttyPath) {
        // Remove stale subscriber using same tty
        delete this.busData.subscribers[id];
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
  async join(sessionId, agentType, nickname = null) {
    // Special case: ufoo-agent uses fixed ID without suffix
    const subscriber = (agentType === "ufoo-agent" && sessionId === "ufoo-agent")
      ? "ufoo-agent"
      : `${agentType}:${sessionId}`;

    if (!this.busData.subscribers) {
      this.busData.subscribers = {};
    }

    const nicknameManager = new NicknameManager(this.busData);

    // 检查是否是重新加入（rejoin）
    const existingMeta = this.busData.subscribers[subscriber];
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
      // 自动生成昵称
      finalNickname = nicknameManager.generateAutoNickname(agentType);
    }

    const launchMode = process.env.UFOO_LAUNCH_MODE || "";
    const detectedTty = getTtyPath();
    const tty = isValidTty(detectedTty) ? detectedTty : "";
    const preservedTty = !tty && launchMode !== "internal" && isValidTty(existingMeta?.tty)
      ? existingMeta.tty
      : "";
    const finalTty = tty || preservedTty;

    // 清理同一 tty 的旧订阅者（避免重复启动污染）
    await this.cleanupDuplicateTty(subscriber, finalTty);

    // 更新订阅者信息
    this.busData.subscribers[subscriber] = {
      agent_type: agentType,
      nickname: finalNickname,
      status: "active",
      joined_at: existingMeta?.joined_at || getTimestamp(),
      last_seen: getTimestamp(),
      pid: getJoinedPid(),
      tty: finalTty,
      tmux_pane: process.env.TMUX_PANE || "",
      launch_mode: launchMode,
    };

    // 保存 tty 信息
    if (this.busData.subscribers[subscriber].tty) {
      await this.queueManager.saveTty(
        subscriber,
        this.busData.subscribers[subscriber].tty
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
    if (!this.busData.subscribers || !this.busData.subscribers[subscriber]) {
      return false;
    }

    this.busData.subscribers[subscriber].status = "inactive";
    this.busData.subscribers[subscriber].last_seen = getTimestamp();

    return true;
  }

  /**
   * 重命名订阅者
   */
  async rename(subscriber, newNickname) {
    if (!this.busData.subscribers || !this.busData.subscribers[subscriber]) {
      throw new Error(`Subscriber "${subscriber}" not found`);
    }

    const nicknameManager = new NicknameManager(this.busData);

    // 检查昵称冲突
    if (nicknameManager.nicknameExists(newNickname, subscriber)) {
      throw new Error(`Nickname "${newNickname}" already exists`);
    }

    const oldNickname = this.busData.subscribers[subscriber].nickname;
    this.busData.subscribers[subscriber].nickname = newNickname;

    return { subscriber, oldNickname, newNickname };
  }

  /**
   * 获取所有在线订阅者
   */
  getActiveSubscribers() {
    if (!this.busData.subscribers) return [];

    return Object.entries(this.busData.subscribers)
      .filter(([, meta]) => {
        // 检查状态和进程是否存活
        return meta.status === "active" && (!meta.pid || isAgentPidAlive(meta.pid));
      })
      .map(([id, meta]) => ({ id, ...meta }));
  }

  /**
   * 获取订阅者信息
   */
  getSubscriber(subscriber) {
    return this.busData.subscribers?.[subscriber] || null;
  }

  /**
   * 更新订阅者的最后活动时间
   */
  updateLastSeen(subscriber) {
    if (this.busData.subscribers && this.busData.subscribers[subscriber]) {
      this.busData.subscribers[subscriber].last_seen = getTimestamp();
    }
  }

  /**
   * 清理不活跃的订阅者
   */
  cleanupInactive() {
    if (!this.busData.subscribers) return;

    for (const [id, meta] of Object.entries(this.busData.subscribers)) {
      // 如果有 PID，检查进程是否存活
      if (meta.pid && !isAgentPidAlive(meta.pid) && meta.status === "active") {
        meta.status = "inactive";
        meta.last_seen = getTimestamp();
      }
    }
  }
}

module.exports = SubscriberManager;
