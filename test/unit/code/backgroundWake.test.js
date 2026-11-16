"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { spawn } = require("child_process");
const { createUcodeWakeHost } = require("../../../src/code/runtime/backgroundWakeHost");
const { createCodingCapability } = require("../../../src/agents/capabilities/coding");
const { createBackgroundHookSource } = require("../../../src/agents/capabilities/coding/backgroundHooks");
const { runBashToolAsync } = require("../../../src/code/tools/bash");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let n = 0; n < 100; n++) { if (await check()) return; await sleep(30); } throw new Error("condition did not arrive"); }

describe("background command wake integration", () => {
  let root, hosts, processes;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-background-wake-")); hosts = []; processes = []; });
  afterEach(async () => {
    hosts.forEach(host => host.close());
    for (const backgroundId of processes) await runBashToolAsync({ action: "stop", backgroundId }, { workspaceRoot: root });
    fs.rmSync(root, { recursive: true, force: true });
  });
  function make(state = { workspaceRoot: root, sessionId: "session-one" }, options = {}) {
    const deliver = jest.fn(async (_event, claim) => claim());
    const host = createUcodeWakeHost({ state, deliver, ...options }); hosts.push(host);
    return { host, state, deliver };
  }
  async function start(state, args) {
    const tool = createCodingCapability().tools.find(tool => tool.name === "bash");
    const result = await tool.handler({ background: true, startupWaitMs: 0, ...args }, {
      workspaceRoot: root, sessionId: state.sessionId, taskRunId: "original", runtimeHooks: state.runtimeHooks,
    });
    if (result.backgroundId) processes.push(result.backgroundId);
    return result;
  }
  test("ucode retains exit notification across turns, busy time and host reopen", async () => {
    const first = make(undefined, { canDeliver: () => false });
    const result = await start(first.state, { command: "sleep 0.1; exit 7" });
    expect(result.wake.registered).toBe(true);
    await until(async () => { await first.host.tick(); return Object.values(first.state.runtimeHooks.snapshot().events).length; });
    expect(first.deliver).not.toHaveBeenCalled(); first.host.close();
    const second = make(); await second.host.tick(); await second.host.tick();
    expect(second.deliver).toHaveBeenCalledTimes(1);
    expect(second.deliver.mock.calls[0][0]).toMatchObject({ type: "background.exited", ownerTaskRunId: "original", data: { exitCode: 7, outcomeKnown: true } });
    expect(Object.keys(second.state)).not.toContain("runtimeHooks");
  });
  test("literal logs, workspace files and local ports each notify once", async () => {
    const { host, state, deliver } = make();
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    try {
      const result = await start(state, { command: "printf '准备READY'; touch ready.txt; sleep 3", wake: { onExit: false,
        conditions: [{ type: "log_contains", text: "准备READY" }, { type: "file_exists", path: "ready.txt" }, { type: "port_open", port: server.address().port }] } });
      await until(async () => { await host.tick(); return deliver.mock.calls.length === 3; });
      await host.tick(); expect(deliver).toHaveBeenCalledTimes(3);
      expect(deliver.mock.calls.every(([event]) => event.type === "background.condition_matched" && event.data.backgroundId === result.backgroundId)).toBe(true);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
  test("invalid condition fails before executing command; stop revokes pending wake", async () => {
    const { host, state, deliver } = make(undefined, { canDeliver: () => false });
    const invalid = await start(state, { command: "touch forbidden", wake: { conditions: [{ type: "file_exists", path: "../escape" }] } });
    expect(invalid.ok).toBe(false); expect(fs.existsSync(path.join(root, "forbidden"))).toBe(false);
    const running = await start(state, { command: "printf ready; sleep 3", wake: { conditions: [{ type: "log_contains", text: "ready" }] } });
    await until(async () => { await host.tick(); return Object.values(state.runtimeHooks.snapshot().events).length; });
    const tool = createCodingCapability().tools.find(tool => tool.name === "bash");
    await tool.handler({ action: "stop", backgroundId: running.backgroundId }, { workspaceRoot: root, runtimeHooks: state.runtimeHooks });
    expect(Object.values(state.runtimeHooks.snapshot().events)[0].status).toBe("cancelled");
    expect(deliver).not.toHaveBeenCalled();
  });
  test("log scanner handles bounded chunks, split UTF8 and matches after process exit", async () => {
    const base = path.join(root, ".ufoo", "agent", "bg", "bg_log"); fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.writeFileSync(`${base}.json`, JSON.stringify({ status: "exited", exitCode: 0 }));
    fs.writeFileSync(`${base}.log`, Buffer.concat([Buffer.alloc(65535, 120), Buffer.from("准备完成")]));
    const sub = { spec: { backgroundId: "bg_log", onExit: true, conditions: [{ type: "log_contains", text: "准备完成" }] }, cursor: {} };
    const source = createBackgroundHookSource(root);
    const first = await source.check(sub); expect(first.done).toBe(false); expect(first.events).toEqual([]);
    const second = await source.check({ ...sub, cursor: first.cursor });
    expect(second.events.map(event => event.type)).toEqual(["background.condition_matched", "background.exited"]);
  });
  test("the detached supervisor persists exit after the spawning host exits", async () => {
    const modulePath = require.resolve("../../../src/code/tools/bash");
    const script = `require(${JSON.stringify(modulePath)}).runBashToolAsync({command:'sleep 0.2; exit 9',background:true,startupWaitMs:0},{workspaceRoot:process.argv[1]}).then(r=>{console.log(r.backgroundId);process.exit(0)})`;
    const child = spawn(process.execPath, ["-e", script, root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", chunk => { output += chunk; });
    await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    const id = output.trim(); expect(id).toMatch(/^bg_/); processes.push(id);
    const recordPath = path.join(root, ".ufoo", "agent", "bg", `${id}.json`);
    await until(() => JSON.parse(fs.readFileSync(recordPath)).status === "exited");
    expect(JSON.parse(fs.readFileSync(recordPath)).exitCode).toBe(9);
  });
  test("session switches never deliver a previous session's notification", async () => {
    const { host, state, deliver } = make(undefined, { canDeliver: () => false });
    await start(state, { command: "exit 0" });
    await until(async () => { await host.tick(); return Object.values(state.runtimeHooks.snapshot().events).length; });
    state.sessionId = "session-two"; await host.tick();
    expect(Object.values(state.runtimeHooks.snapshot().events)).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  });
});
