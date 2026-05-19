"use strict";

const { exec } = require("child_process");

function parseShellCommand(text) {
  const value = String(text || "").trim();
  if (!value.startsWith("!")) return null;
  const command = value.slice(1).trim();
  if (!command) return null;
  return command;
}

function runShellCommand(command, options = {}) {
  const cmd = String(command || "").trim();
  if (!cmd) return Promise.resolve({ ok: false, code: null, stdout: "", stderr: "empty command" });
  const cwd = options.cwd || process.cwd();
  const timeout = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 120000;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : 1024 * 1024;
  return new Promise((resolve) => {
    exec(cmd, {
      cwd,
      env: process.env,
      timeout,
      maxBuffer,
      shell: process.env.SHELL || "/bin/sh",
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && Number.isFinite(error.code) ? error.code : 0,
        signal: error && error.signal ? error.signal : null,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error && error.message ? error.message : "",
      });
    });
  });
}

module.exports = {
  parseShellCommand,
  runShellCommand,
};
