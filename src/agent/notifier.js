const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const Injector = require("../bus/inject");

/**
 * Agent 消息通知监听器
 * 监控 pending.jsonl 队列文件，当有新消息时发出通知并自动触发
 */
class AgentNotifier {
  constructor(projectRoot, subscriber) {
    this.projectRoot = projectRoot;
    this.subscriber = subscriber;
    this.interval = 2000; // 2秒轮询一次
    this.lastCount = 0;
    this.timer = null;
    this.stopped = false;
    this.autoTrigger = process.env.UFOO_AUTO_TRIGGER !== "0"; // 默认启用自动触发

    // 计算队列文件路径
    const safeSub = subscriber.replace(/:/g, "_");
    this.queueFile = path.join(
      projectRoot,
      ".ufoo/bus/queues",
      safeSub,
      "pending.jsonl"
    );

    // 初始化 injector
    const busDir = path.join(projectRoot, ".ufoo", "bus");
    this.injector = new Injector(busDir);
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

  /**
   * 获取消息预览
   */
  getMessagePreview() {
    try {
      if (!fs.existsSync(this.queueFile)) return null;
      const content = fs.readFileSync(this.queueFile, "utf8");
      if (!content.trim()) return null;

      const lines = content.split("\n").filter((line) => line.trim());
      if (lines.length === 0) return null;

      // 获取最新的消息
      const lastLine = lines[lines.length - 1];
      const event = JSON.parse(lastLine);

      return {
        publisher: event.publisher || "unknown",
        message: event.data?.message || "",
        count: lines.length,
      };
    } catch {
      return null;
    }
  }

  /**
   * 发送终端通知
   */
  notify(newCount) {
    // 终端 bell
    process.stdout.write("\x07");

    // 终端标题栏显示未读数
    const totalCount = this.getMessageCount();
    if (totalCount > 0) {
      process.stdout.write(`\x1b]0;[${totalCount}] ${this.subscriber}\x07`);
    }

    // macOS 通知中心
    if (process.platform === "darwin") {
      const preview = this.getMessagePreview();
      if (!preview) return;

      // 获取 nickname（如果有）
      const nickname = this.getNickname();
      const displayName = nickname || this.subscriber;

      // 截取消息预览（最多50字符）
      let messagePreview = preview.message;
      if (messagePreview.length > 50) {
        messagePreview = messagePreview.substring(0, 47) + "...";
      }

      const title = `Ufoo · ${displayName}`;
      const subtitle = `From: ${preview.publisher}`;
      const message = `📬 ${messagePreview || `${newCount} new message(s)`}`;

      this.sendNotification(title, subtitle, message);
    }
  }

  /**
   * 获取 nickname
   */
  getNickname() {
    try {
      const busFile = path.join(this.projectRoot, ".ufoo/bus/bus.json");
      if (!fs.existsSync(busFile)) return null;

      const busData = JSON.parse(fs.readFileSync(busFile, "utf8"));
      return busData.subscribers?.[this.subscriber]?.nickname || null;
    } catch {
      return null;
    }
  }

  /**
   * 发送 macOS 通知（带点击激活支持）
   */
  sendNotification(title, subtitle, message) {
    const launchMode = process.env.UFOO_LAUNCH_MODE || "";

    // Internal 模式不支持点击激活
    if (launchMode === "internal") {
      this.sendSimpleNotification(title, subtitle, message);
      return;
    }

    // 检查可用的通知发送器
    const notifier = this.checkNotifier();
    if (notifier) {
      if (notifier.type === "ufoo") {
        this.sendUfooNotification(title, subtitle, message, notifier.path);
      } else {
        this.sendTerminalNotifierNotification(title, subtitle, message);
      }
    } else {
      // Fallback 到 osascript
      this.sendActivatableNotification(title, subtitle, message);
    }
  }

  /**
   * 检查通知发送器是否可用
   */
  checkNotifier() {
    // 优先使用我们自己的 UfooNotifier
    const ufooNotifier = path.join(this.projectRoot, ".ufoo/UfooNotifier.app/Contents/MacOS/UfooNotifier");
    if (fs.existsSync(ufooNotifier)) {
      return { type: "ufoo", path: ufooNotifier };
    }

    // Fallback 到 terminal-notifier
    try {
      const result = require("child_process").spawnSync("which", ["terminal-notifier"], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (result.status === 0 && result.stdout.trim()) {
        return { type: "terminal-notifier", path: result.stdout.trim() };
      }
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * 使用 UfooNotifier 发送通知（原生 Ufoo 应用）
   */
  sendUfooNotification(title, subtitle, message, notifierPath) {
    const launchMode = process.env.UFOO_LAUNCH_MODE || "";
    const tty = this.getTty();
    const tmuxPane = this.getTmuxPane();

    // 构建激活脚本路径
    const scriptDir = path.join(this.projectRoot, ".ufoo/bus/.notify-scripts");
    fs.mkdirSync(scriptDir, { recursive: true });

    const safeSub = this.subscriber.replace(/:/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    const scriptPath = path.join(scriptDir, `activate-${safeSub}.sh`);

    // 创建激活脚本
    this.createActivationScript(scriptPath, launchMode, tty, tmuxPane);

    const args = [
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-execute", scriptPath,
    ];

    spawn(notifierPath, args, { detached: true, stdio: "ignore" }).unref();
  }

  /**
   * 使用 terminal-notifier 发送通知（支持点击激活）
   */
  sendTerminalNotifierNotification(title, subtitle, message) {
    const launchMode = process.env.UFOO_LAUNCH_MODE || "";
    const tty = this.getTty();
    const tmuxPane = this.getTmuxPane();

    // 构建激活脚本路径
    const scriptDir = path.join(this.projectRoot, ".ufoo/bus/.notify-scripts");
    fs.mkdirSync(scriptDir, { recursive: true });

    const safeSub = this.subscriber.replace(/:/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
    const scriptPath = path.join(scriptDir, `activate-${safeSub}.sh`);

    // 创建激活脚本
    this.createActivationScript(scriptPath, launchMode, tty, tmuxPane);

    // 确保 Ufoo.app bundle 存在
    this.ensureUfooApp();

    const args = [
      "-title", title,
      "-subtitle", subtitle,
      "-message", message,
      "-sound", "default",
      "-sender", "com.ufoo.notifier",  // 使用 Ufoo bundle ID
      "-group", "ufoo",  // 通知分组
      "-execute", `bash "${scriptPath}"`,
    ];

    spawn("terminal-notifier", args, { detached: true, stdio: "ignore" }).unref();
  }

  /**
   * 确保 Ufoo.app bundle 存在
   */
  ensureUfooApp() {
    const ufooAppPath = path.join(this.projectRoot, ".ufoo/Ufoo.app");
    const infoPlistPath = path.join(ufooAppPath, "Contents/Info.plist");

    // 如果已存在，直接返回
    if (fs.existsSync(infoPlistPath)) {
      return;
    }

    // 创建 bundle
    const contentsDir = path.join(ufooAppPath, "Contents");
    const macosDir = path.join(contentsDir, "MacOS");
    const resourcesDir = path.join(contentsDir, "Resources");

    fs.mkdirSync(macosDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });

    // 创建 Info.plist
    const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Ufoo</string>
    <key>CFBundleIdentifier</key>
    <string>com.ufoo.notifier</string>
    <key>CFBundleName</key>
    <string>Ufoo</string>
    <key>CFBundleDisplayName</key>
    <string>Ufoo</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>`;

    fs.writeFileSync(infoPlistPath, infoPlist);

    // 创建可执行文件
    const execPath = path.join(macosDir, "Ufoo");
    fs.writeFileSync(execPath, "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  }

  /**
   * 发送带激活功能的通知（osascript fallback）
   */
  sendActivatableNotification(title, subtitle, message) {
    // 简单通知 + 后台保存激活信息
    // 当用户点击通知时，会激活发送通知的应用（终端）
    this.sendSimpleNotification(title, subtitle, message);

    // 保存激活信息，供手动激活使用
    this.saveActivationInfo();
  }

  /**
   * 发送简单通知
   */
  sendSimpleNotification(title, subtitle, message) {
    try {
      // 转义特殊字符
      const escapeForAppleScript = (str) => {
        return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      };

      const script = `display notification "${escapeForAppleScript(message)}" with title "${escapeForAppleScript(title)}" subtitle "${escapeForAppleScript(subtitle)}" sound name "default"`;

      spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // 忽略通知失败
    }
  }

  /**
   * 获取 tty 路径
   */
  getTty() {
    try {
      const busFile = path.join(this.projectRoot, ".ufoo/bus/bus.json");
      if (!fs.existsSync(busFile)) return null;

      const busData = JSON.parse(fs.readFileSync(busFile, "utf8"));
      return busData.subscribers?.[this.subscriber]?.tty || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取 tmux pane
   */
  getTmuxPane() {
    try {
      const busFile = path.join(this.projectRoot, ".ufoo/bus/bus.json");
      if (!fs.existsSync(busFile)) return null;

      const busData = JSON.parse(fs.readFileSync(busFile, "utf8"));
      return busData.subscribers?.[this.subscriber]?.tmux_pane || null;
    } catch {
      return null;
    }
  }

  /**
   * 创建终端/tmux 激活脚本
   */
  createActivationScript(scriptPath, launchMode, tty, tmuxPane) {
    let script = "#!/bin/bash\n\n";

    if (launchMode === "tmux" && tmuxPane) {
      // Tmux 模式：切换到对应的 pane
      script += `# Activate tmux pane\n`;
      script += `if command -v tmux &> /dev/null; then\n`;
      script += `  # 检查 pane 是否存在\n`;
      script += `  if tmux list-panes -a -F '#{pane_id}' | grep -q '${tmuxPane}'; then\n`;
      script += `    # 切换到对应的 window 和 pane\n`;
      script += `    tmux select-window -t '${tmuxPane}' 2>/dev/null || true\n`;
      script += `    tmux select-pane -t '${tmuxPane}' 2>/dev/null || true\n`;
      script += `  fi\n`;
      script += `fi\n`;
    } else if (launchMode === "terminal" && tty) {
      // Terminal.app 模式：激活对应的 tab
      script += `# Activate Terminal.app tab\n`;
      script += `osascript <<EOF\n`;
      script += `tell application "Terminal"\n`;
      script += `  set targetWindow to missing value\n`;
      script += `  set targetTab to missing value\n`;
      script += `  \n`;
      script += `  repeat with w in windows\n`;
      script += `    repeat with t in tabs of w\n`;
      script += `      try\n`;
      script += `        if tty of t is "${tty}" then\n`;
      script += `          set targetWindow to w\n`;
      script += `          set targetTab to t\n`;
      script += `          exit repeat\n`;
      script += `        end if\n`;
      script += `      end try\n`;
      script += `    end repeat\n`;
      script += `    if targetTab is not missing value then exit repeat\n`;
      script += `  end repeat\n`;
      script += `  \n`;
      script += `  if targetTab is not missing value then\n`;
      script += `    activate\n`;
      script += `    set selected tab of targetWindow to targetTab\n`;
      script += `    set index of targetWindow to 1\n`;
      script += `  end if\n`;
      script += `end tell\n`;
      script += `EOF\n`;
    }

    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  }

  /**
   * 保存激活信息（用于手动激活）
   */
  saveActivationInfo() {
    try {
      const infoDir = path.join(this.projectRoot, ".ufoo/bus/.notify-info");
      fs.mkdirSync(infoDir, { recursive: true });

      const safeSub = this.subscriber.replace(/:/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
      const infoFile = path.join(infoDir, `${safeSub}.json`);

      const info = {
        subscriber: this.subscriber,
        tty: this.getTty(),
        tmux_pane: this.getTmuxPane(),
        launch_mode: process.env.UFOO_LAUNCH_MODE || "",
        timestamp: new Date().toISOString(),
      };

      fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
    } catch {
      // 忽略保存失败
    }
  }

  /**
   * 自动触发终端输入
   */
  async autoTriggerInput() {
    if (!this.autoTrigger) return;

    try {
      await this.injector.inject(this.subscriber);
    } catch (err) {
      // 自动触发失败时静默忽略，用户仍可手动输入
      // console.error("[notifier] Auto-trigger failed:", err.message);
    }
  }

  /**
   * 轮询检查队列
   */
  poll() {
    if (this.stopped) return;

    const currentCount = this.getMessageCount();

    // 有新消息
    if (currentCount > this.lastCount) {
      const newCount = currentCount - this.lastCount;
      this.notify(newCount);

      // 自动触发终端输入（非阻塞）
      this.autoTriggerInput().catch(() => {
        // 忽略触发失败
      });
    }

    this.lastCount = currentCount;
  }

  /**
   * 启动监听
   */
  start() {
    // 获取初始计数
    this.lastCount = this.getMessageCount();

    // 启动轮询
    this.timer = setInterval(() => {
      this.poll();
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
