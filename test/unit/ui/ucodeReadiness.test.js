"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");

jest.mock("child_process", () => ({ ...jest.requireActual("child_process"), spawn: jest.fn() }));
jest.mock("../../../src/ui/tuiLauncher", () => ({
  resolveTuiLaunchPlan: () => ({ mode: "rust", binary: "/fake/ufoo-tui", protocol: "ufoo-ui/1" }),
}));
jest.mock("../../../src/code/modelCommand", () => ({
  ...jest.requireActual("../../../src/code/modelCommand"),
  listUcodeModels: jest.fn(async () => ({ ok: true, models: [] })),
}));

const { spawn } = require("child_process");
const { BusStore } = require("../../../src/coordination/bus/store");
const { runUcodeCoreAgent } = require("../../../src/code/repl");
const { isLauncherReady, setLauncherReady } = require("../../../src/agents/launch/launcherReadiness");
const { createEnvelope, encodeMessage } = require("../../../src/runtime/contracts/uiProtocol");

async function handshake(socketPath, authToken) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const received = new Promise((resolve, reject) => {
    let buffer = "";
    socket.on("error", reject);
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (message.name === "app.snapshot" || message.kind === "error") resolve(message);
      }
    });
  });
  socket.write(encodeMessage(createEnvelope({ kind: "hello", payload: { auth_token: authToken } })));
  try {
    return await received;
  } finally {
    socket.destroy();
  }
}

test("native ucode becomes ready only after its Rust UI client authenticates, including reconnects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ucode-ui-ready-"));
  new BusStore(root).init();
  const subscriber = "ucode:ui-ready";
  const queue = path.join(root, ".ufoo", "bus", "queues", subscriber.replace(/:/g, "_"));
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, "pending.jsonl"), "");
  const file = path.join(root, ".ufoo", "agent", "all-agents.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ agents: { [subscriber]: { status: "active", launcher_ready: false } } }));
  const env = { ...process.env };
  process.env.UFOO_SUBSCRIBER_ID = subscriber;
  delete process.env.UFOO_UCODE_NO_TUI;
  const child = new EventEmitter();
  let launched;
  const spawned = new Promise(resolve => { launched = resolve; });
  spawn.mockImplementation((binary, args, options) => {
    launched({ socketPath: args[args.indexOf("--ui-socket") + 1], token: options.env.UFOO_UI_TOKEN });
    return child;
  });
  const running = runUcodeCoreAgent({ workspaceRoot: root, forceTui: true });
  try {
    const { socketPath, token } = await Promise.race([spawned, running.then(() => {
      throw new Error("Native host exited before starting its UI client");
    })]);
    expect(isLauncherReady(root, subscriber)).toBe(false);
    expect((await handshake(socketPath, "invalid-token")).kind).toBe("error");
    expect(isLauncherReady(root, subscriber)).toBe(false);
    expect((await handshake(socketPath, token)).name).toBe("app.snapshot");
    expect(isLauncherReady(root, subscriber)).toBe(true);
    // Readiness notification is once per host lifetime, not every resync/reconnect.
    setLauncherReady(root, subscriber, false);
    expect((await handshake(socketPath, token)).name).toBe("app.snapshot");
    expect(isLauncherReady(root, subscriber)).toBe(false);
  } finally {
    child.emit("close", 0, null);
    await running;
    process.env = env;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
