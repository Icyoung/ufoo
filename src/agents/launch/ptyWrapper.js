const pty = require("node-pty");
const fs = require("fs");
const { isITerm2 } = require("../../runtime/terminal/detect");

/**
 * PTY Wrapper - 包装原始agent命令，提供IO控制和监控
 *
 * 特性：
 * - 透明的PTY包装（保持用户体验一致）
 * - JSONL格式日志记录（utf8优先编码）
 * - 可插拔的IO适配器（未来扩展）
 * - 完善的资源清理（防止泄漏）
 *
 * 参考：
 * - launcher.js - PTY实现参考
 * - codex-44 review反馈 (2026-02-05)
 */
class PtyWrapper {
  constructor(command, args, options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;

    // PTY实例
    this.pty = null;

    // IO流引用（用于cleanup）
    this.stdin = null;
    this.stdout = null;

    // 日志记录
    this.logger = null;
    this._loggerBroken = false;
    this._loggerErrorHandler = null;

    // 监控回调
    this.monitor = null;

    // 退出回调（不直接调用process.exit）
    this.onExit = null;

    // 可插拔的IO适配器（未来扩展）
    this.ioAdapter = options.ioAdapter || null;
    this.titlePrefix = String(options.titlePrefix || "").trim();
    this._titleOscBuffer = "";

    // 事件处理器引用（用于cleanup）
    this._stdinHandler = null;
    this._ptyDataHandler = null;
    this._ptyExitHandler = null;
    this._resizeHandler = null;

    // 清理标志（防止重复清理）
    this._cleaned = false;
  }

  /**
   * 启动PTY进程
   */
  spawn() {
    if (this.pty) {
      throw new Error("PTY already spawned");
    }

    // Preserve iTerm2 env vars so child processes can detect the terminal
    const termEnv = {};
    if (isITerm2()) {
      if (process.env.ITERM_SESSION_ID) termEnv.ITERM_SESSION_ID = process.env.ITERM_SESSION_ID;
      if (process.env.TERM_PROGRAM) termEnv.TERM_PROGRAM = process.env.TERM_PROGRAM;
      if (process.env.TERM_PROGRAM_VERSION) termEnv.TERM_PROGRAM_VERSION = process.env.TERM_PROGRAM_VERSION;
    }

    this.pty = pty.spawn(this.command, this.args, {
      name: "xterm-256color",
      cols: this.stdout?.columns || process.stdout.columns || 80,
      rows: this.stdout?.rows || process.stdout.rows || 24,
      cwd: this.options.cwd || process.cwd(),
      env: { ...process.env, ...termEnv, ...(this.options.env || {}) },
    });

    return this.pty;
  }

  /**
   * 连接输入输出流
   *
   * @param {Stream} stdin - 标准输入流
   * @param {Stream} stdout - 标准输出流
   * @param {Stream} stderr - 标准错误流（PTY会合流，此参数保留用于兼容）
   */
  attachStreams(stdin, stdout, stderr) {
    if (!this.pty) {
      throw new Error("PTY not spawned yet. Call spawn() first.");
    }

    // 保存引用（用于cleanup）
    this.stdin = stdin;
    this.stdout = stdout;

    if (this.ioAdapter) {
      // 使用IO适配器（未来扩展）
      this.ioAdapter.attach(this.pty, stdin, stdout, stderr);
    } else {
      // 当前：直接连接streams
      this._attachDirectStreams(stdin, stdout);
    }
  }

  /**
   * 直接连接streams（当前实现）
   * @private
   */
  _attachDirectStreams(stdin, stdout) {
    // PTY输出 -> stdout
    this._ptyDataHandler = (data) => {
      const output = this._prependTitlePrefix(data);

      // 1. 输出到terminal
      stdout.write(output);

      // 2. 可选：日志记录（JSONL格式）
      if (this.logger) {
        const logEntry = {
          ts: Date.now(),
          dir: "out",
          data: this._serializeData(data),
        };
        this.writeLogEntry(logEntry);
      }

      // 3. 可选：监控回调
      if (this.monitor) {
        try {
          this.monitor.onOutput(data);
        } catch (err) {
          // 监控失败不应影响IO通路
          if (process.env.UFOO_DEBUG) {
            console.error("[PtyWrapper] Monitor error:", err);
          }
        }
      }
    };
    this.pty.onData(this._ptyDataHandler);

    // stdin -> PTY（支持raw mode和控制字符）
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();

    this._stdinHandler = (data) => {
      this.pty.write(data);

      // 可选：日志记录
      if (this.logger) {
        const logEntry = {
          ts: Date.now(),
          dir: "in",
          data: this._serializeData(data),
          source: "terminal",
        };
        this.writeLogEntry(logEntry);
      }
    };
    stdin.on("data", this._stdinHandler);

    // 终端大小变化（codex-44：判断isTTY）
    if (stdout.isTTY) {
      this._resizeHandler = () => {
        if (this.pty && !this.pty._closed) {
          // codex-45：默认值兜底（极端环境可能undefined）
          const cols = stdout.columns || 80;
          const rows = stdout.rows || 24;
          this.pty.resize(cols, rows);
        }
      };
      stdout.on("resize", this._resizeHandler);
    }

    // 进程退出
    this._ptyExitHandler = ({ exitCode, signal }) => {
      this.cleanup();

      // 回调给launcher处理退出（不直接process.exit）
      if (this.onExit) {
        this.onExit({ exitCode, signal });
      }
    };
    this.pty.onExit(this._ptyExitHandler);
  }

