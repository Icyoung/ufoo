const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const EventBus = require("../bus");
const { showBanner } = require("../utils/banner");
const AgentNotifier = require("./notifier");

/**
 * Agent 启动器
 * 统一处理 agent 启动流程：初始化、bus join、daemon、banner、命令执行
 */
class AgentLauncher {
  constructor(agentType, command) {
    this.agentType = agentType;
    this.command = command;
    this.cwd = process.cwd();
  }

  /**
   * 确保 .ufoo 目录已初始化
   */
  async ensureInit() {
    const ufooDir = path.join(this.cwd, ".ufoo");
    const busDir = path.join(ufooDir, "bus");

    if (!fs.existsSync(busDir)) {
      // 调用 ufoo init
      spawnSync("ufoo", ["init", "--modules", "context,bus"], {
        cwd: this.cwd,
        stdio: "ignore",
      });
    }

    // 检查 AGENTS.md 是否有 ufoo template
    const agentsFile = path.join(this.cwd, "AGENTS.md");
    if (fs.existsSync(agentsFile)) {
      const content = fs.readFileSync(agentsFile, "utf8");
      if (!content.includes("<!-- ufoo -->")) {
        spawnSync("ufoo", ["init", "--modules", "context,bus"], {
          cwd: this.cwd,
          stdio: "ignore",
        });
      }
    }
  }

  /**
   * 生成或复用 session ID
   */
  generateSessionId() {
    const envVar =
      this.agentType === "claude-code"
        ? "CLAUDE_SESSION_ID"
        : "CODEX_SESSION_ID";

    if (process.env[envVar]) {
      return process.env[envVar];
    }

    const id = crypto.randomBytes(4).toString("hex");
    process.env[envVar] = id;
    return id;
  }

  /**
   * 加入 event bus
   */
  async joinBus(sessionId) {
    const bus = new EventBus(this.cwd);
    await bus.init();

    const nickname = process.env.UFOO_NICKNAME || "";

    // 设置 UFOO_PARENT_PID 用于 bus 注册
    process.env.UFOO_PARENT_PID = process.pid.toString();

    // 直接调用 subscriberManager 获取完整结果
    bus.loadBusData();
    const result = await bus.subscriberManager.join(
      sessionId,
      this.agentType,
      nickname
    );
    bus.saveBusData();

    // 返回完整结果 { subscriber, nickname }
    return result;
  }

  /**
   * 确保 daemon 正在运行
   */
  async ensureDaemon() {
    const pidFile = path.join(this.cwd, ".ufoo/run/ufoo-daemon.pid");

    if (fs.existsSync(pidFile)) {
      const pidStr = fs.readFileSync(pidFile, "utf8").trim();
      if (pidStr) {
        const pid = parseInt(pidStr, 10);
        try {
          process.kill(pid, 0); // Check if alive
          return "running";
        } catch {
          // Dead, start new
        }
      }
    }

    // Start daemon using correct command
    spawnSync("ufoo", ["daemon", "start"], {
      cwd: this.cwd,
      stdio: "ignore",
      detached: true,
    });

    // Wait for daemon socket to be ready
    const sockFile = path.join(this.cwd, ".ufoo/run/ufoo.sock");
    for (let i = 0; i < 30; i++) {
      if (fs.existsSync(sockFile)) {
        try {
          const stat = fs.statSync(sockFile);
          if (stat.isSocket()) {
            break;
          }
        } catch {
          // Continue waiting
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return "started";
  }

  /**
   * 启动 agent
   */
  async launch(args) {
    try {
      // 1. 确保初始化
      await this.ensureInit();

      // 2. 生成 session ID
      const sessionId = this.generateSessionId();

      // 3. Join bus
      const result = await this.joinBus(sessionId);

      // 4. 确保 daemon 运行
      const daemonStatus = await this.ensureDaemon();

      // 5. 显示 banner
      showBanner({
        agentType: this.agentType,
        sessionId,
        nickname: result.nickname,
        daemonStatus,
      });

      // 6. 启动消息通知监听器
      const notifier = new AgentNotifier(this.cwd, result.subscriber);
      notifier.start();

      // 7. 启动命令
      const child = spawn(this.command, args, {
        cwd: this.cwd,
        stdio: "inherit",
        env: {
          ...process.env,
          // 只设置当前 agent 类型的 session ID，避免污染
          ...(this.agentType === "claude-code"
            ? { CLAUDE_SESSION_ID: sessionId, CODEX_SESSION_ID: "" }
            : { CODEX_SESSION_ID: sessionId, CLAUDE_SESSION_ID: "" }),
        },
      });

      child.on("error", (err) => {
        console.error(`[${this.command}] Failed to start:`, err.message);
        process.exit(1);
      });

      child.on("exit", async (code, signal) => {
        // 清理 bus 状态
        try {
          const bus = new EventBus(this.cwd);
          bus.loadBusData();
          await bus.subscriberManager.leave(result.subscriber);
          bus.saveBusData();
        } catch {
          // ignore cleanup errors
        }

        if (signal) {
          console.log(`\n[${this.command}] killed by signal ${signal}`);
        }
        process.exit(code || 0);
      });
    } catch (err) {
      console.error(`[${this.command}] Error:`, err.message);
      process.exit(1);
    }
  }
}

module.exports = AgentLauncher;
