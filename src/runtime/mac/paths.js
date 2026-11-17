"use strict";

const crypto = require("crypto");
const os = require("os");
const path = require("path");

/**
 * Resolve the user-scoped macOS runtime home directory (`~/.ufoo/mac/`).
 * Respects `UFOO_MAC_HOME` for isolated test environments.
 */
function macHomeDir(env = process.env) {
  const override = String(env.UFOO_MAC_HOME || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".ufoo", "mac");
}

function macBinDir(env = process.env) {
  return path.join(macHomeDir(env), "bin");
}

function macPrivateDir(env = process.env) {
  return path.join(macHomeDir(env), "private");
}

function macCompileLockPath(env = process.env) {
  return path.join(macPrivateDir(env), "compile.lock");
}

function macDaemonLockPath(env = process.env) {
  return path.join(macPrivateDir(env), "daemon.lock");
}

function macDaemonInfoPath(env = process.env) {
  return path.join(macPrivateDir(env), "daemon.json");
}

function macInputLockPath(env = process.env) {
  return path.join(macPrivateDir(env), "input.lock");
}

function macHelperSocketPath(env = process.env) {
  const candidate = path.join(macPrivateDir(env), "helper.sock");
  if (Buffer.byteLength(candidate) <= 96) return candidate;
  const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
  const tag = crypto.createHash("sha256").update(macPrivateDir(env)).digest("hex").slice(0, 12);
  return path.join("/tmp", `ufoo-mc-${uid}-${tag}`, "h.sock");
}

function swiftHelperSourcePath() {
  return path.join(__dirname, "native", "ufoo_mac_helper.swift");
}

module.exports = {
  macHomeDir,
  macBinDir,
  macPrivateDir,
  macCompileLockPath,
  macDaemonLockPath,
  macDaemonInfoPath,
  macInputLockPath,
  macHelperSocketPath,
  swiftHelperSourcePath,
};
