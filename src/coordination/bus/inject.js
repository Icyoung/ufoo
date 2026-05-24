const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { subscriberToSafeName, isValidTty } = require("./utils");
const { createTerminalAdapterRouter } = require("../../runtime/terminal/adapterRouter");

const SHOULD_LOG_INJECT = process.env.UFOO_INJECT_DEBUG === "1";
const logInject = (message) => {
  if (SHOULD_LOG_INJECT) {
    console.log(message);
  }
};

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function appleScriptStringLiteral(value) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length === 0) return '""';
  return lines.map((line) => `"${escapeAppleScriptString(line)}"`).join(" & linefeed & ");
}

function runAppleScript(lines = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", lines.flatMap((line) => ["-e", line]));
    let stderr = "";
    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || "AppleScript failed"));
      }
    });
    proc.on("error", reject);
  });
}

/**
 * 命令注入器 - 将命令注入到终端
 *
 * 支持的方式：
 * 1. PTY socket（直接写入，无需macOS权限）
 * 2. tmux send-keys（无需权限）
 * 3. Terminal.app/iTerm2 tty lookup（macOS terminal mode fallback）
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
   * Use Terminal.app's tty metadata to locate the target tab and paste input.
   */
  async injectTerminal(tty, command) {
    const ttyLiteral = appleScriptStringLiteral(tty);
    const commandLiteral = appleScriptStringLiteral(command);
    const lines = [
      'tell application "Terminal"',
      "  set targetWindow to missing value",
      "  set targetTab to missing value",
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      try",
      `        if tty of t is ${ttyLiteral} then`,
      "          set targetWindow to w",
      "          set targetTab to t",
      "          exit repeat",
      "        end if",
      "      end try",
      "    end repeat",
      "    if targetTab is not missing value then exit repeat",
      "  end repeat",
      "  if targetTab is missing value then",
      `    error "No Terminal tab found with tty: " & ${ttyLiteral}`,
      "  end if",
      "  activate",
      "  set selected tab of targetWindow to targetTab",
      "  set index of targetWindow to 1",
      "end tell",
      "set oldClipboard to the clipboard",
      "try",
      `  set the clipboard to ${commandLiteral}`,
      "  delay 0.1",
      '  tell application "System Events"',
      '    tell process "Terminal"',
      "      key code 53",
      "      delay 0.1",
      '      keystroke "v" using command down',
      "      delay 0.2",
      "      keystroke return",
      "    end tell",
      "  end tell",
      "on error errMsg number errNo",
      "  set the clipboard to oldClipboard",
      "  error errMsg number errNo",
      "end try",
      "delay 0.2",
      "set the clipboard to oldClipboard",
    ];

    return runAppleScript(lines);
  }

  /**
   * Check if iTerm2 is available before trying its direct write API.
   */
  isItermRunning() {
    try {
      const res = spawnSync("osascript", ["-e", 'application "iTerm2" is running'], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return res.status === 0 && String(res.stdout || "").trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Use iTerm2's tty metadata to locate the target session and write input.
   */
  async injectIterm(tty, command) {
    const ttyLiteral = appleScriptStringLiteral(tty);
    const commandLiteral = appleScriptStringLiteral(command);
    const lines = [
      'tell application "iTerm2"',
      "  activate",
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      "        try",
      `          if tty of s is ${ttyLiteral} then`,
      "            select s",
      `            write text ${commandLiteral} to s`,
      "            return",
      "          end if",
      "        end try",
      "      end repeat",
      "    end repeat",
      "  end repeat",
      `  error "No iTerm2 session found with tty: " & ${ttyLiteral}`,
      "end tell",
    ];

    return runAppleScript(lines);
  }

  async injectMacTerminal(tty, command, meta = {}) {
    if (process.platform !== "darwin") {
      throw new Error("Terminal.app injection is only supported on macOS");
    }

    const terminalApp = String(meta.terminal_app || meta.terminalApp || "").trim().toLowerCase();
    const shouldTryIterm = terminalApp === "iterm2" || (!terminalApp && this.isItermRunning());

    if (shouldTryIterm) {
      try {
        logInject(`[inject] Using iTerm2 AppleScript for tty: ${tty}`);
        await this.injectIterm(tty, command);
        return;
      } catch (err) {
        if (terminalApp === "iterm2") {
          throw err;
        }
        logInject(`[inject] iTerm2 failed: ${err.message}, trying Terminal.app`);
      }
    }

    logInject(`[inject] Using Terminal.app AppleScript for tty: ${tty}`);
    await this.injectTerminal(tty, command);
  }

  /**
   * 获取订阅者的 inject socket 路径
   */
  getInjectSockPath(subscriber) {
    const safeName = subscriberToSafeName(subscriber);
    return path.join(this.busDir, "queues", safeName, "inject.sock");
  }

  /**
   * 使用指定路径的 PTY socket 注入命令
   */
  async injectPtyAtPath(sockPath, command) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(sockPath, () => {
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
   * 使用 PTY socket 直接注入命令（无需macOS权限）
   */
  async injectPty(subscriber, command) {
    const sockPath = this.getInjectSockPath(subscriber);

    if (!fs.existsSync(sockPath)) {
      throw new Error(`Inject socket not found: ${sockPath}`);
    }

    return this.injectPtyAtPath(sockPath, command);
  }

  /**
   * 注入命令到订阅者的终端
   *
   * 优先级：
   * 1. PTY socket（直接写入，无需macOS权限）
   * 2. tmux send-keys（无需权限）
   * 3. Terminal.app/iTerm2 tty lookup（terminal mode fallback）
   */
  async inject(subscriber, commandOverride = "") {
    if (String(subscriber || "").startsWith("ufoo-code:")) {
      throw new Error(`Inject disabled for ${subscriber}. ufoo-code consumes bus internally.`);
    }

    // 确定注入命令：
    // - codex: 裸 "ubus"（codex 没有 slash-command 命名空间）
    // - agy: 裸 "ubus"（agy 的 `/` 是它自己的 slash-command 命名空间，
    //   "/ubus" 会被识别为 unknown slash command 而不是 prompt）
    // - claude-code 及其他: "/ubus"
    const command = commandOverride
      ? String(commandOverride)
      : (
        subscriber.startsWith("codex:") || subscriber.startsWith("agy:")
          ? "ubus"
          : "/ubus"
      );

    const meta = this.getAgentMeta(subscriber) || {};
    const launchMode = meta.launch_mode || "";
    const adapterRouter = createTerminalAdapterRouter();
    const adapter = adapterRouter.getAdapter({ launchMode, agentId: subscriber, meta });
    const supportsSocket = adapter.capabilities.supportsSocketProtocol;
    const supportsNotifier = adapter.capabilities.supportsNotifierInjector;

    // 0. Try Terminal Host inject socket (ufoo Terminal Host Protocol)
    const hostSock = (meta.host_inject_sock || "").toString();
    if (hostSock && fs.existsSync(hostSock)) {
      try {
        logInject(`[inject] Using host inject socket: ${hostSock}`);
        await this.injectPtyAtPath(hostSock, command);
        logInject("[inject] Host inject success");
        return;
      } catch (err) {
        logInject(`[inject] Host inject failed: ${err.message}, trying PTY socket`);
      }
    }

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

    // 读取 tty（tmux/Terminal.app fallback 需要）
    const recordedTty = this.readTty(subscriber);
    const metaTty = isValidTty(meta.tty) ? meta.tty : "";
    const tty = recordedTty || metaTty;

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

    // 3. Plain Terminal.app/iTerm2 fallback: locate the window/tab by tty and paste input.
    const allowMacTerminalFallback = (launchMode === "terminal" || (!launchMode && tty && isValidTty(tty)))
      && tty
      && isValidTty(tty);
    if (allowMacTerminalFallback) {
      await this.injectMacTerminal(tty, command, meta);
      return;
    }

    // 没有可用的注入方式
    throw new Error(`No inject method available for ${subscriber}. PTY socket, tmux, or Terminal.app injection required.`);
  }
}

module.exports = Injector;
