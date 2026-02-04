const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  getTimestamp,
  ensureDir,
  readJSON,
  writeJSON,
  logInfo,
  logOk,
  logWarn,
  logError,
  colors,
  generateInstanceId,
  subscriberToSafeName,
  isPidAlive,
  truncateFile,
} = require("./utils");
const QueueManager = require("./queue");
const SubscriberManager = require("./subscriber");
const MessageManager = require("./message");
const NicknameManager = require("./nickname");
const BusDaemon = require("./daemon");
const Injector = require("./inject");

/**
 * Event Bus - 项目级 Agent 事件总线
 */
class EventBus {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.busDir = path.join(projectRoot, ".ufoo", "bus");
    this.busFile = path.join(this.busDir, "bus.json");
    this.eventsDir = path.join(this.busDir, "events");
    this.logsDir = path.join(this.busDir, "logs");

    this.busData = null;
    this.queueManager = null;
    this.subscriberManager = null;
    this.messageManager = null;
  }

  /**
   * 确保 bus 已初始化
   */
  ensureBus() {
    if (!fs.existsSync(this.busDir)) {
      throw new Error(
        "Event bus not initialized. Please run: ufoo bus init or /uinit"
      );
    }
  }

  /**
   * 加载 bus 数据
   */
  loadBusData() {
    this.busData = readJSON(this.busFile, {
      created_at: getTimestamp(),
      subscribers: {},
    });

    this.queueManager = new QueueManager(this.busDir);
    this.subscriberManager = new SubscriberManager(
      this.busData,
      this.queueManager
    );
    this.messageManager = new MessageManager(
      this.busDir,
      this.busData,
      this.queueManager
    );

    // 自动清理不活跃的 subscribers
    this.subscriberManager.cleanupInactive();
  }

  /**
   * 保存 bus 数据
   */
  saveBusData() {
    if (this.busData) {
      writeJSON(this.busFile, this.busData);
    }
  }

  /**
   * 初始化事件总线
   */
  async init() {
    if (fs.existsSync(this.busDir)) {
      return;
    }

    // 创建目录结构
    ensureDir(this.busDir);
    ensureDir(this.eventsDir);
    ensureDir(path.join(this.busDir, "queues"));
    ensureDir(this.logsDir);
    ensureDir(path.join(this.busDir, "offsets"));

    // 创建初始 bus.json
    const busData = {
      created_at: getTimestamp(),
      subscribers: {},
    };

    writeJSON(this.busFile, busData);
    logOk("Event bus initialized");
  }

  /**
   * 加入总线
   */
  async join(sessionId, agentType, nickname = null) {
    this.ensureBus();
    this.loadBusData();

    // 自动检测 session ID 和 agent type
    if (!sessionId) {
      sessionId =
        process.env.CLAUDE_SESSION_ID ||
        process.env.CODEX_SESSION_ID ||
        generateInstanceId();
    }

    if (!agentType) {
      agentType = process.env.CODEX_SESSION_ID ? "codex" : "claude-code";
    }

    const result = await this.subscriberManager.join(
      sessionId,
      agentType,
      nickname
    );

    this.saveBusData();

    logOk(
      `Joined event bus: ${result.subscriber}${result.nickname ? ` (${result.nickname})` : ""}`
    );
    return result.subscriber;
  }

  /**
   * 离开总线
   */
  async leave(subscriber) {
    this.ensureBus();
    this.loadBusData();

    const success = await this.subscriberManager.leave(subscriber);

    if (success) {
      this.saveBusData();
      logOk(`Left event bus: ${subscriber}`);
    } else {
      logError(`Subscriber not found: ${subscriber}`);
    }

    return success;
  }

  /**
   * 重命名订阅者
   */
  async rename(subscriber, newNickname) {
    this.ensureBus();
    this.loadBusData();

    try {
      const result = await this.subscriberManager.rename(
        subscriber,
        newNickname
      );
      this.saveBusData();
      logOk(
        `Renamed ${result.subscriber}: "${result.oldNickname}" -> "${result.newNickname}"`
      );
      return result;
    } catch (err) {
      logError(err.message);
      throw err;
    }
  }

  /**
   * 获取当前订阅者 ID
   */
  async whoami() {
    this.ensureBus();
    this.loadBusData();

    const sessionId =
      process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID;
    const agentType = process.env.CODEX_SESSION_ID ? "codex" : "claude-code";

    if (!sessionId) {
      logError("No session ID found. Please run: ufoo bus join");
      return null;
    }

    const subscriber = `${agentType}:${sessionId}`;
    const meta = this.subscriberManager.getSubscriber(subscriber);

    if (!meta) {
      logError(`Not joined. Please run: ufoo bus join`);
      return null;
    }

    console.log(subscriber);
    return subscriber;
  }

  /**
   * 发送消息
   */
  async send(target, message, publisher = null) {
    this.ensureBus();
    this.loadBusData();

    // 自动检测 publisher
    if (!publisher) {
      publisher =
        process.env.AI_BUS_PUBLISHER ||
        this.getDefaultPublisher() ||
        "unknown";
    }

    try {
      const result = await this.messageManager.send(target, message, publisher);
      logOk(
        `Message sent: seq=${result.seq} -> ${result.targets.join(", ")}`
      );
      return result;
    } catch (err) {
      logError(err.message);
      throw err;
    }
  }

  /**
   * 广播消息
   */
  async broadcast(message, publisher = null) {
    return this.send("*", message, publisher);
  }

  /**
   * 检查待处理消息
   */
  async check(subscriber, autoAck = false) {
    this.ensureBus();
    this.loadBusData();

    const pending = await this.messageManager.check(subscriber);

    if (pending.length === 0) {
      logOk("No pending messages");
      return pending;
    }

    logWarn(`You have ${pending.length} pending event(s):`);
    console.log();

    for (const event of pending) {
      console.log(`  ${colors.yellow}@you${colors.reset} from ${colors.cyan}${event.publisher}${colors.reset}`);
      console.log(`  Type: ${event.type}/${event.event}`);
      console.log(`  Content: ${JSON.stringify(event.data)}`);
      console.log();
    }

    console.log(`${colors.cyan}After handling, run: ufoo bus ack ${subscriber}${colors.reset}`);

    if (autoAck) {
      await this.ack(subscriber);
    }

    return pending;
  }

  /**
   * 确认消息
   */
  async ack(subscriber) {
    this.ensureBus();
    this.loadBusData();

    const count = await this.messageManager.ack(subscriber);

    if (count > 0) {
      logOk(`Acknowledged and cleared ${count} message(s)`);
    } else {
      logOk("No pending messages to acknowledge");
    }

    return count;
  }

  /**
   * 消费事件
   */
  async consume(subscriber, fromBeginning = false) {
    this.ensureBus();
    this.loadBusData();

    const result = await this.messageManager.consume(subscriber, fromBeginning);

    for (const event of result.consumed) {
      console.log(JSON.stringify(event));
    }

    logInfo(`Consumed ${result.consumed.length} events, new offset: ${result.newOffset}`);

    return result;
  }

  /**
   * 查看总线状态
   */
  async status() {
    this.ensureBus();
    this.loadBusData();

    // 清理不活跃的订阅者
    this.subscriberManager.cleanupInactive();

    console.log(`${colors.cyan}=== Event Bus Status ===${colors.reset}`);
    console.log();

    // 显示 bus ID
    const busId = path.basename(this.projectRoot) || "ai-workspace";
    console.log(`Bus ID: ${busId}`);
    console.log();

    // 显示在线订阅者
    const active = this.subscriberManager.getActiveSubscribers();
    console.log(`${colors.cyan}Online subscribers:${colors.reset}`);
    if (active.length === 0) {
      console.log("  (none)");
    } else {
      for (const sub of active) {
        const nickname = sub.nickname ? ` (${sub.nickname})` : "";
        console.log(`  ${sub.id}${nickname}`);
      }
    }
    console.log();

    // 显示事件统计
    console.log(`${colors.cyan}Event statistics:${colors.reset}`);
    if (fs.existsSync(this.eventsDir)) {
      const files = fs.readdirSync(this.eventsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort();

      let totalEvents = 0;
      for (const file of files) {
        const filePath = path.join(this.eventsDir, file);
        const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
        const count = lines.length;
        totalEvents += count;
        console.log(`  ${file}: ${count} events`);
      }
      console.log(`  Total: ${totalEvents} events`);
    } else {
      console.log("  (no events yet)");
    }

    return { active, busId };
  }

  /**
   * 智能路由
   */
  async resolve(myId, targetType) {
    this.ensureBus();
    this.loadBusData();

    const result = await this.messageManager.resolve(myId, targetType);

    if (result.single) {
      console.log(result.single);
      return result.single;
    }

    if (result.candidates.length === 0) {
      logError(`No ${targetType} agents found`);
      return null;
    }

    console.log(`Multiple ${targetType} agents found:`);
    for (const candidate of result.candidates) {
      const nickname = candidate.nickname ? ` (${candidate.nickname})` : "";
      console.log(`  ${candidate.id}${nickname}`);
    }

    return null;
  }

  /**
   * 获取默认发布者
   */
  getDefaultPublisher() {
    const sessionId =
      process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID;
    if (!sessionId) return null;

    const agentType = process.env.CODEX_SESSION_ID ? "codex" : "claude-code";
    return `${agentType}:${sessionId}`;
  }

  /**
   * 后台消息提醒
   */
  async alert(subscriber, intervalSeconds = 2, options = {}) {
    this.ensureBus();
    this.loadBusData();

    if (!subscriber) {
      throw new Error("alert requires <subscriber-id>");
    }

    const interval = Math.max(1, parseInt(intervalSeconds, 10) || 2);
    const intervalMs = interval * 1000;
    const useNotify = Boolean(options.notify);
    const useTitle = options.title !== false;
    const useBell = options.bell !== false;
    const daemon = Boolean(options.daemon);
    const stop = Boolean(options.stop);

    const safeName = subscriberToSafeName(subscriber);
    const pidDir = path.join(this.busDir, "pids");
    const pidFile = path.join(pidDir, `alert-${safeName}.pid`);
    const logDir = path.join(this.busDir, "logs");
    const logFile = path.join(logDir, `alert-${safeName}.log`);

    ensureDir(pidDir);

    if (stop) {
      if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
        if (pid && isPidAlive(pid)) {
          try {
            process.kill(pid);
            console.log(`[alert] Stopped ${subscriber} (pid=${pid})`);
          } catch {
            console.log("[alert] Not running");
          }
        } else {
          console.log(`[alert] Not running for ${subscriber}`);
        }
        fs.rmSync(pidFile, { force: true });
      } else {
        console.log(`[alert] Not running for ${subscriber}`);
      }
      return;
    }

    if (daemon) {
      if (fs.existsSync(pidFile)) {
        const existing = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
        if (existing && isPidAlive(existing)) {
          console.log(`[alert] Already running for ${subscriber} (pid=${existing})`);
          return;
        }
      }

      ensureDir(logDir);

      const args = [
        path.join(__dirname, "..", "..", "bin", "ufoo.js"),
        "bus",
        "alert",
        subscriber,
        String(interval),
      ];
      if (useNotify) args.push("--notify");
      if (!useTitle) args.push("--no-title");
      if (!useBell) args.push("--no-bell");

      const logStream = fs.openSync(logFile, "a");
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: ["ignore", logStream, logStream],
        cwd: process.cwd(),
      });

      child.unref();
      fs.writeFileSync(pidFile, `${child.pid}\n`, "utf8");
      console.log(`[alert] Started for ${subscriber} (pid=${child.pid}, log=${logFile})`);
      return;
    }

    fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
    const cleanup = () => {
      if (fs.existsSync(pidFile)) fs.rmSync(pidFile, { force: true });
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });

    const queuePath = this.queueManager.getPendingPath(subscriber);
    this.queueManager.ensureQueueDir(subscriber);

    const countLines = () => {
      if (!fs.existsSync(queuePath)) return 0;
      const content = fs.readFileSync(queuePath, "utf8").trim();
      if (!content) return 0;
      return content.split("\n").filter(Boolean).length;
    };

    let lastCount = countLines();
    console.log(`[alert] Watching ${subscriber} (interval=${interval}s)`);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    while (true) {
      const count = countLines();
      if (count > lastCount) {
        const newCount = count - lastCount;
        const now = new Date().toISOString().split("T")[1].slice(0, 8);
        console.log(`[alert] ${now} +${newCount} new message(s)`);

        if (useBell) {
          process.stdout.write("\x07");
        }
        if (useTitle) {
          process.stdout.write(`\x1b]0;[${count}] ${subscriber}\x07`);
        }
        if (useNotify && process.platform === "darwin") {
          const message = `${newCount} new message(s)`;
          spawn(
            "osascript",
            [
              "-e",
              `display notification "${message}" with title "ufoo bus" subtitle "${subscriber}"`,
            ],
            { detached: true, stdio: "ignore" }
          ).unref();
        }
      }

      if (useTitle && count > 0) {
        process.stdout.write(`\x1b]0;[${count}] ${subscriber}\x07`);
      }

      lastCount = count;
      await sleep(intervalMs);
    }
  }

  /**
   * 前台消息监听
   */
  async listen(subscriber, options = {}) {
    this.ensureBus();
    this.loadBusData();

    let target = subscriber;
    if (!target && options.autoJoin) {
      target = await this.join();
      console.log(`[listen] Auto-joined as: ${target}`);
    }

    if (!target) {
      throw new Error("listen requires <subscriber-id> (or --auto-join)");
    }

    const queuePath = this.queueManager.getPendingPath(target);
    this.queueManager.ensureQueueDir(target);
    if (!fs.existsSync(queuePath)) {
      fs.writeFileSync(queuePath, "", "utf8");
    }

    if (options.reset) {
      console.log("[listen] Resetting queue...");
      truncateFile(queuePath);
    }

    const readLines = () => {
      if (!fs.existsSync(queuePath)) return [];
      const content = fs.readFileSync(queuePath, "utf8").trim();
      if (!content) return [];
      return content.split("\n").filter(Boolean);
    };

    const formatLine = (line) => {
      let data = null;
      try {
        data = JSON.parse(line);
      } catch {
        data = null;
      }
      const msg = data?.data?.message ?? data?.data ?? line;
      const from = data?.publisher ?? "unknown";
      const ts = data?.ts || data?.timestamp || "";
      const shortTs = ts ? ts.slice(11, 19) : "";
      const prefix = shortTs ? `[${shortTs}] ` : "";
      console.log(`${prefix}<${from}> ${msg}`);
    };

    if (options.fromBeginning) {
      const lines = readLines();
      if (lines.length > 0) {
        console.log("[listen] Existing messages:");
        console.log("---");
        lines.forEach((line) => formatLine(line));
        console.log("---");
      }
    }

    console.log("[listen] Listening for new messages... (Ctrl+C to stop)");

    let lastLines = readLines().length;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    while (true) {
      const lines = readLines();
      if (lines.length > lastLines) {
        const newLines = lines.slice(lastLines);
        newLines.forEach((line) => {
          process.stdout.write("\x07");
          formatLine(line);
        });
        lastLines = lines.length;
      }
      await sleep(1000);
    }
  }

  /**
   * Daemon 管理
   */
  async daemon(action, options = {}) {
    const interval = options.interval || 2000;
    const daemon = new BusDaemon(this.busDir, interval);

    switch (action) {
      case "start":
        await daemon.start(options.background || false);
        break;
      case "stop":
        daemon.stop();
        break;
      case "status":
        daemon.status();
        break;
      default:
        throw new Error(`Unknown daemon action: ${action}`);
    }
  }

  /**
   * 注入命令到订阅者终端
   */
  async inject(subscriber) {
    this.ensureBus();
    const injector = new Injector(this.busDir);
    await injector.inject(subscriber);
  }
}

module.exports = EventBus;
