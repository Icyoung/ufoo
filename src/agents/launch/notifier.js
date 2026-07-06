const fs = require("fs");
const path = require("path");
const EventBus = require("../../coordination/bus");
const { readJSON, writeJSON } = require("../../coordination/bus/utils");
const Injector = require("../../coordination/bus/inject");
const { getUfooPaths } = require("../../coordination/state/paths");
const { appendAgentRegistryDiagnostic } = require("../../coordination/state/agentRegistryDiagnostics");
const { shakeTerminalByTty } = require("../../coordination/bus/shake");
const { isITerm2 } = require("../../runtime/terminal/detect");
const iterm2 = require("../../runtime/terminal/iterm2");
const { createActivityStatePublisher } = require("../activity/activityStatePublisher");
const { buildPromptInjectionText } = require("../../coordination/bus/promptEnvelope");
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");

/**
 * Agent 消息通知监听器
 * 监控 pending.jsonl 队列文件，当有新消息时发出通知并自动触发
 */
class AgentNotifier {
  constructor(projectRoot, subscriber) {
    this.projectRoot = projectRoot;
    this.subscriber = subscriber;
    this.interval = 2000; // 2秒轮询一次
    this.workingHoldMs = Number.parseInt(process.env.UFOO_ACTIVITY_WORKING_HOLD_MS || "", 10) || 5000;
    this.lastCount = 0;
    this.lastWorkingAt = 0;
    this.injectFailCount = 0;
    this.maxInjectRetries = 5;
    this.timer = null;
    this.stopped = false;
    this.autoTrigger = process.env.UFOO_AUTO_TRIGGER !== "0"; // 默认启用自动触发
    this.lastNickname = "";
    this.lastUbusWakeCount = -1;


    // 计算队列文件路径
    const safeSub = subscriber.replace(/:/g, "_");
    const paths = getUfooPaths(projectRoot);
    this.queueFile = path.join(
      paths.busQueuesDir,
      safeSub,
      "pending.jsonl"
    );
    this.deliveryQueue = new DeliveryQueue(this.queueFile);
    this.agentsFile = paths.agentsFile;

    // 初始化 injector
    const busDir = paths.busDir;
    this.injector = new Injector(busDir, paths.agentsFile);
    this.eventBus = new EventBus(projectRoot);
    this.activityPublisher = createActivityStatePublisher({
      agentsFile: paths.agentsFile,
      subscriber,
      projectRoot,
      force: false, // notifier is low-priority; don't overwrite working/waiting_input/blocked
    });
  }

  isUfooCodeSubscriber() {
    return String(this.subscriber || "").startsWith("ufoo-code:");
  }

  /**
   * 读取当前订阅者昵称
   */
  getNickname() {
    try {
      if (!this.agentsFile || !fs.existsSync(this.agentsFile)) return "";
      const data = readJSON(this.agentsFile, null);
      if (!data) return "";
      const meta = data.agents && data.agents[this.subscriber];
      return (meta && meta.nickname) ? String(meta.nickname) : "";
    } catch {
      return "";
    }
  }

  /**
   * 通知 notifier launcher 已检测到 agent ready
   * 在此之前 notifier 不会将 activity_state 设为 idle（避免 bootstrap 提前注入）
   */
  markLauncherReady() {
    this._launcherReady = true;
  }

  /**
   * 设置终端标题为昵称
   * codex 等: OSC escape sequence + iTerm2 badge
   * claude-code: OSC 会被 Claude 覆盖，仅设 iTerm2 badge
   */
  setTitle(nickname) {
    if (!nickname) return;
    if (!process.stdout || !process.stdout.isTTY) return;
    if (process.env.UFOO_LAUNCH_MODE !== "host") {
      process.stdout.write(`\x1b]0;${nickname}\x07`);
    }
    if (isITerm2()) {
      iterm2.setBadge(nickname);
      iterm2.setCwd(this.projectRoot);
    }
  }

