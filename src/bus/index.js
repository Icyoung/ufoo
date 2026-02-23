const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  logInfo,
  logOk,
  ensureDir,
  logWarn,
  logError,
  colors,
  generateInstanceId,
  subscriberToSafeName,
  isPidAlive,
  truncateFile,
  getCurrentTty,
  sleep,
} = require("./utils");
const { shakeTerminalByTty } = require("./shake");
const QueueManager = require("./queue");
const SubscriberManager = require("./subscriber");
const MessageManager = require("./message");
const NicknameManager = require("./nickname");
const BusDaemon = require("./daemon");
const Injector = require("./inject");
const { BusStore } = require("./store");

/**
 * Event Bus - 项目级 Agent 事件总线
 */
class EventBus {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.store = new BusStore(projectRoot);
    this.paths = this.store.paths;
    this.busDir = this.store.busDir;
    this.agentsFile = this.store.agentsFile;
    this.eventsDir = this.store.eventsDir;
    this.logsDir = this.store.logsDir;

    this.busData = null;
    this.queueManager = null;
    this.subscriberManager = null;
    this.messageManager = null;
  }

  /**
   * 确保 bus 已初始化
   */
  ensureBus() {
    this.store.ensure();
  }

  /**
   * 加载 bus 数据
   */
  loadBusData() {
    this.busData = this.store.load();

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

    // 自动清理不活跃的 agents
    this.subscriberManager.cleanupInactive();
  }

  /**
   * 保存 bus 数据
   */
  saveBusData() {
    this.store.save(this.busData);
  }

  /**
   * 获取当前订阅者 ID
   */
  getCurrentSubscriber() {
    return this.store.getCurrentSubscriber(this.busData);
  }

  /**
   * 解析订阅者 ID
   */
  parseSubscriber(subscriber) {
    if (!subscriber || typeof subscriber !== "string") return null;
    if (subscriber === "ufoo-agent") {
      return { agentType: "codex", sessionId: "ufoo-agent" };
    }
    const parts = subscriber.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return {
      agentType: parts[0],
      sessionId: parts[1],
    };
  }

  /**
   * 推断 join 所需的 agentType
   */
  resolveJoinAgentType(explicitAgentType, currentSubscriber = "") {
    if (explicitAgentType) return explicitAgentType;

    const parsedCurrent = this.parseSubscriber(currentSubscriber);
    if (parsedCurrent && parsedCurrent.agentType) return parsedCurrent.agentType;

    const envAgentType = (process.env.UFOO_AGENT_TYPE || "").trim();
    if (envAgentType) return envAgentType;

    const parsedEnv = this.parseSubscriber(process.env.UFOO_SUBSCRIBER_ID || "");
    if (parsedEnv && parsedEnv.agentType) return parsedEnv.agentType;

    // 最后回退（手动场景）
    return "claude-code";
  }

  /**
   * 初始化事件总线
   */
  async init() {
    this.store.init();
    logOk("Event bus initialized");
  }

  /**
   * 加入总线
   */
  async join(sessionId, agentType, nickname = null, options = {}) {
    this.ensureBus();
    this.loadBusData();

    const currentSubscriber = this.getCurrentSubscriber();
    const currentMeta = currentSubscriber && this.busData.agents
      ? this.busData.agents[currentSubscriber]
      : null;
    const currentActive = currentMeta
      && currentMeta.status === "active"
      && (!currentMeta.pid || isPidAlive(currentMeta.pid));

    // 已在总线中且无显式参数时，直接复用当前身份（避免二次 join 产生新 ID）
    if (!sessionId && !agentType && currentSubscriber && currentActive) {
      this.subscriberManager.updateLastSeen(currentSubscriber);
      this.saveBusData();
      const currentNickname = currentMeta.nickname ? ` (${currentMeta.nickname})` : "";
      logInfo(`Already joined event bus: ${currentSubscriber}${currentNickname}`);
      return currentSubscriber;
    }

    // 自动检测 session ID 和 agent type
    const parsedCurrent = this.parseSubscriber(currentSubscriber);
    if (!sessionId && parsedCurrent && parsedCurrent.sessionId) {
      sessionId = parsedCurrent.sessionId;
    }

    if (!sessionId) {
      sessionId = generateInstanceId();
    }

    agentType = this.resolveJoinAgentType(agentType, currentSubscriber);

    const result = await this.subscriberManager.join(
      sessionId,
      agentType,
      nickname,
      options
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
  async rename(subscriber, newNickname, publisher = null) {
    this.ensureBus();
    this.loadBusData();

    try {
      const result = await this.subscriberManager.rename(
        subscriber,
        newNickname
      );
      this.saveBusData();
      const pub = publisher || this.getDefaultPublisher() || "unknown";
      try {
        await this.messageManager.emit(
          "*",
          "agent_renamed",
          {
            agent_id: result.subscriber,
            old_nickname: result.oldNickname,
            new_nickname: result.newNickname,
          },
          pub
        );
      } catch {
        // ignore event emit failures
      }
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

    // 优先使用 UFOO_SUBSCRIBER_ID（daemon 启动的情况）
    if (process.env.UFOO_SUBSCRIBER_ID) {
      const subscriber = process.env.UFOO_SUBSCRIBER_ID;
      const meta = this.subscriberManager.getSubscriber(subscriber);

      if (meta) {
        console.log(subscriber);
        return subscriber;
      }
    }

    logError("Not joined to bus. Please run: ufoo bus join");
    return null;
  }

  /**
   * 发送消息
   */
  async send(target, message, publisher = null, options = {}) {
    this.ensureBus();
    this.loadBusData();

    // 自动检测 publisher
    if (!publisher) {
      publisher =
        process.env.AI_BUS_PUBLISHER ||
        this.getDefaultPublisher() ||
        this.getCurrentSubscriber() ||
        "unknown";
    }

    // 如果 publisher 还是 unknown，尝试从命令行参数或环境推断
    if (publisher === "unknown") {
      // 尝试从 tty 查找可能的 subscriber
      const possibleSubscriber = this.getCurrentSubscriber();
      if (possibleSubscriber) {
        publisher = possibleSubscriber;
      }
    }

    // 如果 publisher 不在 agents 列表中，自动注册它（懒加载模式）
    if (publisher !== "unknown" && this.busData.agents && !this.busData.agents[publisher]) {
      // 解析 agent 信息
      const parts = publisher.split(":");
      const agentType = parts[0] || "unknown-agent";
      const sessionId = parts[1] || require("./utils").generateInstanceId();

      // 自动加入总线（静默模式，不输出日志）
      const subscriber = await this.subscriberManager.join(sessionId, agentType, null);
      this.saveBusData();
      publisher = subscriber; // 使用规范化的 subscriber ID
    }

    // 更新 publisher 的心跳
    if (publisher !== "unknown" && this.busData.agents && this.busData.agents[publisher]) {
      this.subscriberManager.updateLastSeen(publisher);
      this.saveBusData();
    }

    try {
      const eventName = options.event || "message";
      const data = options.data || { message };
      const result = eventName === "message"
        ? await this.messageManager.send(target, message, publisher)
        : await this.messageManager.emit(target, eventName, data, publisher);
      const silent = options.silent === true;
      if (!silent && eventName === "message") {
        logOk(
          `Message sent: seq=${result.seq} -> ${result.targets.join(", ")}`
        );
      } else if (!silent && process.env.UFOO_BUS_VERBOSE_EVENTS === "1") {
        logInfo(
          `Event sent: event=${eventName} seq=${result.seq} -> ${result.targets.join(", ")}`
        );
      }
      return result;
    } catch (err) {
      logError(err.message);
      throw err;
    }
  }

  /**
   * 广播消息
   */
  async broadcast(message, publisher = null, options = {}) {
    return this.send("*", message, publisher, options);
  }

  /**
   * 检查待处理消息
   */
  async check(subscriber, autoAck = false) {
    this.ensureBus();
    this.loadBusData();

    // 更新心跳
    this.subscriberManager.updateLastSeen(subscriber);
    this.saveBusData();

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

    // 尝试获取当前 subscriber 并更新 last_seen + 重新激活（保持心跳）
    const currentSubscriber = this.getCurrentSubscriber();
    if (currentSubscriber && this.busData.agents && this.busData.agents[currentSubscriber]) {
      this.subscriberManager.updateLastSeen(currentSubscriber);
      this.busData.agents[currentSubscriber].status = "active";
      this.saveBusData();
    }

    console.log(`${colors.cyan}=== Event Bus Status ===${colors.reset}`);
    console.log();

    // 显示 bus ID
    const busId = path.basename(this.projectRoot) || "ai-workspace";
    console.log(`Bus ID: ${busId}`);
    console.log();

    // 显示在线订阅者
    const active = this.subscriberManager.getActiveSubscribers();
    console.log(`${colors.cyan}Online agents:${colors.reset}`);
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
    // 使用 UFOO_SUBSCRIBER_ID（daemon 启动的情况）
    return process.env.UFOO_SUBSCRIBER_ID || null;
  }

  /**
   * 确保当前 agent 已经 join 总线（如果没有则自动 join）
   */
  async ensureJoined() {
    this.ensureBus();
    this.loadBusData();

    // 检查是否已经 join
    const currentSubscriber = this.getCurrentSubscriber();
    const currentMeta = currentSubscriber && this.busData.agents
      ? this.busData.agents[currentSubscriber]
      : null;
    const currentActive = currentMeta
      && currentMeta.status === "active"
      && (!currentMeta.pid || isPidAlive(currentMeta.pid));
    if (currentSubscriber && currentActive) {
      // 已经 join，只需更新心跳
      this.subscriberManager.updateLastSeen(currentSubscriber);
      this.saveBusData();
      return currentSubscriber;
    }

    // 当前身份可解析但元数据缺失/失效时，复用同一身份重新注册
    const parsedCurrent = this.parseSubscriber(currentSubscriber || "");
    if (parsedCurrent) {
      return this.join(parsedCurrent.sessionId, parsedCurrent.agentType, null);
    }

    // 还没有 join，自动 join
    const sessionId = null; // 自动生成
    const agentType = null; // 自动检测
    const nickname = null; // 自动生成
    const subscriber = await this.join(sessionId, agentType, nickname);

    // 静默加入（不输出 "Joined event bus" 信息）
    return subscriber;
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
          const tty = getCurrentTty();
          if (tty) shakeTerminalByTty(tty);
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
   * 远程唤醒本地 agent（触发 /ubus 注入）
   */
  async wake(subscriber, options = {}) {
    this.ensureBus();
    this.loadBusData();

    const publisher =
      options.publisher ||
      process.env.AI_BUS_PUBLISHER ||
      this.getDefaultPublisher() ||
      this.getCurrentSubscriber() ||
      "unknown";

    const targets = this.messageManager.resolveTarget(subscriber || "");
    if (targets.length === 0) {
      throw new Error(`Target "${subscriber}" not found`);
    }

    for (const target of targets) {
      const safeName = subscriberToSafeName(target);
      const queueDir = path.join(this.busDir, "queues", safeName);
      const pendingFile = path.join(queueDir, "pending.jsonl");
      ensureDir(queueDir);

      const before = fs.existsSync(pendingFile) ? fs.readFileSync(pendingFile, "utf8") : "";
      const countBefore = before.trim() ? before.trim().split(/\r?\n/).length : 0;
      await this.messageManager.emit(target, "wake", { reason: options.reason || "remote" }, publisher, "status/wake");
      const after = fs.existsSync(pendingFile) ? fs.readFileSync(pendingFile, "utf8") : "";
      const countAfter = after.trim() ? after.trim().split(/\r?\n/).length : 0;

      if (countAfter > countBefore) {
        await sleep(50);
        const daemon = new BusDaemon(this.busDir, this.agentsFile, this.paths.busDaemonDir, 2000);
        await daemon.injector.inject(target, options.command || "");
        if (options.shake !== false) {
          const tty = daemon.injector.readTty(target);
          if (tty) shakeTerminalByTty(tty, { skipFrontmost: true });
        }
      }
    }

    logOk(`Wake sent -> ${targets.join(", ")}`);
    return { ok: true, targets };
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
        const tty = getCurrentTty();
        if (tty) shakeTerminalByTty(tty);
        newLines.forEach((line) => {
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
    const daemon = new BusDaemon(this.busDir, this.agentsFile, this.paths.busDaemonDir, interval);

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
  async inject(subscriber, commandOverride = "") {
    this.ensureBus();
    const injector = new Injector(this.busDir, this.agentsFile);
    await injector.inject(subscriber, commandOverride);
  }
}

module.exports = EventBus;
