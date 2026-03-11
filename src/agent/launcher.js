const { IPC_REQUEST_TYPES } = require("../shared/eventContract");
const { PTY_SOCKET_MESSAGE_TYPES } = require("../shared/ptySocketContract");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const EventBus = require("../bus");
const { isAgentPidAlive } = require("../bus/utils");
const { showBanner } = require("../utils/banner");
const AgentNotifier = require("./notifier");
const { ActivityDetector } = require("./activityDetector");
const { createActivityStatePublisher } = require("./activityStatePublisher");
const { getUfooPaths } = require("../ufoo/paths");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { probeHostCapabilities } = require("../terminal/adapters/hostAdapter");
const PtyWrapper = require("./ptyWrapper");
const ReadyDetector = require("./readyDetector");

function connectSocket(sockPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => resolve(client));
    client.on("error", reject);
  });
}

async function connectWithRetry(sockPath, retries, delayMs) {
  for (let i = 0; i < retries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const client = await connectSocket(sockPath);
      return client;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

async function probeDaemonSocket(sockPath) {
  try {
    const client = await connectSocket(sockPath);
    try {
      client.end();
      client.destroy();
    } catch {
      // ignore cleanup errors
    }
    return { ok: true, code: "" };
  } catch (err) {
    return { ok: false, code: err && err.code ? err.code : "" };
  }
}

function normalizeTty(ttyPath) {
  if (!ttyPath) return "";
  const trimmed = String(ttyPath).trim();
  if (!trimmed || trimmed === "not a tty") return "";
  if (trimmed === "/dev/tty") return "";
  return trimmed;
}

function getEnvTtyOverride() {
  const override = normalizeTty(process.env.UFOO_TTY_OVERRIDE || "");
  return override;
}

function detectTtyOnce() {
  try {
    const res = spawnSync("tty", {
      stdio: [0, "pipe", "ignore"],
      encoding: "utf8",
    });
    if (res && res.status === 0) {
      const tty = normalizeTty(res.stdout || "");
      if (tty) return tty;
    }
  } catch {
    // ignore
  }
  return "";
}

async function detectTtyWithRetry(retries = 3, delayMs = 50) {
  for (let i = 0; i < retries; i += 1) {
    const tty = detectTtyOnce();
    if (tty) return tty;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return "";
}

/**
 * 查找当前 TTY/tmux pane 对应的旧 session
 * 用于在同一终端重启时自动恢复之前的会话
 *
 * 匹配规则：
 * - tmux 模式：优先匹配 tmux_pane（每个 pane 有唯一 ID 如 %0, %1）
 * - terminal 模式：匹配 tty（如 /dev/ttys001）
 */
function findPreviousSession(cwd, agentType, tty, tmuxPane) {
  if (!tty && !tmuxPane) return null;

  try {
    const agentsFile = getUfooPaths(cwd).agentsFile;
    if (!fs.existsSync(agentsFile)) return null;

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    const agents = data.agents || {};

    // 查找匹配的旧 session
    for (const [id, meta] of Object.entries(agents)) {
      if (!meta) continue;

      // 必须是同类型 agent
      if (meta.agent_type !== agentType) continue;

      // tmux 模式：必须匹配 tmux_pane（更精确）
      if (tmuxPane) {
        if (meta.tmux_pane !== tmuxPane) continue;
      } else if (tty) {
        // terminal 模式：匹配 tty
        if (meta.tty !== tty) continue;
      } else {
        continue;
      }

      // 检查旧进程是否已经退出
      if (meta.pid && isAgentPidAlive(meta.pid)) {
        // 旧进程还在运行，不能复用
        continue;
      }

      // 找到了可以复用的旧 session
      const parts = id.split(":");
      if (parts.length !== 2) continue;

      return {
        sessionId: parts[1],
        subscriberId: id,
        nickname: meta.nickname || "",
        providerSessionId: meta.provider_session_id || "",
      };
    }
  } catch {
    // ignore errors
  }

  return null;
}

function resolveLaunchMode() {
  const explicit = process.env.UFOO_LAUNCH_MODE || "";
  if (explicit) return explicit;
  if (process.env.UFOO_HOST_SESSION_ID) return "host";
  // Deprecated: HORIZON_SESSION_ID fallback (remove after migration)
  if (process.env.HORIZON_SESSION_ID) {
    if (process.env.UFOO_DEBUG) {
      console.error("[launcher] HORIZON_SESSION_ID is deprecated, use UFOO_HOST_SESSION_ID");
    }
    return "host";
  }
  if (process.env.TMUX_PANE) return "tmux";
  return "terminal";
}

function shouldShowLaunchBanner(agentType = "") {
  if (process.env.UFOO_SUPPRESS_LAUNCHER_BANNER === "1") return false;
  void agentType;
  return true;
}

async function resolveHostRegistrationData(launchMode) {
  if (launchMode !== "host") {
    return {
      hostInjectSock: "",
      hostDaemonSock: "",
      hostName: "",
      hostSessionId: "",
      hostCapabilities: null,
    };
  }

  const hostInjectSock = process.env.UFOO_HOST_INJECT_SOCK
    || process.env.HORIZON_INJECT_SOCK
    || "";
  const hostDaemonSock = process.env.UFOO_HOST_DAEMON_SOCK || "";
  const hostName = process.env.UFOO_HOST_NAME || "";
  const hostSessionId = process.env.UFOO_HOST_SESSION_ID
    || process.env.HORIZON_SESSION_ID
    || "";

  let hostCapabilities = null;
  if (hostInjectSock || hostDaemonSock) {
    try {
      hostCapabilities = await probeHostCapabilities({
        injectSock: hostInjectSock,
        daemonSock: hostDaemonSock,
        timeoutMs: 1000,
      });
    } catch {
      hostCapabilities = null;
    }
  }

  return {
    hostInjectSock,
    hostDaemonSock,
    hostName,
    hostSessionId,
    hostCapabilities,
  };
}

/**
 * Agent 启动器
 * 统一处理 agent 启动流程：初始化、daemon 注册、banner、命令执行
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
    const paths = getUfooPaths(this.cwd);
    const busDir = paths.busDir;

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
   * 解析已预注册的 subscriber（daemon 启动的情况）
   */
  async getPreRegistered() {
    const subscriberId = process.env.UFOO_SUBSCRIBER_ID || "";
    if (!subscriberId) return null;
    const parts = subscriberId.split(":");
    if (parts.length !== 2) return null;
    if (parts[0] !== this.agentType) return null;
    try {
      const bus = new EventBus(this.cwd);
      bus.loadBusData();
      const meta = bus.subscriberManager.getSubscriber(subscriberId);
      if (!meta || meta.status !== "active") return null;
      const pidValue = Number.parseInt(meta.pid, 10);
      if (Number.isFinite(pidValue) && pidValue > 0 && !isAgentPidAlive(pidValue)) {
        return null;
      }
      if (meta.agent_type && meta.agent_type !== this.agentType) return null;
      return {
        subscriberId,
        sessionId: parts[1],
        nickname: meta.nickname || process.env.UFOO_NICKNAME || "",
        preRegistered: true,
      };
    } catch {
      return null;
    }
  }

  /**
   * 确保 daemon 正在运行
   */
  async ensureDaemon() {
    const paths = getUfooPaths(this.cwd);
    const pidFile = paths.ufooDaemonPid;
    const sockFile = paths.ufooSock;

    const existingProbe = await probeDaemonSocket(sockFile);
    if (existingProbe.ok) return "running";
    if (existingProbe.code === "EPERM" && fs.existsSync(pidFile)) {
      // Sandbox may deny socket connect probes; keep prior behavior.
      return "running";
    }

    // Stale daemon runtime markers can block restart with false-positive "running".
    // Clean local runtime markers only when socket probe failed.
    try {
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(sockFile)) fs.unlinkSync(sockFile);
    } catch {
      // ignore
    }
    try {
      const lockFile = path.join(paths.runDir, "daemon.lock");
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch {
      // ignore
    }

    // Start daemon using correct command
    spawnSync("ufoo", ["daemon", "start"], {
      cwd: this.cwd,
      stdio: "ignore",
      detached: true,
    });

    // Wait for daemon socket to be ready and reachable
    let lastProbeCode = "";
    for (let i = 0; i < 30; i++) {
      const probe = await probeDaemonSocket(sockFile);
      if (probe.ok) {
        return "started";
      }
      if (probe.code === "EPERM" && fs.existsSync(pidFile)) {
        return "started";
      }
      lastProbeCode = probe.code || lastProbeCode;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(
      `Failed to start ufoo daemon${lastProbeCode ? ` (${lastProbeCode})` : ""}`
    );
  }

  /**
   * 通过 daemon socket 注册 agent
   */
  async registerWithDaemon(nickname) {
    const sockFile = getUfooPaths(this.cwd).ufooSock;
    const client = await connectWithRetry(sockFile, 25, 200);
    if (!client) {
      throw new Error("Failed to connect to ufoo daemon");
    }

    const ttyOverride = getEnvTtyOverride();
    const tty = ttyOverride || await detectTtyWithRetry();
    const tmuxPane = process.env.TMUX_PANE || "";
    const launchMode = resolveLaunchMode();

    // 只在支持 session reuse 的模式下查找旧 session（可见终端才需要恢复）
    // internal 模式由 daemon 管理，不需要自动恢复
    const adapterRouter = createTerminalAdapterRouter();
    const adapter = adapterRouter.getAdapter({ launchMode, agentId: "" });
    const shouldReuse = adapter.capabilities.supportsSessionReuse;
    const previousSession = shouldReuse
      ? findPreviousSession(this.cwd, this.agentType, tty, tmuxPane)
      : null;
    const {
      hostInjectSock,
      hostDaemonSock,
      hostName,
      hostSessionId,
      hostCapabilities,
    } = await resolveHostRegistrationData(launchMode);

    const req = {
      type: IPC_REQUEST_TYPES.REGISTER_AGENT,
      agentType: this.agentType,
      nickname: nickname || (previousSession?.nickname) || "",
      parentPid: process.pid,
      launchMode,
      tmuxPane,
      tty,
      hostInjectSock,
      hostDaemonSock,
      hostName,
      hostSessionId,
      hostCapabilities,
      skipProbe: process.env.UFOO_SKIP_SESSION_PROBE === "1",
      // 传递旧 session 信息用于复用（仅 terminal/tmux 模式）
      reuseSession: previousSession ? {
        sessionId: previousSession.sessionId,
        subscriberId: previousSession.subscriberId,
        providerSessionId: previousSession.providerSessionId,
      } : null,
    };

    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          client.destroy();
        } catch {
          // ignore
        }
        reject(new Error("register_agent timeout"));
      }, 8000);

      const cleanup = () => {
        clearTimeout(timeout);
        client.removeAllListeners();
        try {
          client.end();
        } catch {
          // ignore
        }
      };

      client.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });

      client.on("data", (data) => {
        buffer += data.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let payload;
          try {
            payload = JSON.parse(line);
          } catch {
            continue;
          }
          if (payload.type === "register_ok") {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
              subscriberId: payload.subscriberId,
              nickname: payload.nickname || nickname || "",
              sessionId: (payload.subscriberId || "").split(":")[1] || "",
              preRegistered: false,
            });
            return;
          }
          if (payload.type === "error") {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(payload.error || "register_agent failed"));
            return;
          }
        }
      });

      client.write(`${JSON.stringify(req)}\n`);
    });
  }

  /**
   * 直接spawn启动（回退逻辑）
   * @private
   */
  _spawnDirect(args, subscriberId) {
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      stdio: "inherit",
      env: process.env,
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
        await bus.subscriberManager.leave(subscriberId);
        bus.saveBusData();
      } catch {
        // ignore cleanup errors
      }

      if (signal) {
        console.log(`\n[${this.command}] killed by signal ${signal}`);
      }
      process.exit(code || 0);
    });

    return child;
  }

  /**
   * 启动 agent
   */
  async launch(args) {
    try {
      // 1. 确保初始化
      await this.ensureInit();

      // 2. 确保 daemon 运行
      const daemonStatus = await this.ensureDaemon();

      // 3. 使用 daemon 注册（或复用预注册）
      const preRegistered = await this.getPreRegistered();
      const nickname = process.env.UFOO_NICKNAME || "";
      const result = preRegistered || await this.registerWithDaemon(nickname);

      const subscriberId = result.subscriberId;
      const sessionId = result.sessionId || (subscriberId.split(":")[1] || "");
      const finalNickname = result.nickname || nickname || "";

      // 4. 更新环境变量（供子进程/后续使用）
      if (subscriberId) process.env.UFOO_SUBSCRIBER_ID = subscriberId;
      if (finalNickname) process.env.UFOO_NICKNAME = finalNickname;
      process.env.UFOO_AGENT_TYPE = this.agentType;

      // 5. 显示 banner（ucode 自带 TUI banner，这里避免重复）
      if (shouldShowLaunchBanner(this.agentType)) {
        showBanner({
          agentType: this.agentType,
          sessionId,
          nickname: finalNickname,
          daemonStatus,
        });
      }

      // 6. 启动消息通知监听器（ufoo-code 改为内部 bus 轮询消费）
      const shouldStartNotifier = String(this.agentType || "").trim().toLowerCase() !== "ufoo-code";
      if (shouldStartNotifier) {
        const notifier = new AgentNotifier(this.cwd, subscriberId);
        notifier.start();
      }

      // 7. 启动命令（PTY wrapper或直接spawn）

      // 7.1 PTY启用条件（显式开关 + 自动检测）
      let shouldUsePty = false;

      // 显式开关（优先级最高）
      if (process.env.UFOO_DISABLE_PTY === "1") {
        shouldUsePty = false;  // 强制回退spawn (CI/回滚)
      } else if (process.env.UFOO_FORCE_PTY === "1") {
        shouldUsePty = true;   // 强制使用PTY (测试/调试)
      } else {
        // 自动检测：Terminal/tmux模式 + 非internal
        shouldUsePty =
          process.stdin.isTTY &&
          process.stdout.isTTY &&
          !process.env.UFOO_INTERNAL_AGENT; // internal有专用runner（当前阶段）
      }

      // 7.2 使用PTY wrapper或回退到spawn
      if (shouldUsePty) {
        // 使用PTY wrapper
        try {
          const wrapper = new PtyWrapper(this.command, args, {
            cwd: this.cwd,
            env: process.env,
            // 未来扩展：ioAdapter: new TerminalIOAdapter()
          });

          // 启用日志记录（JSONL）
          const logFile = path.join(
            getUfooPaths(this.cwd).runDir,
            `${this.agentType}-${sessionId}-io.jsonl`
          );
          wrapper.enableLogging(logFile);

          // 启用Ready检测（监控agent初始化状态）
          const readyDetector = new ReadyDetector(this.agentType);
          // 启用ActivityDetector（持续活动状态监控）
          const launcherActivityDetector = new ActivityDetector(this.agentType, {
            mode: resolveLaunchMode(),
            startOnOutput: true,
          });
          const launcherPublisher = createActivityStatePublisher({
            agentsFile: getUfooPaths(this.cwd).agentsFile,
            subscriber: subscriberId,
            projectRoot: this.cwd,
          });
          const daemonSockPath = getUfooPaths(this.cwd).ufooSock;
          launcherActivityDetector.onChange((newState, oldState) => {
            const snap = launcherActivityDetector.getState();
            launcherPublisher.publish(newState, {
              since: snap.since,
              previous: oldState,
              detail: snap.detail,
            });
          });
          wrapper.enableMonitoring((data) => {
            readyDetector.processOutput(data);
            const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
            launcherActivityDetector.processOutput(text);
          });
          readyDetector.onReady(async () => {
            launcherActivityDetector.markReady();
            // Claude Code's Ink TUI renders ❯ prompt before the input handler
            // is fully mounted. Wait a short period for the TUI to be ready to
            // accept injected text, otherwise only the trailing CR is processed
            // and the probe command is lost.
            if (this.agentType === "claude-code") {
              await new Promise((r) => setTimeout(r, 800));
            }
            const startTime = Date.now();
            try {
              const daemonSock = await connectWithRetry(daemonSockPath, 3, 100);
              if (daemonSock) {
                daemonSock.write(`${JSON.stringify({
                  type: IPC_REQUEST_TYPES.AGENT_READY,
                  subscriberId,
                })}\n`);
                daemonSock.end();

                const notifyTime = Date.now() - startTime;
                if (process.env.UFOO_DEBUG) {
                  console.error(`[ready] notified daemon in ${notifyTime}ms`);
                }
              } else {
                if (process.env.UFOO_DEBUG) {
                  console.error(`[ready] failed to connect to daemon after retries, will use fallback delay`);
                }
              }
            } catch (err) {
              // 忽略通知失败（probe会通过fallback延迟执行）
              if (process.env.UFOO_DEBUG) {
                console.error(`[ready] daemon notification error: ${err.message}, will use fallback delay`);
              }
            }
          });

          // Fallback：如果10秒后还没检测到ready，强制标记为ready
          const forceReadyTimer = setTimeout(() => {
            readyDetector.forceReady();
          }, 10000);

          // 设置退出回调（复用清理逻辑）
          wrapper.onExit = async ({ exitCode, signal }) => {
            // 清理 timers
            clearTimeout(forceReadyTimer);
            launcherActivityDetector.destroy();

            // 清理 bus 状态
            try {
              const bus = new EventBus(this.cwd);
              bus.loadBusData();
              await bus.subscriberManager.leave(subscriberId);
              bus.saveBusData();
            } catch {
              // ignore cleanup errors
            }

            if (signal) {
              console.log(`\n[${this.command}] killed by signal ${signal}`);
            }
            process.exit(exitCode || 0);
          };

          // 启动PTY
          wrapper.spawn();
          wrapper.attachStreams(process.stdin, process.stdout, process.stderr);

          // 启动inject监听socket（用于外部注入命令到PTY）
          const injectSockPath = path.join(
            getUfooPaths(this.cwd).busQueuesDir,
            subscriberId.replace(/:/g, "_"),
            "inject.sock"
          );
          // 确保目录存在
          const injectSockDir = path.dirname(injectSockPath);
          if (!fs.existsSync(injectSockDir)) {
            fs.mkdirSync(injectSockDir, { recursive: true });
          }
          // 清理旧socket
          if (fs.existsSync(injectSockPath)) {
            fs.unlinkSync(injectSockPath);
          }

          // Output subscribers for TTY view streaming
          const outputSubscribers = new Set();

          // In-memory ring buffer of recent PTY output for replay on subscribe
          const OUTPUT_BUFFER_MAX = 256 * 1024; // 256KB
          let outputRingBuffer = "";

          // Chain monitor callback to forward output to subscribers
          const originalMonitor = wrapper.monitor;
          wrapper.monitor = {
            onOutput: (data) => {
              // Call original monitor (ReadyDetector + ActivityDetector)
              if (originalMonitor && originalMonitor.onOutput) {
                originalMonitor.onOutput(data);
              }
              // Accumulate in ring buffer
              const text = Buffer.from(data).toString("utf8");
              outputRingBuffer += text;
              if (outputRingBuffer.length > OUTPUT_BUFFER_MAX) {
                outputRingBuffer = outputRingBuffer.slice(-OUTPUT_BUFFER_MAX);
              }
              // Forward to all output subscribers
              if (outputSubscribers.size > 0) {
                const msg = JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.OUTPUT, data: text, encoding: "utf8" }) + "\n";
                for (const sub of outputSubscribers) {
                  try {
                    sub.write(msg);
                  } catch {
                    outputSubscribers.delete(sub);
                  }
                }
              }
            },
          };

          const injectServer = net.createServer((client) => {
            let buffer = "";
            client.on("data", (data) => {
              buffer += data.toString("utf8");
              const lines = buffer.split("\n");
              buffer = lines.pop() || "";

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const req = JSON.parse(line);
                  if (req.type === "inject" && req.command) {
                    const normalizedAgentType = String(this.agentType || "").trim().toLowerCase();
                    if (normalizedAgentType === "ufoo-code" || normalizedAgentType === "ucode" || normalizedAgentType === "ufoo") {
                      client.write(JSON.stringify({ ok: false, error: "inject disabled for ufoo-code (internal bus loop)" }) + "\n");
                      continue;
                    }
                    // 注入命令到PTY（带延迟确保输入完成）
                    // Claude Code (Ink TUI) interprets ESC+CR within ~100ms as
                    // Alt+Enter (newline) instead of two separate keys. Use a
                    // longer gap so the escape sequence parser times out.
                    wrapper.write(req.command);
                    if (normalizedAgentType === "claude-code") {
                      // Claude Code: send CR directly without ESC.
                      // ESC before CR is interpreted as Alt+Enter (newline).
                      setTimeout(() => {
                        wrapper.write("\r");
                      }, 200);
                    } else {
                      // Codex/others: ESC dismisses autocomplete, then CR submits.
                      setTimeout(() => {
                        wrapper.write("\x1b");
                        setTimeout(() => {
                          wrapper.write("\r");
                        }, 100);
                      }, 200);
                    }
                    client.write(JSON.stringify({ ok: true }) + "\n");
                    if (wrapper.logger) {
                      const logEntry = {
                        ts: Date.now(),
                        dir: "in",
                        data: { text: req.command, encoding: "utf8", size: req.command.length },
                        source: "inject",
                      };
                      wrapper.logger.write(JSON.stringify(logEntry) + "\n");
                    }
                  } else if (req.type === PTY_SOCKET_MESSAGE_TYPES.RAW && req.data) {
                    // Raw PTY write (no Enter appended) - for TTY view passthrough
                    wrapper.write(req.data);
                    client.write(JSON.stringify({ ok: true }) + "\n");
                  } else if (req.type === PTY_SOCKET_MESSAGE_TYPES.RESIZE && req.cols && req.rows) {
                    // Resize PTY - for TTY view viewport adjustment
                    if (wrapper.pty && !wrapper.pty._closed) {
                      wrapper.pty.resize(req.cols, req.rows);
                    }
                    client.write(JSON.stringify({ ok: true }) + "\n");
                  } else if (req.type === PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE) {
                    // Subscribe to PTY output stream for TTY view
                    outputSubscribers.add(client);
                    client.write(JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBED, ok: true }) + "\n");
                    // Replay from in-memory ring buffer
                    if (outputRingBuffer.length > 0) {
                      client.write(JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.REPLAY, data: outputRingBuffer, encoding: "utf8" }) + "\n");
                    }
                  } else {
                    client.write(JSON.stringify({ ok: false, error: "invalid request" }) + "\n");
                  }
                } catch (err) {
                  client.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
                }
              }
            });
            client.on("error", () => {
              outputSubscribers.delete(client);
            });
            client.on("close", () => {
              outputSubscribers.delete(client);
            });
          });

          injectServer.listen(injectSockPath, () => {
            if (process.env.UFOO_DEBUG) {
              console.error(`[inject] listening on ${injectSockPath}`);
            }
          });

          injectServer.on("error", (err) => {
            if (process.env.UFOO_DEBUG) {
              console.error(`[inject] server error: ${err.message}`);
            }
          });

          // 记录inject socket路径到cleanup
          const cleanupInjectServer = () => {
            // Close all output subscribers
            for (const sub of outputSubscribers) {
              try { sub.destroy(); } catch { /* ignore */ }
            }
            outputSubscribers.clear();
            try {
              injectServer.close();
              if (fs.existsSync(injectSockPath)) {
                fs.unlinkSync(injectSockPath);
              }
            } catch {
              // ignore
            }
          };

          // 更新onExit以清理inject server
          const originalOnExit = wrapper.onExit;
          wrapper.onExit = async (exitInfo) => {
            cleanupInjectServer();
            if (originalOnExit) {
              await originalOnExit(exitInfo);
            }
          };

          // Handle external SIGTERM/SIGINT (e.g. daemon closeAgent)
          // Without this, the PTY child may survive as an orphan process
          // and the terminal window stays open.
          let termSignalHandled = false;
          const handleTermSignal = (sig) => {
            if (termSignalHandled) return;
            termSignalHandled = true;
            // Save onExit ref before cleanup() nulls it
            const exitHandler = wrapper.onExit;
            wrapper.cleanup();
            if (exitHandler) {
              exitHandler({ exitCode: null, signal: sig });
            } else {
              process.exit(sig === "SIGTERM" ? 143 : 130);
            }
          };
          process.on("SIGTERM", () => handleTermSignal("SIGTERM"));
          process.on("SIGINT", () => handleTermSignal("SIGINT"));
        } catch (err) {
          console.error(`[PTY] Failed to start, falling back to spawn:`, err.message);
          this._spawnDirect(args, subscriberId);
        }
      } else {
        // 非PTY环境：tmux、internal、管道、显式禁用等
        this._spawnDirect(args, subscriberId);
      }
    } catch (err) {
      console.error(`[${this.command}] Error:`, err.message);
      process.exit(1);
    }
  }
}

module.exports = AgentLauncher;
