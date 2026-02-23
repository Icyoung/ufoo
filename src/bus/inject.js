const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { subscriberToSafeName, isValidTty } = require("./utils");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");

const SHOULD_LOG_INJECT = process.env.UFOO_INJECT_DEBUG === "1";
const logInject = (message) => {
  if (SHOULD_LOG_INJECT) {
    console.log(message);
  }
};

/**
 * 命令注入器 - 将命令注入到终端
 *
 * 支持的方式：
 * 1. PTY socket（直接写入，无需macOS权限）
 * 2. tmux send-keys（无需权限）
 */
class Injector {
  constructor(busDir, agentsFile) {
    this.busDir = busDir;
    this.agentsFile = agentsFile;
  }

  /**
   * 获取订阅者的 tty 文件路径
   */
  getTtyPath(subscriber) {
    const safeName = subscriberToSafeName(subscriber);
    return path.join(this.busDir, "queues", safeName, "tty");
  }

  /**
   * 获取订阅者的 tmux pane ID（从 all-agents.json）
   */
  getAgentMeta(subscriber) {
    const agentsFile = this.agentsFile;
    if (!agentsFile || !fs.existsSync(agentsFile)) return null;

    try {
      const busData = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
      return busData.agents?.[subscriber] || null;
    } catch {
      return null;
    }
  }

  getTmuxPane(subscriber) {
    const agentsFile = this.agentsFile;
    if (!agentsFile || !fs.existsSync(agentsFile)) return null;

    try {
      const busData = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
      return busData.agents?.[subscriber]?.tmux_pane || null;
    } catch {
      return null;
    }
  }

  /**
   * 读取 tty 设备路径
   */
  readTty(subscriber) {
    const ttyPath = this.getTtyPath(subscriber);
    if (!fs.existsSync(ttyPath)) {
      return null;
    }
    return fs.readFileSync(ttyPath, "utf8").trim();
  }