  /**
   * 检查昵称变化并更新标题
   */
  refreshTitle() {
    const nickname = this.getNickname();
    if (!nickname || nickname === this.lastNickname) return;
    this.lastNickname = nickname;
    this.setTitle(nickname);
  }

  /**
   * 更新心跳时间戳（last_seen）
   */
  updateHeartbeat() {
    try {
      if (!this.agentsFile || !fs.existsSync(this.agentsFile)) return;
      const data = readJSON(this.agentsFile, null);
      if (!data) return;
      if (data.agents && data.agents[this.subscriber]) {
        data.agents[this.subscriber].last_seen = new Date().toISOString();
        writeJSON(this.agentsFile, data);
        return;
      }
      appendAgentRegistryDiagnostic(this.agentsFile, "heartbeat_subscriber_missing", {
        source: "agent.notifier.updateHeartbeat",
        subscriber: this.subscriber,
        known_ids: Object.keys(data.agents || {}).sort(),
      });
    } catch {
      // 心跳更新失败时静默忽略
    }
  }

  /**
   * 更新 activity_state（terminal/tmux agent 基础支持）
   * 基于消息投递推断 WORKING，无 pending 时推断 IDLE
   */
  updateActivityState(state, options = {}) {
    return this.activityPublisher.publish(state, {}, {
      force: typeof options.force === "boolean" ? options.force : undefined,
    });
  }

  getCurrentActivityState() {
    try {
      if (!this.agentsFile || !fs.existsSync(this.agentsFile)) return "";
      const data = readJSON(this.agentsFile, null);
      if (!data) return "";
      const meta = data.agents && data.agents[this.subscriber];
      return meta && typeof meta.activity_state === "string"
        ? String(meta.activity_state).trim().toLowerCase()
        : "";
    } catch {
      return "";
    }
  }

  getAgentsMap() {
    try {
      if (!this.agentsFile || !fs.existsSync(this.agentsFile)) return {};
      const data = readJSON(this.agentsFile, null);
      return data && data.agents && typeof data.agents === "object" ? data.agents : {};
    } catch {
      return {};
    }
  }

  isBusyState(state = "") {
    const value = String(state || "").trim().toLowerCase();
    return value === "working"
      || value === "starting"
      || value === "running"
      || value === "waiting_input"
      || value === "blocked";
  }

  /**
   * 获取当前队列中的消息数量
   */
  getMessageCount() {
    try {
      if (!fs.existsSync(this.queueFile)) return 0;
      const content = fs.readFileSync(this.queueFile, "utf8");
      if (!content.trim()) return 0;
      return content.split("\n").filter((line) => line.trim()).length;
    } catch {
      return 0;
    }
  }

  normalizePublisher(publisher) {
    if (!publisher) return "";
    if (typeof publisher === "string") return publisher;
    if (typeof publisher === "object") {
      return publisher.subscriber || publisher.nickname || "";
    }
    return String(publisher);
  }

  async emitDelivery(evt, status, errorMessage = "") {
    const publisher = this.normalizePublisher(evt.publisher);
    if (!publisher) return;
    const data = {
      target: this.subscriber,
      seq: evt.seq,
      status,
    };
    if (errorMessage) data.error = errorMessage;
    // Provide a human-readable message for chat UI
    if (status === "ok") {
      data.message = `delivered to ${this.lastNickname || this.subscriber}`;
    } else {
      data.message = `delivery failed to ${this.lastNickname || this.subscriber}: ${errorMessage || "unknown error"}`;
    }
    try {
      await this.eventBus.send(publisher, "", this.subscriber, {
        event: "delivery",
        data,
        silent: true,
      });
    } catch {
      // ignore delivery emit failures
    }
  }

