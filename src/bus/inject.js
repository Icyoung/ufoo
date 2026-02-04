const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { subscriberToSafeName, isValidTty, logError } = require("./utils");

/**
 * 命令注入器 - 将命令注入到终端
 */
class Injector {
  constructor(busDir) {
    this.busDir = busDir;
  }

  /**
   * 获取订阅者的 tty 文件路径
   */
  getTtyPath(subscriber) {
    const safeName = subscriberToSafeName(subscriber);
    return path.join(this.busDir, "queues", safeName, "tty");
  }

  /**
   * 获取订阅者的 tmux pane ID（从 bus.json）
   */
  getTmuxPane(subscriber) {
    const busFile = path.join(this.busDir, "bus.json");
    if (!fs.existsSync(busFile)) return null;

    try {
      const busData = JSON.parse(fs.readFileSync(busFile, "utf8"));
      return busData.subscribers?.[subscriber]?.tmux_pane || null;
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
   * 发送 tmux 按键
   */
  sendTmuxKeys(paneId, command, resolve, reject) {
    const proc = spawn("tmux", ["send-keys", "-t", paneId, command, "Enter"]);
    let stderr = "";

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || "tmux send-keys failed"));
      }
    });

    proc.on("error", reject);
  }

  /**
   * 使用 AppleScript 注入命令到 Terminal.app
   */
  async injectTerminal(tty, command) {
    const script = `
tell application "Terminal"
    set targetWindow to missing value
    set targetTab to missing value

    repeat with w in windows
        repeat with t in tabs of w
            try
                if tty of t is "${tty}" then
                    set targetWindow to w
                    set targetTab to t
                    exit repeat
                end if
            end try
        end repeat
        if targetTab is not missing value then exit repeat
    end repeat

    if targetTab is missing value then
        error "No Terminal tab found with tty: ${tty}"
    end if

    -- Activate and bring to front
    activate
    set selected tab of targetWindow to targetTab
    set index of targetWindow to 1
end tell

-- Save current clipboard, set command, paste, restore
set oldClipboard to the clipboard

set the clipboard to "${command}"
delay 0.1

tell application "System Events"
    tell process "Terminal"
        -- Escape to ensure input mode
        key code 53
        delay 0.1
        -- Cmd+V to paste
        keystroke "v" using command down
        delay 0.2
        -- Enter (Return key)
        keystroke return
    end tell
end tell

delay 0.2
set the clipboard to oldClipboard
    `.trim();

    return new Promise((resolve, reject) => {
      const proc = spawn("osascript", ["-e", script]);
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || "AppleScript failed"));
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * 检查 iTerm2 是否在运行
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
   * 使用 iTerm2 注入命令
   */
  async injectIterm(tty, command) {
    const script = `
tell application "iTerm2"
    activate
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                try
                    if tty of s is "${tty}" then
                        select s
                        write text "${command}" to s
                        return
                    end if
                end try
            end repeat
        end repeat
    end repeat
    error "No iTerm2 session found with tty: ${tty}"
end tell
    `.trim();

    return new Promise((resolve, reject) => {
      const proc = spawn("osascript", ["-e", script]);
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || "iTerm2 AppleScript failed"));
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * 注入命令到订阅者的终端
   */
  async inject(subscriber) {
    // 确定注入命令（codex 用 "ubus"，claude-code 用 "/ubus"）
    const command = subscriber.startsWith("codex:") ? "ubus" : "/ubus";

    // 读取 tty
    const tty = this.readTty(subscriber);
    if (!tty || !isValidTty(tty)) {
      throw new Error(`No tty recorded for ${subscriber}`);
    }

    console.log(`[inject] Looking for terminal with tty: ${tty}`);

    // 优先尝试 tmux
    const tmuxPane = this.getTmuxPane(subscriber);
    if (tmuxPane) {
      const paneExists = await this.checkTmuxPane(tmuxPane);
      if (paneExists) {
        console.log(`[inject] Using tmux send-keys for pane: ${tmuxPane}`);
        await this.injectTmux(tmuxPane, command);
        console.log("[inject] Done");
        return;
      }
      const fallbackPane = await this.findTmuxPaneByTty(tty);
      if (fallbackPane) {
        console.log(`[inject] Using tmux send-keys for pane: ${fallbackPane}`);
        await this.injectTmux(fallbackPane, command);
        console.log("[inject] Done");
        return;
      }
    }

    // iTerm2 fallback (if running)
    if (this.isItermRunning()) {
      try {
        console.log("[inject] Using iTerm2 write text method");
        await this.injectIterm(tty, command);
        console.log("[inject] Done");
        return;
      } catch (err) {
        console.log(`[inject] iTerm2 failed, falling back to Terminal.app: ${err.message}`);
      }
    }

    // 回退到 Terminal.app
    console.log("[inject] Using Terminal.app keystroke method");
    await this.injectTerminal(tty, command);
    console.log("[inject] Done");
  }
}

module.exports = Injector;
