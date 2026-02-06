const fs = require("fs");
const path = require("path");
const { readJSON, writeJSON, isPidAlive, isAgentPidAlive, ensureDir, safeNameToSubscriber, subscriberToSafeName } = require("./utils");
const Injector = require("./inject");
const QueueManager = require("./queue");

/**
 * Bus Daemon - 监控消息并自动注入命令
 */
class BusDaemon {
  constructor(busDir, agentsFile, daemonDir, interval = 2000) {
    this.busDir = busDir;
    this.agentsFile = agentsFile;
    this.interval = interval;
    this.daemonDir = daemonDir;
    this.pidFile = path.join(this.daemonDir, "daemon.pid");
    this.logFile = path.join(this.daemonDir, "daemon.log");
    this.countsDir = path.join(this.daemonDir, "counts", `${process.pid}`);
    this.running = false;
    this.cleanupCounter = 0;
    this.cleanupInterval = 5; // 每 5 个周期清理一次

    this.queueManager = new QueueManager(busDir);
    this.injector = new Injector(busDir, agentsFile);
  }

  /**
   * 检查 daemon 是否正在运行
   */
  isRunning() {
    if (!fs.existsSync(this.pidFile)) {
      return false;
    }

    const pid = parseInt(fs.readFileSync(this.pidFile, "utf8").trim(), 10);
    return isPidAlive(pid);
  }

  /**
   * 获取运行中的 daemon PID
   */
  getRunningPid() {
    if (!fs.existsSync(this.pidFile)) {
      return null;
    }

    const pid = parseInt(fs.readFileSync(this.pidFile, "utf8").trim(), 10);
    return isPidAlive(pid) ? pid : null;
  }

  /**
   * 启动 daemon
   */
  async start(background = false) {
    // 检查是否已经在运行
    if (this.isRunning()) {
      const pid = this.getRunningPid();
      console.log(`[daemon] Already running (pid=${pid})`);
      return;
    }
    ensureDir(this.daemonDir);
    ensureDir(path.join(this.daemonDir, "counts"));

    if (background) {
      // 后台模式：spawn 独立进程
      const { spawn } = require("child_process");
      const logStream = fs.openSync(this.logFile, "a");

      const child = spawn(
        process.execPath,
        [
          path.join(__dirname, "..", "..", "bin", "ufoo.js"),
          "bus",
          "daemon",
          "--interval",
          String(this.interval / 1000),
        ],
        {
          detached: true,
          stdio: ["ignore", logStream, logStream],
          cwd: process.cwd(),
        }
      );

      child.unref();

      // 等待 PID 文件创建
      await new Promise((resolve) => setTimeout(resolve, 500));

      const pid = this.getRunningPid();
      console.log(`[daemon] Started in background (pid=${pid}, log: ${this.logFile})`);
    } else {
      // 前台模式
      this.run();
    }
  }

