/**
 * Agent Ready检测器
 * 通过分析PTY输出判断agent是否初始化完成并ready接收命令
 */
class ReadyDetector {
  constructor(agentType) {
    this.agentType = agentType;
    this.ready = false;
    this.buffer = ""; // 缓存最近的输出（用于多行匹配）
    this.maxBufferSize = 2000; // 限制buffer大小
    this.callbacks = [];
    this.createdAt = Date.now(); // 用于性能指标
    this.readyAt = null; // 记录ready的时间
  }

  /**
   * 注册ready回调
   */
  onReady(callback) {
    if (this.ready) {
      // 已经ready，立即执行
      callback();
    } else {
      this.callbacks.push(callback);
    }
  }

  /**
   * 触发ready状态
   */
  _triggerReady() {
    if (this.ready) return;
    this.ready = true;
    this.readyAt = Date.now();

    // 计算检测耗时
    const detectionTime = this.readyAt - this.createdAt;

    if (process.env.UFOO_DEBUG) {
      console.error(`[ReadyDetector] ${this.agentType} ready detected in ${detectionTime}ms`);
    }

    this.callbacks.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        // 忽略回调错误，但在debug模式下记录
        if (process.env.UFOO_DEBUG) {
          console.error(`[ReadyDetector] callback error:`, err);
        }
      }
    });
    this.callbacks = [];
  }

  /**
   * 检测claude-code的ready标记
   * 特征：prompt "❯" 或分隔线 "────────"
   */
  _detectClaudeCodeReady(text) {
    // 1. 检测prompt标记（更可靠）
    if (text.includes("❯")) {
      return true;
    }

    // 2. 检测分隔线（banner完成后的标记）
    if (text.includes("────────") && text.includes("Try")) {
      return true;
    }

    return false;
  }

  /**
   * 检测codex的ready标记
   */
  _detectCodexReady(text) {
    // Codex的prompt检测（更严格，避免误报）
    // 1. 明确的 "codex>" prompt
    if (text.includes("codex>")) {
      return true;
    }
    // 2. 行首或行尾的单独 ">" prompt（避免匹配JSON/HTML中的>）
    if (/(?:^|\n)>\s*$/.test(text)) {
      return true;
    }
    return false;
  }

  /**
   * Detect agy (Antigravity CLI) ready markers.
   *
   * agy renders an ink-style TUI with:
   *   - A status footer "? for shortcuts" that appears once the prompt box
   *     is mounted (most reliable signal — only present post-boot).
   *   - A bordered input row with a lone blue ">" prefix. We can't grep
   *     for just ">" without misfiring (codex/ucode use the same), so we
   *     anchor on the statusline phrase instead.
   *
   * If the account is blocked ("Eligibility check failed"), the TUI still
   * mounts and "? for shortcuts" still appears — we let ready fire so the
   * user sees the error. activityDetector handles the BLOCKED state.
   */
  _detectAgyReady(text) {
    if (text.includes("? for shortcuts")) {
      return true;
    }
    return false;
  }

  /**
   * 检测ufoo-code/ucode的ready标记
   */
  _detectUfooCodeReady(text) {
    if (/(?:^|\n)(?:ufoo|ucode|pi-mono)>\s*$/m.test(text)) {
      return true;
    }
    // 与 codex 路径保持一致的兜底：行首/行尾的单独 ">"
    if (/(?:^|\n)>\s*$/.test(text)) {
      return true;
    }
    return false;
  }

  /**
   * 处理PTY输出数据
   * @param {Buffer|string} data - PTY输出数据
   */
  processOutput(data) {
    if (this.ready) return; // 已经ready，跳过后续检测

    // 跳过null/undefined
    if (data == null) return;

    // 转换为字符串
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);

    if (!text) return; // 跳过空输入

    // 追加到buffer
    this.buffer += text;

    // 限制buffer大小（防止内存泄漏）
    if (this.buffer.length > this.maxBufferSize) {
      const keepSize = Math.floor(this.maxBufferSize * 0.5); // 保留50%
      this.buffer = this.buffer.slice(-keepSize);

      if (process.env.UFOO_DEBUG) {
        console.error(`[ReadyDetector] buffer trimmed, keeping last ${keepSize} bytes`);
      }
    }

    // 根据agentType检测ready标记
    let isReady = false;
    if (this.agentType === "claude-code") {
      isReady = this._detectClaudeCodeReady(this.buffer);
    } else if (this.agentType === "codex") {
      isReady = this._detectCodexReady(this.buffer);
    } else if (this.agentType === "agy") {
      isReady = this._detectAgyReady(this.buffer);
    } else if (this.agentType === "ufoo" || this.agentType === "ucode" || this.agentType === "ufoo-code") {
      isReady = this._detectUfooCodeReady(this.buffer);
    }

    if (isReady) {
      if (process.env.UFOO_DEBUG) {
        console.error(`[ReadyDetector] prompt detected in buffer (${this.buffer.length} bytes)`);
      }
      this._triggerReady();
    }
  }

  /**
   * 强制标记为ready（用于fallback超时）
   */
  forceReady() {
    if (process.env.UFOO_DEBUG && !this.ready) {
      console.error(`[ReadyDetector] force ready triggered after ${Date.now() - this.createdAt}ms`);
    }
    this._triggerReady();
  }

  /**
   * 获取性能指标
   */
  getMetrics() {
    return {
      agentType: this.agentType,
      ready: this.ready,
      createdAt: this.createdAt,
      readyAt: this.readyAt,
      detectionTimeMs: this.readyAt ? this.readyAt - this.createdAt : null,
      bufferSize: this.buffer.length,
    };
  }
}

module.exports = ReadyDetector;
