"use strict";

const { DEFAULT_MAX_TOOL_ERRORS } = require("./executionBudget");

// Track recoverable tool failures independently of transport retries and loop signatures.
class ToolErrorGuard {
  constructor({ maxToolErrors = DEFAULT_MAX_TOOL_ERRORS } = {}) {
    this.limit = Number.isSafeInteger(maxToolErrors) && maxToolErrors > 0 ? maxToolErrors : DEFAULT_MAX_TOOL_ERRORS;
    this.consecutive = 0;
    this.recent = [];
    this.warned = false;
  }

  observe(failed) {
    this.consecutive = failed ? this.consecutive + 1 : 0;
    this.recent.push(Boolean(failed));
    if (this.recent.length > 20) this.recent.shift();
    const recentErrors = this.recent.filter(Boolean).length;
    const warningAt = Math.max(1, Math.ceil(this.limit / 2));
    const consecutiveLimit = this.consecutive >= this.limit;
    const windowLimit = this.recent.length === 20 && recentErrors >= 12;
    if (consecutiveLimit || windowLimit) {
      return { kind: "stop", code: "tool_error_budget_exceeded", consecutiveErrors: this.consecutive, recentErrors,
        message: consecutiveLimit
          ? `tool error budget exceeded (${this.limit}): ${this.consecutive} consecutive failures`
          : "tool error budget exceeded: 12 or more failures in the last 20 tool calls" };
    }
    const warning = this.consecutive >= warningAt || (this.recent.length === 20 && recentErrors >= 10);
    if (!warning) this.warned = false;
    if (warning && !this.warned) {
      this.warned = true;
      return { kind: "warn", code: "tool_error_warning", consecutiveErrors: this.consecutive, recentErrors,
        message: `Tool failures are accumulating (${this.consecutive} consecutive; ${recentErrors} in the last ${this.recent.length} calls). Inspect the errors and change your approach. Execution stops at ${this.limit} consecutive failures or 12 failures in a full 20-call window. A successful call only resets the consecutive count.` };
    }
    return null;
  }
}

module.exports = { ToolErrorGuard };