  /**
   * 停止 daemon
   */
  stop() {
    const pid = this.getRunningPid();
    if (!pid) {
      console.log("[daemon] Not running");
      return;
    }

    try {
      process.kill(pid, "SIGTERM");
      console.log(`[daemon] Stopped (pid=${pid})`);
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch (err) {
      console.error(`[daemon] Failed to stop: ${err.message}`);
    }
  }

  /**
   * 显示 daemon 状态
   */
  status() {
    const pid = this.getRunningPid();
    if (pid) {
      console.log(`[daemon] Running (pid=${pid})`);
    } else {
      console.log("[daemon] Not running");
      // 清理过时的 PID 文件
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    }
  }

  /**
   * 运行 daemon（前台）
   */
  run() {
    // 记录 PID
    ensureDir(path.dirname(this.pidFile));
    fs.writeFileSync(this.pidFile, `${process.pid}\n`, "utf8");

    // 设置清理钩子
    const cleanup = () => {
      this.running = false;
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
      if (fs.existsSync(this.countsDir)) {
        fs.rmSync(this.countsDir, { recursive: true, force: true });
      }
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    process.on("exit", cleanup);

    // 创建计数目录
    ensureDir(this.countsDir);

    console.log(`[daemon] Started (pid=${process.pid}, interval=${this.interval / 1000}s)`);
    console.log(`[daemon] Watching: ${this.busDir}/queues/*/pending.jsonl`);

    this.running = true;
    this.watchLoop();
  }

  /**
   * 主监控循环
   */
  async watchLoop() {
    while (this.running) {
      try {
        // 定期清理死掉的 agent
        this.cleanupCounter++;
        if (this.cleanupCounter >= this.cleanupInterval) {
          await this.cleanupDeadAgents();
          this.cleanupCounter = 0;
        }

        // 检查所有订阅者的队列
        await this.checkQueues();
      } catch (err) {
        console.error(`[daemon] Error: ${err.message}`);
      }

      // 等待下一个周期
      await new Promise((resolve) => setTimeout(resolve, this.interval));
    }
  }

  /**
   * 检查所有队列
   */
  async checkQueues() {
    const queuesDir = path.join(this.busDir, "queues");
    if (!fs.existsSync(queuesDir)) {
      return;
    }

    const subscribers = fs.readdirSync(queuesDir);

    for (const safeName of subscribers) {
      const pendingFile = path.join(queuesDir, safeName, "pending.jsonl");
      if (!fs.existsSync(pendingFile)) {
        continue;
      }

      // 获取当前消息数
      let count = 0;
      if (fs.statSync(pendingFile).size > 0) {
        const content = fs.readFileSync(pendingFile, "utf8").trim();
        count = content ? content.split("\n").length : 0;
      }

      // 获取上次的消息数
      const lastCount = this.getLastCount(safeName);

      // 如果有新消息，注入命令
      const wakePath = path.join(queuesDir, safeName, "wake");
      const wakeActive = fs.existsSync(wakePath);

      if (count > lastCount || wakeActive) {
        const subscriber = safeNameToSubscriber(safeName);
        const now = new Date().toISOString().split("T")[1].slice(0, 8);
        const note = wakeActive && count <= lastCount ? " (wake)" : "";
        console.log(`[daemon] ${now} New message for ${subscriber} (${lastCount} -> ${count})${note}`);

        try {
          await this.injector.inject(subscriber);
          console.log(`[daemon] Injected /bus into ${subscriber}`);
          if (wakeActive) fs.rmSync(wakePath, { force: true });
        } catch (err) {
          console.error(`[daemon] Failed to inject: ${err.message}`);
        }
      }

      // 更新计数
      this.setLastCount(safeName, count);
    }
  }

  /**
   * 获取上次的消息计数
   */
  getLastCount(safeName) {
    const countFile = path.join(this.countsDir, safeName);
    if (!fs.existsSync(countFile)) {
      return 0;
    }
    const content = fs.readFileSync(countFile, "utf8").trim();
    return parseInt(content, 10) || 0;
  }

  /**
   * 设置消息计数
   */
  setLastCount(safeName, count) {
    const countFile = path.join(this.countsDir, safeName);
    ensureDir(path.dirname(countFile));
    fs.writeFileSync(countFile, `${count}\n`, "utf8");
  }

  /**
   * 清理死掉的 agent
   */
  async cleanupDeadAgents() {
    const agentsFile = this.agentsFile;
    if (!fs.existsSync(agentsFile)) {
      return;
    }

    const busData = readJSON(agentsFile);
    if (!busData || !busData.agents) {
      return;
    }

    let changed = false;

    for (const [subscriber, meta] of Object.entries(busData.agents)) {
      if (meta.status !== "active") {
        continue;
      }

      // 检查 PID 是否仍然存活
      if (meta.pid && !isAgentPidAlive(meta.pid)) {
        const now = new Date().toISOString().split("T")[1].slice(0, 8);
        console.log(`[daemon] ${now} Agent ${subscriber} (pid=${meta.pid}) is dead, marking inactive`);

        meta.status = "inactive";
        changed = true;

        // 清理队列目录和 offset
        const safeName = subscriberToSafeName(subscriber);
        const queueDir = path.join(this.busDir, "queues", safeName);
        const offsetFile = path.join(this.busDir, "offsets", `${safeName}.offset`);

        if (fs.existsSync(queueDir)) {
          fs.rmSync(queueDir, { recursive: true, force: true });
        }
        if (fs.existsSync(offsetFile)) {
          fs.unlinkSync(offsetFile);
        }
      }
    }

    if (changed) {
      writeJSON(agentsFile, busData);
    }
  }
}

module.exports = BusDaemon;
