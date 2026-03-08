/**
 * Agent Activity State Detector
 * 持续监控 agent 启动后的活动状态（readyDetector 的补充）
 *
 * State machine:
 *   STARTING → READY → WORKING ↔ IDLE
 *                         ↓        ↑
 *                   WAITING_INPUT --+
 *                         ↓        ↑
 *                      BLOCKED ----+
 */

const ACTIVITY_STATES = {
  starting: "starting",
  ready: "ready",
  working: "working",
  idle: "idle",
  waiting_input: "waiting_input",
  blocked: "blocked",
};

const DEFAULT_BUFFER_SIZE = 4000;
const DEFAULT_TAIL_LINES = 10;
const DEFAULT_BLOCKED_TIMEOUT_MS = 300000;
const DEFAULT_INTERNAL_QUIET_MS = 3500;
const DEFAULT_EXTERNAL_QUIET_MS = 5000;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Agent-specific patterns that indicate the agent is waiting for user input.
// Patterns are anchored to prompt/question contexts to reduce false positives.
const INPUT_PATTERNS = {
  "claude-code": [
    /\bAllow\b.*\bDeny\b/,            // Claude Code permission dialog: "Allow | Deny"
    /\ballow mcp\b/i,                 // MCP tool approval prompt
    /Enter to select.*\u2191\/\u2193 to navigate/, // Ink TUI interactive prompt navigation bar (permissions, AskUserQuestion, Plan approval)
  ],
  codex: [
    /\[Y\/n\]/,                        // Bracket-style prompt
    /\by\/n\b/i,                       // y/n prompt (common in confirmation dialogs)
  ],
};

const COMMON_PATTERNS = [
  /Continue\?\s*$/m,                   // Line-ending "Continue?"
  /Proceed\?\s*$/m,                    // Line-ending "Proceed?"
  /Press enter/i,                      // "Press enter to continue"
  /\(y\/n\)\s*:?\s*$/m,               // "(y/n)" at line end
];