  _prependTitlePrefix(data) {
    if (!this.titlePrefix) return data;
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    const combined = this._titleOscBuffer + text;
    this._titleOscBuffer = "";

    const trailingOscStart = combined.lastIndexOf("\x1b]");
    if (trailingOscStart >= 0) {
      const trailing = combined.slice(trailingOscStart);
      if (!/(?:\x07|\x1b\\)/.test(trailing)) {
        this._titleOscBuffer = trailing;
        return this._rewriteTitleOsc(combined.slice(0, trailingOscStart));
      }
    }

    return this._rewriteTitleOsc(combined);
  }

  _rewriteTitleOsc(text) {
    if (!this.titlePrefix || !text) return text;
    const prefix = this.titlePrefix;
    return text.replace(/\x1b\]([012]);([^\x07\x1b]*)(\x07|\x1b\\)/g, (match, code, title, terminator) => {
      if (!title || title.startsWith(`${prefix}: `)) return match;
      return `\x1b]${code};${prefix}: ${title}${terminator}`;
    });
  }

  /**
   * 写入数据到PTY（用于外部inject）
   *
   * @param {string|Buffer} data - 要写入的数据
   * @returns {boolean} 是否成功
   */
  write(data) {
    if (!this.pty || this.pty._closed) {
      return false;
    }
    try {
      this.pty.write(data);
      return true;
    } catch (err) {
      if (process.env.UFOO_DEBUG) {
        console.error(`[PtyWrapper] write error: ${err.message}`);
      }
      return false;
    }
  }

  /**
   * 数据序列化（智能编码）
   *
   * codex-44建议：utf8优先，失败才base64
   *
   * @private
   * @param {Buffer|String} data - 原始数据
   * @returns {Object} 序列化后的数据对象
   */
  _serializeData(data) {
    const buf = Buffer.from(data);

    // 尝试utf8解码
    try {
      const str = buf.toString("utf8");
      // 验证解码结果（检测replacement character \uFFFD）
      if (!str.includes("\uFFFD")) {
        return {
          text: str,
          encoding: "utf8",
          size: buf.length
        };
      }
    } catch (err) {
      // utf8解码失败，使用base64
    }

    // 二进制数据使用base64
    return {
      text: buf.toString("base64"),
      encoding: "base64",
      size: buf.length
    };
  }

  /**
   * 启用日志记录
   *
   * @param {String} logFile - 日志文件路径（JSONL格式）
   */
  enableLogging(logFile) {
    if (this.logger) {
      throw new Error("Logging already enabled");
    }
    this._loggerBroken = false;
    const logger = fs.createWriteStream(logFile, { flags: "a" });
    this._loggerErrorHandler = (err) => {
      this._loggerBroken = true;
      if (process.env.UFOO_DEBUG) {
        console.error(`[PtyWrapper] logger error: ${err.message}`);
      }
    };
    logger.on("error", this._loggerErrorHandler);
    this.logger = logger;
  }

  writeLogEntry(logEntry) {
    if (!this.logger || this._loggerBroken) return;
    try {
      this.logger.write(JSON.stringify(logEntry) + "\n");
    } catch (err) {
      this._loggerBroken = true;
      if (process.env.UFOO_DEBUG) {
        console.error(`[PtyWrapper] logger write failed: ${err.message}`);
      }
    }
  }

  /**
   * 启用监控
   *
   * @param {Function} monitorCallback - 监控回调函数
   */
  enableMonitoring(monitorCallback) {
    this.monitor = {
      onOutput: monitorCallback,
    };
  }

  /**
   * 清理资源（codex-44：完善的清理逻辑，codex-45：幂等性）
   *
   * 注意：
   * - 处理异常路径（try-catch）
   * - 移除所有监听器（防止泄漏）
   * - 检查PTY状态（已退出则跳过kill）
   * - 恢复terminal状态（raw mode）
   * - 幂等性（可以安全重复调用）
   */
  cleanup() {
    // codex-45：防止重复清理
    if (this._cleaned) {
      return;
    }
    this._cleaned = true;

    // 1. 关闭日志流
    if (this.logger) {
      try {
        this.logger.end();
      } catch (err) {
        // 忽略错误
      }
      this.logger = null;
      this._loggerErrorHandler = null;
      this._loggerBroken = false;
    }

    // 2. 清理PTY（codex-44：已退出则跳过，codex-45：移除监听器）
    if (this.pty) {
      // 移除PTY监听器
      try {
        if (this._ptyDataHandler) {
          this.pty.removeListener("data", this._ptyDataHandler);
          this._ptyDataHandler = null;
        }
        if (this._ptyExitHandler) {
          this.pty.removeListener("exit", this._ptyExitHandler);
          this._ptyExitHandler = null;
        }
      } catch (err) {
        // 忽略移除监听器的错误
      }

      // Kill PTY进程（已退出则跳过）
      if (!this.pty._closed) {
        try {
          this.pty.kill();
        } catch (err) {
          // PTY可能已经退出，忽略错误
        }
      }
      this.pty = null;
    }

    // 3. 清理stdin（codex-45：使用保存的handler引用）
    if (this.stdin) {
      // 移除data监听器
      if (this._stdinHandler) {
        this.stdin.removeListener("data", this._stdinHandler);
        this._stdinHandler = null;
      }

      // 恢复terminal状态（codex-44：异常路径也要恢复）
      if (this.stdin.isTTY && typeof this.stdin.setRawMode === "function") {
        try {
          this.stdin.setRawMode(false);
        } catch (err) {
          // 恢复失败不阻塞退出
        }
      }

      this.stdin = null;
    }

    // 4. 清理stdout（codex-44：移除resize监听器）
    if (this.stdout) {
      if (this.stdout.isTTY && this._resizeHandler) {
        this.stdout.removeListener("resize", this._resizeHandler);
        this._resizeHandler = null;
      }
      this.stdout = null;
    }

    // 5. 清理监控回调
    this.monitor = null;
    this.onExit = null;
  }
}

module.exports = PtyWrapper;
