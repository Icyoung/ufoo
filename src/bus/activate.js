const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/**
 * 激活指定 agent 的终端
 */
class AgentActivator {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.busFile = path.join(projectRoot, ".ufoo/bus/bus.json");
  }

  /**
   * 获取 agent 信息
   */
  getAgentInfo(agentId) {
    try {
      if (!fs.existsSync(this.busFile)) {
        throw new Error("Bus not initialized");
      }

      const busData = JSON.parse(fs.readFileSync(this.busFile, "utf8"));
      const meta = busData.subscribers?.[agentId];

      if (!meta) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      return {
        id: agentId,
        nickname: meta.nickname || "",
        tty: meta.tty || "",
        tmux_pane: meta.tmux_pane || "",
        launch_mode: meta.launch_mode || "",
      };
    } catch (err) {
      throw new Error(`Failed to get agent info: ${err.message}`);
    }
  }

  /**
   * 激活 Terminal.app 的 tab
   */
  activateTerminalTab(tty) {
    return new Promise((resolve, reject) => {
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
    error "Terminal tab not found with tty: ${tty}"
  end if

  -- Activate and bring to front
  activate
  set selected tab of targetWindow to targetTab
  set index of targetWindow to 1
end tell
      `.trim();

      const proc = spawn("osascript", ["-e", script]);
      let stderr = "";

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || "Failed to activate Terminal tab"));
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * 激活 tmux pane
   */
  activateTmuxPane(paneId) {
    return new Promise((resolve, reject) => {
      // 首先检查 pane 是否存在
      const checkProc = spawn("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
      let output = "";

      checkProc.stdout.on("data", (data) => {
        output += data.toString();
      });

      checkProc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error("tmux is not running"));
          return;
        }

        const panes = output.trim().split("\n");
        if (!panes.includes(paneId)) {
          reject(new Error(`tmux pane not found: ${paneId}`));
          return;
        }

        // 激活 pane（选择 window 和 pane）
        const selectProc = spawn("tmux", ["select-pane", "-t", paneId]);

        selectProc.on("close", (selectCode) => {
          if (selectCode === 0) {
            resolve();
          } else {
            reject(new Error("Failed to select tmux pane"));
          }
        });

        selectProc.on("error", reject);
      });

      checkProc.on("error", reject);
    });
  }

  /**
   * 激活 agent 的终端
   */
  async activate(agentId) {
    const info = this.getAgentInfo(agentId);

    if (info.launch_mode === "internal") {
      throw new Error("Internal mode agents cannot be activated (no terminal)");
    }

    if (info.launch_mode === "tmux" && info.tmux_pane) {
      console.log(`[activate] Activating tmux pane: ${info.tmux_pane}`);
      await this.activateTmuxPane(info.tmux_pane);
      console.log("[activate] ✓ Activated");
      return;
    }

    if (info.launch_mode === "terminal" && info.tty) {
      console.log(`[activate] Activating Terminal.app tab: ${info.tty}`);
      await this.activateTerminalTab(info.tty);
      console.log("[activate] ✓ Activated");
      return;
    }

    throw new Error("Cannot activate: missing tty or tmux_pane information");
  }
}

module.exports = AgentActivator;