  /**
   * 检查 tmux pane 是否存在
   */
  async checkTmuxPane(paneId) {
    return new Promise((resolve) => {
      const proc = spawn("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
      let output = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        const panes = output.trim().split("\n");
        resolve(panes.includes(paneId));
      });

      proc.on("error", () => resolve(false));
    });
  }

  /**
   * 根据 tty 查找 tmux pane
   */
  async findTmuxPaneByTty(tty) {
    return new Promise((resolve) => {
      const proc = spawn("tmux", ["list-panes", "-a", "-F", "#{pane_id} #{pane_tty}"]);
      let output = "";

      proc.stdout.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const lines = output.trim().split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && parts[1] === tty) {
            resolve(parts[0]);
            return;
          }
        }
        resolve(null);
      });

      proc.on("error", () => resolve(null));
    });
  }

  /**
   * 使用 tmux send-keys 注入命令
   */
  async injectTmux(paneId, command) {
    return new Promise((resolve, reject) => {
      // 检查是否需要发送中断信号
      if (process.env.UFOO_INJECT_INTERRUPT === "1") {
        spawn("tmux", ["send-keys", "-t", paneId, "C-c"]);
        setTimeout(() => {
          this.sendTmuxKeys(paneId, command, resolve, reject);
        }, 100);
      } else {
        this.sendTmuxKeys(paneId, command, resolve, reject);
      }
    });
  }

  /**
   * 发送 tmux 按键（先发文本，延迟后发 Enter）
   */
  sendTmuxKeys(paneId, command, resolve, reject) {
    const textProc = spawn("tmux", ["send-keys", "-t", paneId, command]);
    let stderr = "";

    textProc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    textProc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || "tmux send-keys failed"));
        return;
      }
      // Delay before sending Enter — gives the target app time to process input
      setTimeout(() => {
        const enterProc = spawn("tmux", ["send-keys", "-t", paneId, "Enter"]);
        enterProc.on("close", (enterCode) => {
          if (enterCode === 0) resolve();
          else reject(new Error("tmux send-keys Enter failed"));
        });
        enterProc.on("error", reject);
      }, 150);
    });

    textProc.on("error", reject);
  }

  /**
   * 获取订阅者的 inject socket 路径
   */
  getInjectSockPath(subscriber) {
    const safeName = subscriberToSafeName(subscriber);
    return path.join(this.busDir, "queues", safeName, "inject.sock");
  }

  /**
   * 使用 PTY socket 直接注入命令（无需macOS权限）
   */
  async injectPty(subscriber, command) {
    const sockPath = this.getInjectSockPath(subscriber);

    if (!fs.existsSync(sockPath)) {
      throw new Error(`Inject socket not found: ${sockPath}`);
    }

    return new Promise((resolve, reject) => {
      const client = net.createConnection(sockPath, () => {
        // 发送inject请求
        client.write(JSON.stringify({ type: "inject", command }) + "\n");
      });

      let buffer = "";
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error("PTY inject timeout"));
      }, 5000);

      client.on("data", (data) => {
        buffer += data.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          clearTimeout(timeout);
          try {
            const res = JSON.parse(line);
            client.end();
            if (res.ok) {
              resolve();
            } else {
              reject(new Error(res.error || "PTY inject failed"));
            }
          } catch (err) {
            client.end();
            reject(err);
          }
          return;
        }
      });

      client.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      client.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * 注入命令到订阅者的终端
   *
   * 优先级：
   * 1. PTY socket（直接写入，无需macOS权限）
   * 2. tmux send-keys（无需权限）
   */
  async inject(subscriber, commandOverride = "") {
    if (String(subscriber || "").startsWith("ufoo-code:")) {
      throw new Error(`Inject disabled for ${subscriber}. ufoo-code consumes bus internally.`);
    }

    // 确定注入命令（codex 用 "ubus"，claude-code 用 "/ubus"）
    const command = commandOverride
      ? String(commandOverride)
      : (subscriber.startsWith("codex:") ? "ubus" : "/ubus");

    const meta = this.getAgentMeta(subscriber) || {};
    const launchMode = meta.launch_mode || "";
    const adapterRouter = createTerminalAdapterRouter();
    const adapter = adapterRouter.getAdapter({ launchMode, agentId: subscriber });
    const supportsSocket = adapter.capabilities.supportsSocketProtocol;
    const supportsNotifier = adapter.capabilities.supportsNotifierInjector;

    // 1. 优先尝试 PTY socket（无需任何macOS权限）
    const injectSockPath = this.getInjectSockPath(subscriber);
    if (fs.existsSync(injectSockPath)) {
      try {
        if (!supportsSocket) {
          logInject(`[inject] PTY socket present but unsupported for launch_mode=${launchMode}`);
        } else {
          logInject(`[inject] Using PTY socket: ${injectSockPath}`);
        }
        await this.injectPty(subscriber, command);
        logInject("[inject] PTY inject success");
        return;
      } catch (err) {
        logInject(`[inject] PTY socket failed: ${err.message}, trying tmux`);
      }
    }

    // 读取 tty（tmux 需要）
    const tty = this.readTty(subscriber);

    // 2. 尝试 tmux（无需权限）
    // Launch mode may be temporarily missing/stale (e.g. rejoin from non-interactive context).
    // In that case still try tmux fallback by pane/tty.
    const allowTmuxFallback = supportsNotifier || !launchMode || launchMode === "terminal" || launchMode === "tmux";
    if (allowTmuxFallback) {
      const tmuxPane = meta.tmux_pane || this.getTmuxPane(subscriber);
      if (tmuxPane) {
        const paneExists = await this.checkTmuxPane(tmuxPane);
        if (paneExists) {
          logInject(`[inject] Using tmux send-keys for pane: ${tmuxPane}`);
          await this.injectTmux(tmuxPane, command);
          return;
        }
      }

      // Try resolving pane via tty when tmux pane metadata is missing.
      if (tty && isValidTty(tty)) {
        const fallbackPane = await this.findTmuxPaneByTty(tty);
        if (fallbackPane) {
          logInject(`[inject] Using tmux send-keys for pane: ${fallbackPane}`);
          await this.injectTmux(fallbackPane, command);
          return;
        }
      }
    }

    // 没有可用的注入方式
    throw new Error(`No inject method available for ${subscriber}. PTY socket or tmux required.`);
  }
}

module.exports = Injector;