  async deliverPending() {
    if (this.isUfooCodeSubscriber()) {
      // ufoo-code consumes bus queue internally; notifier must not inject text/commands.
      return 0;
    }

    // Back off on consecutive inject failures to avoid tight retry loop
    if (this.injectFailCount >= this.maxInjectRetries) {
      return 0;
    }

    if (this.isBusyState(this.getCurrentActivityState())) {
      return 0;
    }

    const claim = this.deliveryQueue.claimNext();
    if (!claim) return 0;

    const evt = claim.event;
    if (!evt || evt.event !== "message" || !evt.data || typeof evt.data.message !== "string") {
      this.deliveryQueue.completeClaim(claim);
      return 0;
    }

    const activityState = this.getCurrentActivityState();
    if (this.isBusyState(activityState)) {
      this.deliveryQueue.restoreClaim(claim);
      return 0;
    }

    const message = buildPromptInjectionText(evt, this.subscriber, this.getAgentsMap());
    try {
      // Inject the prompt-facing text into the terminal/tmux agent.
      await this.injector.inject(this.subscriber, message);
      this.deliveryQueue.completeClaim(claim);
      this.injectFailCount = 0;
      this.updateActivityState("working");
      await this.emitDelivery(evt, "ok");
      this.lastWorkingAt = Date.now();
      return 1;
    } catch (err) {
      this.injectFailCount += 1;
      this.deliveryQueue.restoreClaim(claim);
      await this.emitDelivery(evt, "error", err.message || "inject failed");
      return 0;
    }
  }

  /**
   * 发送终端通知
   * iTerm2: 使用 OSC 9 原生通知
   */
  notify(newCount) {
    if (isITerm2()) {
      const nick = this.lastNickname || this.subscriber;
      iterm2.notify(`${nick}: ${newCount} new message(s)`);
    }
    const tty = this.injector.readTty(this.subscriber);
    if (tty) {
      shakeTerminalByTty(tty);
    }
  }

  /**
   * 自动触发终端输入
   */
  async autoTriggerInput() {
    if (!this.autoTrigger) return;

    try {
      await this.deliverPending();
    } catch (err) {
      // 自动触发失败时静默忽略，用户仍可手动输入
      // console.error("[notifier] Auto-trigger failed:", err.message);
    }
  }

  /**
   * 轮询检查队列
   */
  async poll() {
    if (this.stopped) return;

    const currentCount = this.getMessageCount();
    const nowMs = Date.now();

    // 有新消息
    if (currentCount > this.lastCount) {
      const newCount = currentCount - this.lastCount;
      this.notify(newCount);
    }

    // Delivery is owned by the project daemon scheduler. The notifier keeps
    // terminal notifications, title badges, heartbeat, and activity fallback.
    if (currentCount <= 0) {
      this.lastUbusWakeCount = -1;
    }

    this.lastCount = this.getMessageCount();
    if (this._launcherReady && (!this.lastWorkingAt || nowMs - this.lastWorkingAt >= this.workingHoldMs)) {
      const currentActivityState = this.getCurrentActivityState();
      if (currentActivityState !== "waiting_input" && currentActivityState !== "blocked") {
        if (currentActivityState === "working") {
          this.updateActivityState("idle", { force: true });
        } else {
          this.updateActivityState("idle");
        }
      }
    }
    this.refreshTitle();
    this.updateHeartbeat();
  }

  /**
   * 启动监听
   */
  start() {
    // 获取初始计数
    this.lastCount = this.getMessageCount();
    this.lastNickname = this.getNickname();
    if (this.lastNickname) {
      this.setTitle(this.lastNickname);
    }
    this.updateActivityState("starting");
    // launcher 的 readyDetector 负责在 TUI 真正 ready 后标记 "ready"
    // 在那之前 notifier 不应覆盖 activity_state
    this._launcherReady = false;

    // 启动轮询
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.interval);

    // 注册清理
    process.on("exit", () => this.stop());
    process.on("SIGINT", () => {
      this.stop();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      this.stop();
      process.exit(0);
    });
  }

  /**
   * 停止监听
   */
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = AgentNotifier;
