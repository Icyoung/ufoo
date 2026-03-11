const fs = require("fs");
const { getUfooPaths } = require("../ufoo/paths");
const { spawn, spawnSync } = require("child_process");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");

/**
 * 激活指定 agent 的终端
 *
 * 支持的方式：
 * - tmux: 使用 tmux select-pane 激活
 * - terminal: 使用 AppleScript 通过 tty 定位并激活 Terminal.app 的 tab/window
 * - internal: 不支持自动激活（由 chat PTY view 处理）
 */
class AgentActivator {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    const paths = getUfooPaths(projectRoot);
    this.agentsFile = paths.agentsFile;
  }

  /**
   * 获取 agent 信息
   */
  getAgentInfo(agentId) {
    try {
      if (!fs.existsSync(this.agentsFile)) {
        throw new Error("Bus not initialized");
      }

      const busData = JSON.parse(fs.readFileSync(this.agentsFile, "utf8"));
      const meta = busData.agents?.[agentId];

      if (!meta) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      return {
        id: agentId,
        nickname: meta.nickname || "",
        tty: meta.tty || "",
        tmux_pane: meta.tmux_pane || "",
        launch_mode: meta.launch_mode || "",
        host_inject_sock: meta.host_inject_sock || "",
        host_daemon_sock: meta.host_daemon_sock || "",
        host_name: meta.host_name || "",
        host_session_id: meta.host_session_id || "",
        host_capabilities: meta.host_capabilities || null,
      };
    } catch (err) {
      throw new Error(`Failed to get agent info: ${err.message}`);
    }
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
   * 通过 tty 激活 Terminal.app 中对应的 tab/window
   */
  activateTerminalByTty(ttyPath) {
    if (process.platform !== "darwin") {
      throw new Error("Terminal activation is only supported on macOS");
    }
    if (!ttyPath) {
      throw new Error("Cannot activate: tty path required");
    }

    const script = `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${ttyPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" then
        set selected tab of w to t
        set index of w to 1
        activate
        return "ok"
      end if
    end repeat
  end repeat
  return "not found"
end tell`;

    const result = spawnSync("osascript", ["-e", script], {
      encoding: "utf8",
      timeout: 5000,
    });

    if (result.status !== 0) {
      throw new Error(`AppleScript failed: ${(result.stderr || "").trim()}`);
    }

    const output = (result.stdout || "").trim();
    if (output === "not found") {
      throw new Error(`Terminal tab not found for tty: ${ttyPath}`);
    }
  }

  /**
   * 激活 agent 的终端
   */
  async activate(agentId) {
    const info = this.getAgentInfo(agentId);

    const activateTerminal = async () => {
      if (info.tty) {
        this.activateTerminalByTty(info.tty);
        return;
      }
      throw new Error("Cannot activate: missing tty or tmux_pane for agent");
    };

    const activateTmux = async () => {
      if (info.tmux_pane) {
        await this.activateTmuxPane(info.tmux_pane);
        return;
      }
      throw new Error("Cannot activate: missing tty or tmux_pane for agent");
    };

    const adapterRouter = createTerminalAdapterRouter({
      activateTerminal,
      activateTmux,
    });
    const adapter = adapterRouter.getAdapter({
      launchMode: info.launch_mode,
      agentId,
      meta: info,
    });

    if (info.launch_mode === "host" && typeof adapter.connect === "function") {
      try {
        await adapter.connect();
      } catch {
        // fall back to seeded capabilities from bus metadata
      }
    }

    if (!adapter.capabilities.supportsActivate) {
      if (adapter.capabilities.supportsInternalQueueLoop) {
        throw new Error("Internal mode agents cannot be activated (no terminal window)");
      }
      throw new Error("Cannot activate: missing tty or tmux_pane for agent");
    }

    const activated = await adapter.activate();
    if (activated === false) {
      throw new Error("Host activation request was rejected");
    }
  }
}

module.exports = AgentActivator;
