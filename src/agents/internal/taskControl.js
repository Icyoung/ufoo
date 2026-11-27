"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash } = require("crypto");
const { getUfooPaths } = require("../../coordination/state/paths");
const { loadAgentsData } = require("../../coordination/state/agentsStore");
const { isInternalAgentMeta } = require("../../runtime/contracts/agentMode");
const { isMetaActive } = require("../../coordination/bus/utils");

function socketPath(root, subscriber) {
  const key = createHash("sha256").update(`${path.resolve(root)}\0${subscriber}`).digest("hex").slice(0, 24);
  return path.join(os.tmpdir(), `ufctl-${key}.sock`);
}

// The control channel stays responsive while the inbox is executing a turn.
// Each turn gets a fresh signal: cancellation never poisons the next message.
function createTaskControl(parentSignal) {
  let active = null;
  return {
    cancel() {
      if (!active) return { ok: true, cancelled: false };
      active.abort("user_cancelled");
      return { ok: true, cancelled: true };
    },
    async run(fn) {
      if (active) throw new Error("An internal turn is already running");
      const controller = new AbortController();
      const abort = () => controller.abort(parentSignal?.reason || "runner_stopped");
      active = controller;
      if (parentSignal?.aborted) abort();
      else parentSignal?.addEventListener("abort", abort, { once: true });
      try { return await fn(controller.signal); }
      finally { parentSignal?.removeEventListener("abort", abort); active = null; }
    },
  };
}

function callControl(file, request, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    let buffer = "";
    const finish = (error, result) => {
      clearTimeout(timer); socket.removeAllListeners(); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Internal agent control timed out")), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("error", error => finish(error));
    socket.on("end", () => finish(new Error("Internal agent control closed without a reply")));
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 4096) return finish(new Error("Invalid control reply"));
      if (!buffer.includes("\n")) return;
      try { finish(null, JSON.parse(buffer.split("\n")[0])); }
      catch (error) { finish(error); }
    });
  });
}

async function startTaskControlServer(root, subscriber, control) {
  const file = socketPath(root, subscriber);
  if (fs.existsSync(file)) {
    try { await callControl(file, { action: "status" }); throw new Error("Internal agent control is already running"); }
    catch (error) {
      if (!["ECONNREFUSED", "ENOENT"].includes(error.code)) throw error;
      fs.rmSync(file, { force: true });
    }
  }
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10000, () => socket.destroy());
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 4096) return socket.destroy();
      if (!buffer.includes("\n")) return;
      socket.removeAllListeners("data");
      try {
        const request = JSON.parse(buffer.split("\n")[0]);
        Promise.resolve().then(async () => {
          if (request.action === "cancel") return control.cancel();
          if (request.action === "status") return { ok: true };
          if (request.action === "configure" && typeof control.configure === "function") {
            return await control.configure(request.patch || {});
          }
          if (request.action === "clear" && typeof control.clear === "function") {
            return await control.clear();
          }
          return { ok: false, error: "Unsupported control action" };
        }).then((result) => {
          socket.end(`${JSON.stringify(result)}\n`);
        }).catch((err) => {
          socket.end(`${JSON.stringify({ ok: false, error: err && err.message ? err.message : "Control action failed" })}\n`);
        });
      } catch { socket.end(`${JSON.stringify({ ok: false, error: "Invalid control request" })}\n`); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(file, resolve); });
  fs.chmodSync(file, 0o600);
  server.unref();
  return { close: () => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => { fs.rmSync(file, { force: true }); resolve(); });
  }) };
}

async function cancelInternalTask(root, subscriber) {
  const meta = loadAgentsData(getUfooPaths(root).agentsFile).agents?.[subscriber];
  if (!isInternalAgentMeta(meta) || !isMetaActive(meta)) return { ok: false, error: "Unknown active internal agent" };
  try { return await callControl(socketPath(root, subscriber), { action: "cancel" }); }
  catch (error) { return { ok: false, error: `Cannot cancel this agent's task; restart its worker to enable controls (${error.code || error.message})` }; }
}

async function configureInternalAgent(root, subscriber, patch = {}) {
  const meta = loadAgentsData(getUfooPaths(root).agentsFile).agents?.[subscriber];
  if (!isInternalAgentMeta(meta) || !isMetaActive(meta)) return { ok: false, error: "Unknown active internal agent" };
  try { return await callControl(socketPath(root, subscriber), { action: "configure", patch }, { timeoutMs: 10000 }); }
  catch (error) { return { ok: false, error: `Cannot configure live agent (${error.code || error.message})` }; }
}

async function clearInternalAgent(root, subscriber) {
  const meta = loadAgentsData(getUfooPaths(root).agentsFile).agents?.[subscriber];
  if (!isInternalAgentMeta(meta) || !isMetaActive(meta)) return { ok: false, error: "Unknown active internal agent" };
  try { return await callControl(socketPath(root, subscriber), { action: "clear" }, { timeoutMs: 10000 }); }
  catch (error) { return { ok: false, error: `Cannot clear live agent (${error.code || error.message})` }; }
}

module.exports = { createTaskControl, startTaskControlServer, cancelInternalTask, configureInternalAgent, clearInternalAgent };
