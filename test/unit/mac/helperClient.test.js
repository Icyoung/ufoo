"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { macHelperSocketPath, macDaemonInfoPath } = require("../../../src/runtime/mac/paths");
const { ensureHelperDaemon, sendRawSocketRpc } = require("../../../src/runtime/mac/helperClient");

describe("Mac helper busy detection", () => {
  let root, env, socketPath, server;
  let sockets, pending;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mac-busy-"));
    env = { ...process.env, UFOO_MAC_HOME: root };
    socketPath = macHelperSocketPath(env);
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    sockets = new Set();
    pending = [];
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await Promise.all(pending);
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function listen(handler) {
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (!data.includes("\n")) return;
        const request = JSON.parse(data.trim());
        data = "";
        pending.push(Promise.resolve(handler(request)).then(() => {
          socket.end(JSON.stringify({ ok: true, result: { pid: process.pid } }) + "\n");
        }));
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  }

  test("does not replace the socket while a long RPC blocks ping, and reuses it afterwards", async () => {
    let queue = Promise.resolve();
    let started;
    const busyStarted = new Promise((resolve) => { started = resolve; });
    await listen((request) => {
      queue = queue.then(async () => {
        if (request.method === "busy") {
          started();
          await new Promise((resolve) => setTimeout(resolve, 1400));
        }
      });
      return queue;
    });
    const options = { env, ensureCompiledImpl: async () => ({ binaryPath: process.execPath, hash: "fixture" }) };
    const inode = fs.statSync(socketPath).ino;
    const busy = sendRawSocketRpc(socketPath, "busy", {}, { timeoutMs: 4000 });
    await busyStarted;
    await expect(ensureHelperDaemon(options)).rejects.toMatchObject({ code: "mac_helper_busy" });
    expect(fs.statSync(socketPath).ino).toBe(inode);
    await busy;
    await expect(ensureHelperDaemon(options)).resolves.toMatchObject({ spawned: false, status: { pid: process.pid } });
  });

  test("also preserves a helper that becomes busy during the locked upgrade check", async () => {
    let count = 0;
    await listen(async () => {
      if (++count > 1) await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    fs.writeFileSync(macDaemonInfoPath(env), JSON.stringify({ pid: process.pid, hash: "old" }));
    const inode = fs.statSync(socketPath).ino;
    await expect(ensureHelperDaemon({
      env,
      ensureCompiledImpl: async () => ({ binaryPath: process.execPath, hash: "new" }),
    })).rejects.toMatchObject({ code: "mac_helper_busy" });
    expect(fs.statSync(socketPath).ino).toBe(inode);
    expect(JSON.parse(fs.readFileSync(macDaemonInfoPath(env))).hash).toBe("old");
  });
});
