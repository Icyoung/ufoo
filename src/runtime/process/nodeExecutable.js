"use strict";

const fs = require("fs");

function resolveNodeExecutable(options = {}) {
  const {
    execPath = process.execPath,
    env = process.env,
    fsModule = fs,
  } = options;
  const override = String((env && env.UFOO_NODE_EXECUTABLE) || "").trim();
  if (override) return override;
  const current = String(execPath || "").trim();
  if (current) {
    try {
      if (fsModule.existsSync(current)) return current;
    } catch {
      // Fall through to PATH lookup.
    }
  }
  return "node";
}

module.exports = {
  resolveNodeExecutable,
};