// Deny-list for per-line context around a matched prompt.
// Prevents false positives from code output while avoiding global-buffer suppression.
const LINE_DENY_CONTEXT_PATTERNS = [
  /function\s+\w+/,                   // Function definition context
  /\/\//,                             // Code comment
  /import\s+/,                        // Import statement
  /require\s*\(/,                     // Require statement
];

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getDefaultQuietWindowMs(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (normalized.includes("internal")) return DEFAULT_INTERNAL_QUIET_MS;
  return DEFAULT_EXTERNAL_QUIET_MS;
}

class ActivityDetector {
  /**
   * @param {string} agentType - e.g. "claude-code", "codex"
   * @param {object} [options]
   * @param {string} [options.mode] - launch mode ("internal-pty"/"terminal"/"tmux"/"iterm2")
   * @param {number} [options.bufferSize=4000] - rolling buffer size in chars
   * @param {number} [options.tailLines=10] - number of tail lines used for quiet-time prompt detection
   * @param {boolean} [options.startOnOutput=false] - allow STARTING -> WORKING on first output
   * @param {number} [options.quietWindowMs] - output quiet window before WAITING_INPUT/IDLE classification
   * @param {number} [options.blockedTimeoutMs=300000] - 5 min WAITING_INPUT → BLOCKED
   */
  constructor(agentType, options = {}) {
    this.agentType = agentType;
    this.mode = String(options.mode || "").trim().toLowerCase();
    this.bufferSize = toPositiveInt(options.bufferSize, DEFAULT_BUFFER_SIZE);
    this.tailLines = toPositiveInt(options.tailLines, DEFAULT_TAIL_LINES);
    this.startOnOutput = options.startOnOutput === true;
    this.blockedTimeoutMs = toPositiveInt(options.blockedTimeoutMs, DEFAULT_BLOCKED_TIMEOUT_MS);
    const optionQuietMs = toPositiveInt(options.quietWindowMs, 0);
    const envQuietMs = toPositiveInt(process.env.UFOO_ACTIVITY_QUIET_MS, 0);
    this.quietWindowMs = optionQuietMs || envQuietMs || getDefaultQuietWindowMs(this.mode);

    this.state = ACTIVITY_STATES.starting;
    this.since = Date.now();
    this.detail = "";
    this.buffer = "";
    this.callbacks = [];
    this.blockedTimer = null;
    this.quietTimer = null;
    this.quietToken = 0;
  }

  /**
   * Register a state-change callback: fn(newState, oldState, detail)
   */
  onChange(callback) {
    this.callbacks.push(callback);
  }

  /**
   * Transition to a new state (internal)
   */
  _setState(newState, detail = "") {
    if (newState === this.state) return;
    const oldState = this.state;
    this.state = newState;
    this.since = Date.now();
    this.detail = detail;
    for (const cb of this.callbacks) {
      try {
        cb(newState, oldState, detail);
      } catch {
        // ignore callback errors
      }
    }
  }

  /**
   * STARTING → READY
   */
  markReady() {
    if (this.state !== ACTIVITY_STATES.starting) return;
    this._setState(ACTIVITY_STATES.ready);
  }

  /**
   * any → WORKING
   * - clears WAITING/BLOCKED timers
   * - cancels pending quiet classification
   * - resets buffer by default when coming from non-WORKING states
   */
  markWorking(options = {}) {
    const hasResetFlag = Object.prototype.hasOwnProperty.call(options, "resetBuffer");
    const resetBuffer = hasResetFlag ? Boolean(options.resetBuffer) : this.state !== ACTIVITY_STATES.working;
    this._clearBlockedTimer();
    this._clearQuietTimer();
    if (resetBuffer) {
      this.buffer = "";
    }
    this._setState(ACTIVITY_STATES.working);
  }

  /**
   * WORKING/WAITING_INPUT/BLOCKED → IDLE
   * Allows recovery from stuck states when queue drains, marker hits, etc.
   */
  markIdle() {
    if (this.state !== ACTIVITY_STATES.working
      && this.state !== ACTIVITY_STATES.waiting_input
      && this.state !== ACTIVITY_STATES.blocked) return;
    this._clearBlockedTimer();
    this._clearQuietTimer();
    this.buffer = "";
    this._setState(ACTIVITY_STATES.idle);
  }

  /**
   * Process PTY output.
   * Any output (except STARTING) implies WORKING.
   * WAITING_INPUT/IDLE are only classified after quiet window.
   * @param {string} text - cleaned (ANSI-stripped) output text
   */
  processOutput(text) {
    const normalized = this._normalizeOutput(text);
    if (!normalized) return;
    if (!this._hasMeaningfulOutput(normalized)) return;
    if (this.state === ACTIVITY_STATES.starting) {
      if (!this.startOnOutput) return;
      this._setState(ACTIVITY_STATES.working, "output");
    }

    this.buffer += normalized;
    // Rolling buffer: keep last N chars
    if (this.buffer.length > this.bufferSize) {
      this.buffer = this.buffer.slice(-this.bufferSize);
    }

    if (this.state !== ACTIVITY_STATES.working) {
      this._clearBlockedTimer();
      this._setState(ACTIVITY_STATES.working);
    }
    this._scheduleQuietClassification();
  }

  _normalizeOutput(text) {
    if (!text) return "";
    return String(text)
      .replace(OSC_PATTERN, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(ANSI_PATTERN, "");
  }

  _hasMeaningfulOutput(text) {
    if (!text) return false;
    const visible = String(text).replace(/[\s\u0000-\u001F\u007F]+/g, "");
    return visible.length > 0;
  }

  _scheduleQuietClassification() {
    this.quietToken += 1;
    const quietToken = this.quietToken;
    this._clearQuietTimer();
    this.quietTimer = setTimeout(() => {
      if (quietToken !== this.quietToken) return;
      this.quietTimer = null;
      this._classifyAfterQuietWindow();
    }, this.quietWindowMs);
    if (this.quietTimer && typeof this.quietTimer.unref === "function") {
      this.quietTimer.unref();
    }
  }

  _classifyAfterQuietWindow() {
    if (this.state !== ACTIVITY_STATES.working) return;
    const tailBuffer = this._tailWindow();

    // Check agent-specific patterns only after output has stabilized.
    const agentPatterns = INPUT_PATTERNS[this.agentType] || [];
    const allPatterns = [...agentPatterns, ...COMMON_PATTERNS];
    for (const pattern of allPatterns) {
      const match = pattern.exec(tailBuffer);
      if (!match) continue;
      const matchedText = String(match[0] || "");
      const matchIndex = Number.isFinite(match.index)
        ? match.index
        : Math.max(0, tailBuffer.length - matchedText.length);
      if (this._hasDeniedContext(tailBuffer, matchIndex, matchedText.length)) continue;
      this._setState(ACTIVITY_STATES.waiting_input, pattern.source);
      this._startBlockedTimer();
      return;
    }

    this._setState(ACTIVITY_STATES.idle);
  }

  _tailWindow() {
    if (!this.buffer) return "";
    const lines = this.buffer.split("\n");
    if (lines.length <= this.tailLines) return this.buffer;
    return lines.slice(-this.tailLines).join("\n");
  }

  _lineAt(haystack, index) {
    const safeIndex = Math.max(0, Math.min(index, haystack.length));
    const lineStart = haystack.lastIndexOf("\n", safeIndex - 1) + 1;
    const lineEndCandidate = haystack.indexOf("\n", safeIndex);
    const lineEnd = lineEndCandidate >= 0 ? lineEndCandidate : haystack.length;
    return haystack.slice(lineStart, lineEnd);
  }

  _isInsideCodeFence(haystack, index) {
    const before = haystack.slice(0, Math.max(0, index));
    const fences = before.match(/```/g);
    return (fences ? fences.length : 0) % 2 === 1;
  }

  _hasDeniedContext(haystack, matchIndex, matchLength = 0) {
    if (this._isInsideCodeFence(haystack, matchIndex)) return true;
    const centerIndex = Math.max(0, matchIndex + Math.max(0, Math.trunc(matchLength / 2)));
    const line = this._lineAt(haystack, centerIndex);
    return LINE_DENY_CONTEXT_PATTERNS.some((deny) => deny.test(line));
  }

  /**
   * Start the WAITING_INPUT → BLOCKED timer
   */
  _startBlockedTimer() {
    this._clearBlockedTimer();
    this.blockedTimer = setTimeout(() => {
      this.blockedTimer = null;
      if (this.state === ACTIVITY_STATES.waiting_input) {
        this._setState(ACTIVITY_STATES.blocked, `waiting_input for ${this.blockedTimeoutMs}ms`);
      }
    }, this.blockedTimeoutMs);
    // Allow process to exit even if timer is pending
    if (this.blockedTimer && typeof this.blockedTimer.unref === "function") {
      this.blockedTimer.unref();
    }
  }

  _clearBlockedTimer() {
    if (this.blockedTimer) {
      clearTimeout(this.blockedTimer);
      this.blockedTimer = null;
    }
  }

  _clearQuietTimer() {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  /**
   * Get current state snapshot
   */
  getState() {
    return {
      state: this.state,
      since: this.since,
      detail: this.detail,
    };
  }

  /**
   * Clean up timers
   */
  destroy() {
    this._clearBlockedTimer();
    this._clearQuietTimer();
    this.callbacks = [];
  }
}

module.exports = { ACTIVITY_STATES, ActivityDetector };
