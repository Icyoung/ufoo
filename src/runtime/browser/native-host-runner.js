#!/usr/bin/env node
"use strict";

/**
 * Standalone zero-dependency Chrome Native Messaging Host for ufoo Browser.
 * Copied into ~/.ufoo/browser/native-host/native-host-runner.js so Chrome can
 * launch it from an immutable user path without depending on npm package versions
 * or shell PATH.
 */

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const MAX_NATIVE_BYTES = 1024 * 1024;

function browserHomeDir() {
  const override = String(process.env.UFOO_BROWSER_HOME || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".ufoo", "browser");
}

function globalConfigPath() {
  const override = String(process.env.UFOO_GLOBAL_CONFIG_PATH || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".ufoo", "config.json");
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeNativeMessage(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  if (json.length > MAX_NATIVE_BYTES) return;
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function createNativeReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len === 0 || len > MAX_NATIVE_BYTES) {
        buf = Buffer.alloc(0);
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.slice(4, 4 + len).toString("utf8");
      buf = buf.slice(4 + len);
      try {
        onMessage(JSON.parse(body));
      } catch {
        // Ignore malformed frame
      }
    }
  };
}

function checkLocalInstallState() {
  const home = browserHomeDir();
  const installFile = path.join(home, "install.json");
  if (!fs.existsSync(installFile)) {
    return { installed: false, enabled: false, reason: "native_not_installed" };
  }
  const config = readJsonSafe(globalConfigPath());
  const browserCfg = config && typeof config.browser === "object" ? config.browser : {};
  if (browserCfg.enabled === false) {
    return { installed: true, enabled: false, reason: "disabled" };
  }
  return { installed: true, enabled: true, reason: "ok" };
}

function requestBroker(sockPath, payload) {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    let buffer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "waiting_for_ufoo", error: "ufoo broker timed out" }), 4000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ ok: false, code: "broker_bad_response", error: "Invalid broker response" });
      }
    });
    socket.on("error", (err) => {
      finish({ ok: false, code: "waiting_for_ufoo", error: err && err.message ? err.message : "Broker unavailable" });
    });
  });
}

function resolveBrokerSocketPath() {
  const priv = path.join(browserHomeDir(), "private");
  const candidate = path.join(priv, "broker.sock");
  if (Buffer.byteLength(candidate) <= 96) return candidate;
  const tag = crypto.createHash("sha256").update(priv).digest("hex").slice(0, 16);
  return path.join("/tmp", `ufoo-bb-${tag}.sock`);
}

async function handleIncomingNativeMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const local = checkLocalInstallState();
  if (!local.installed) {
    writeNativeMessage({ type: "status", state: "native_not_installed", id: msg.id || null });
    return;
  }
  if (!local.enabled) {
    writeNativeMessage({ type: "status", state: "disabled", id: msg.id || null });
    return;
  }

  const sockPath = resolveBrokerSocketPath();
  if (!fs.existsSync(sockPath)) {
    writeNativeMessage({ type: "status", state: "waiting_for_ufoo", id: msg.id || null });
    return;
  }

  if (msg.type === "hello") {
    const res = await requestBroker(sockPath, {
      op: "native_hello",
      params: {
        extensionId: String(msg.extensionId || ""),
        extensionVersion: String(msg.extensionVersion || ""),
        protocolVersion: Number(msg.protocolVersion || 0),
      },
    });
    if (!res || !res.ok) {
      writeNativeMessage({
        type: "status",
        state: res?.code || "waiting_for_ufoo",
        error: res?.error || "",
        id: msg.id || null,
      });
      return;
    }
    writeNativeMessage({
      type: "connect_info",
      id: msg.id || null,
      wsUrl: res.wsUrl,
      token: res.token,
      protocolVersion: res.protocolVersion,
      hostVersion: res.hostVersion || "",
    });
    return;
  }

  if (msg.type === "ping") {
    const res = await requestBroker(sockPath, { op: "ping", params: {} });
    writeNativeMessage({
      type: "pong",
      id: msg.id || null,
      brokerRunning: Boolean(res && res.ok),
    });
  }
}

function main() {
  const push = createNativeReader((msg) => {
    void handleIncomingNativeMessage(msg);
  });
  process.stdin.on("data", push);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
}

if (require.main === module) {
  main();
}

module.exports = {
  checkLocalInstallState,
  handleIncomingNativeMessage,
  createNativeReader,
};
