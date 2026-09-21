"use strict";

const { createHash } = require("crypto");
const { stableStringify } = require("./context/stableJson");

const TIGHT_TOOLS = new Set(["read", "read_image", "artifact_read", "plan_graph"]);

// One observation is a model step, including its complete parallel tool batch.
// Ignore call IDs, JSON key order, and parallel ordering when comparing steps.
class ToolLoopGuard {
  constructor() {
    this.reset();
  }

  reset() {
    this.signature = "";
    this.count = 0;
    this.warned = false;
    this.names = [];
    this.tight = false;
  }

  observe(calls) {
    if (!calls.length) return this.reset();
    const parts = calls.map((call) => stableStringify({ name: call.name, args: call.args }));
    const signature = createHash("sha256").update(JSON.stringify(parts.sort())).digest("hex");
    if (signature !== this.signature) this.reset();
    this.signature = signature;
    this.count += 1;
    this.names = [...new Set(calls.map((call) => call.name))].sort();
    this.tight = calls.every((call) => TIGHT_TOOLS.has(call.name));
  }

  nextAction() {
    const warnAt = this.tight ? 4 : 8;
    const stopAt = this.tight ? 8 : 12;
    const tools = this.names.join(", ");
    if (this.count >= stopAt) {
      return {
        kind: "stop",
        message: `Stopped repeated tool calls: ${tools} used identical arguments for ${this.count} consecutive model steps after a warning. Change the approach or provide new information to continue.`,
      };
    }
    if (this.count >= warnAt && !this.warned) {
      this.warned = true;
      return {
        kind: "warn",
        message: `You have repeated the same tool batch (${tools}) with identical arguments for ${this.count} consecutive model steps. Stop repeating it and use a different approach. If waiting for a task, use its supported waiting mechanism instead of repeatedly checking. If blocked, explain the blocker to the user. This run will stop at ${stopAt} consecutive identical steps.`,
      };
    }
    return null;
  }
}

module.exports = { ToolLoopGuard };
