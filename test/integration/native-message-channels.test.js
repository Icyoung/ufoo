"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { z } = require("zod");
const { prepareNativeMessages, startCodexHost, CodexRpc } = require("../../src/agents/launch/nativeMessages");
const { registerAgentFull } = require("../../src/runtime/daemon/controlPlaneService");
const { getUfooPaths } = require("../../src/coordination/state/paths");
const { loadAgentsData } = require("../../src/coordination/state/agentsStore");
const { DeliveryQueue } = require("../../src/coordination/bus/deliveryQueue");
const { DeliveryScheduler } = require("../../src/runtime/daemon/deliveryScheduler");

const channelSchema = z.object({ method: z.literal("notifications/claude/channel"), params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()).optional() }) });
const until = async (predicate) => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("native message channel integration", () => {
  let root;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-native-"));
    await new (require("../../src/coordination/bus"))(root).init();
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const register = (projectRoot, agentType, sessionId) => registerAgentFull(projectRoot, {
    agentType, sessionId, parentPid: process.pid, launchMode: "terminal", tty: "", skipSessionResolve: true,
  }, { validateParentPid: true, notifyDaemon: false });

  test("two same-project Codex hosts use exact independent threads and native queue requests", async () => {
    const first = await register(root, "codex", "first001");
    const second = await register(root, "codex", "second01");
    const fixtures = [];
    const requests = [];
    const spawnImpl = (command, args) => {
      const socket = args[args.indexOf("--listen") + 1].slice("unix://".length);
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      const threadId = crypto.randomUUID();
      wss.on("connection", (ws) => ws.on("message", (raw) => {
        const request = JSON.parse(raw);
        requests.push({ thread: threadId, ...request });
        if (request.id === undefined) return;
        let result = {};
        if (request.method === "initialize") result = { userAgent: "native-fixture" };
        if (["thread/start", "thread/resume"].includes(request.method)) result = { thread: { id: threadId } };
        if (request.method === "thread/queue/add") result = { queuedSubmission: { id: request.params.clientUserMessageId } };
        ws.send(JSON.stringify({ id: request.id, result }));
      }));
      server.listen(socket);
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { for (const ws of wss.clients) ws.terminate(); server.close(() => { child.exitCode = 0; child.emit("close", 0); }); };
      fixtures.push(server);
      return child;
    };
    const directories = ["one", "two"].map((name) => { const dir = path.join(root, name); fs.mkdirSync(dir); return dir; });
    let one, two, tuiOne, tuiTwo;
    try {
      one = await startCodexHost({ projectRoot: root, subscriber: first.subscriber, directory: directories[0], args: ["--model", "test-model", "test prompt"], spawnImpl });
      two = await startCodexHost({ projectRoot: root, subscriber: second.subscriber, directory: directories[1], args: ["resume", "--last"], spawnImpl });
      await expect(one.send({ command: "wait for host", deliveryId: "early" })).rejects.toMatchObject({ code: "native_not_ready" });
      // The real TUI owns creation. Its exact response passes through unchanged;
      // the wrapper never precreates a thread and tries to resume an empty one.
      tuiOne = new CodexRpc(`ws+unix://${one.args[1].slice("unix://".length)}:/`);
      tuiTwo = new CodexRpc(`ws+unix://${two.args[1].slice("unix://".length)}:/`);
      await tuiOne.connect(); await tuiTwo.connect();
      await tuiOne.call("thread/start", { cwd: root, config: { profile: "caller-profile" } });
      await tuiTwo.call("thread/resume", { threadId: crypto.randomUUID(), cwd: root });
      await until(() => loadAgentsData(getUfooPaths(root).agentsFile).agents[first.subscriber].native_delivery_ready);
      await one.send({ command: "work while busy", deliveryId: "seq:1" });
      await two.send({ command: "another session", deliveryId: "seq:2" });
      const agents = loadAgentsData(getUfooPaths(root).agentsFile).agents;
      expect(agents[first.subscriber].provider_session_id).not.toBe(agents[second.subscriber].provider_session_id);
      expect(one.args).toEqual(["--remote", expect.stringContaining("codex-tui.sock"), "--model", "test-model", "test prompt"]);
      expect(two.args).toEqual(["--remote", expect.stringContaining("codex-tui.sock"), "resume", "--last"]);
      const queued = requests.filter((r) => r.method === "thread/queue/add");
      expect(queued).toHaveLength(2);
      for (const request of queued) expect(request.params.threadId).toBe(request.thread);
      expect(queued[0].params.input[0].text).toBe("work while busy");
      expect(requests.some((r) => ["turn/start", "turn/steer"].includes(r.method))).toBe(false);
      // After binding, delivery connections send only initialize/queue, without
      // taking over the interactive TUI's thread subscriptions or approvals.
      expect(requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
      expect(requests.filter((r) => r.method === "thread/resume")).toHaveLength(1);
      expect(requests.find((r) => r.method === "thread/start").params.config.profile).toBe("caller-profile");
      tuiOne.close();
      await until(() => !loadAgentsData(getUfooPaths(root).agentsFile).agents[first.subscriber].native_delivery_ready);
      await expect(one.send({ command: "disconnected host", deliveryId: "late" })).rejects.toMatchObject({ code: "native_not_ready" });
    } finally {
      tuiOne?.close(); tuiTwo?.close();
      await one?.close(); await two?.close();
      await until(() => fixtures.every((server) => !server.listening));
    }
    expect(loadAgentsData(getUfooPaths(root).agentsFile).agents[first.subscriber].native_delivery_ready).toBe(false);
  });

  test("Claude extends caller MCP/channel options without replacing their config or prompt", async () => {
    const registration = await register(root, "claude-code", "options1");
    const callerConfig = JSON.stringify({ mcpServers: { caller: { command: "caller-tool" } } });
    const native = await prepareNativeMessages({ agentType: "claude-code", args: ["--mcp-config", callerConfig, "other.json", "--dangerously-load-development-channels=server:caller", "--", "user prompt"], projectRoot: root, subscriber: registration.subscriber });
    try {
      expect(native.args.filter((arg) => arg === "--mcp-config")).toHaveLength(1);
      expect(native.args).toEqual(["--mcp-config", callerConfig, "other.json", expect.stringContaining('"ufoo_channel"'), "--dangerously-load-development-channels", "server:caller", "server:ufoo_channel", "--", "user prompt"]);
      expect(fs.existsSync(path.join(root, ".claude", "settings.json"))).toBe(false);
      expect(native.args.join(" ")).not.toContain(registration.agent_handle);
      await expect(native.send({ command: "missing stable ID" })).rejects.toMatchObject({ code: "native_not_ready" });
    } finally { await native.close(); }
    await expect(prepareNativeMessages({ agentType: "claude-code", args: ["--input-format=stream-json"], projectRoot: root, subscriber: registration.subscriber })).rejects.toThrow("interactive");
  });

  test("Codex RPC distinguishes a rejected request from an uncertain disconnect", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    wss.on("connection", (ws) => ws.on("message", (raw) => {
      const request = JSON.parse(raw);
      if (request.id === undefined) return;
      if (request.method === "initialize") ws.send(JSON.stringify({ id: request.id, result: {} }));
      else if (request.params.reject) ws.send(JSON.stringify({ id: request.id, error: { code: -1, message: "thread not loaded" } }));
      else ws.terminate();
    }));
    const rpc = new CodexRpc(`ws://127.0.0.1:${wss.address().port}`);
    try {
      await rpc.connect();
      await expect(rpc.call("thread/queue/add", { reject: true })).rejects.toMatchObject({ remoteRejected: true });
      await expect(rpc.call("thread/queue/add", {})).rejects.toMatchObject({ code: "native_outcome_unknown" });
    } finally { rpc.close(); await new Promise((resolve) => wss.close(resolve)); }
  });

  test("Claude stdio channel gates on its native probe, delivers busy work, deduplicates and replies as the bound host", async () => {
    const registration = await register(root, "claude-code", "claude01");
    const peer = await register(root, "codex", "peer0001");
    const native = await prepareNativeMessages({ agentType: "claude-code", args: [], projectRoot: root, subscriber: registration.subscriber });
    const events = [];
    const client = new Client({ name: "native-channel-fixture", version: "1" }, { capabilities: {} });
    client.setNotificationHandler(channelSchema, (notification) => { events.push(notification.params); });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve(__dirname, "../../bin/ufoo.js"), "mcp", "channel"],
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, UFOO_SUBSCRIBER_ID: registration.subscriber, UFOO_AGENT_HANDLE: registration.agent_handle, ...native.env },
      stderr: "pipe",
    });
    try {
      expect(native.args).toContain("--dangerously-load-development-channels");
      expect(native.args).toContain("server:ufoo_channel");
      expect(native.args.join(" ")).not.toContain(registration.agent_handle);
      await client.connect(transport);
      expect(client.getServerCapabilities().experimental["claude/channel"]).toEqual({});
      expect(client.getServerCapabilities().experimental["claude/channel/permission"]).toBeUndefined();
      await until(() => events.some((event) => event.meta?.kind === "startup_probe"));
      await expect(native.send({ command: "do not drop this", deliveryId: "unready" })).rejects.toMatchObject({ code: "native_not_ready" });
      const badProbe = await client.callTool({ name: "channel_ready", arguments: { nonce: "wrong" } });
      expect(badProbe.isError).toBe(true);
      const probe = events.find((event) => event.meta.kind === "startup_probe");
      const nonce = probe.content.match(/nonce ([0-9a-f]+)/)[1];
      const receipt = await client.callTool({ name: "channel_ready", arguments: { nonce } });
      expect(receipt.structuredContent.channel_ready).toBe(true);

      const request = { command: "busy-session message", deliveryId: "seq:12", through_seq: 12 };
      await Promise.all([native.send(request), native.send(request)]);
      await native.send(request);
      await until(() => events.some((event) => event.meta?.delivery_id === "seq:12"));
      expect(events.filter((event) => event.meta?.delivery_id === "seq:12")).toHaveLength(1);
      expect(events.find((event) => event.meta?.delivery_id === "seq:12").meta.through_seq).toBe("12");
      await expect(native.send({ ...request, command: "different content" })).rejects.toThrow("reused");
      const reply = await client.callTool({ name: "dispatch_message", arguments: { target: peer.subscriber, message: "native reply" } });
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent).toMatchObject({ source: registration.subscriber, delivery_status: "queued" });
      const queued = DeliveryQueue.forSubscriber(getUfooPaths(root).busDir, peer.subscriber).readPending();
      expect(queued.some((event) => event.data.message === "native reply")).toBe(true);
      const spoof = await client.callTool({ name: "dispatch_message", arguments: { target: peer.subscriber, message: "spoof", subscriber: peer.subscriber } });
      expect(spoof.isError).toBe(true);
      await client.close();
      await until(() => !fs.existsSync(native.env.UFOO_NATIVE_CHANNEL_SOCK));
      await expect(native.send({ command: "retained after disconnect", deliveryId: "seq:13" })).rejects.toMatchObject({ code: "native_not_ready" });
      expect(loadAgentsData(getUfooPaths(root).agentsFile).agents[registration.subscriber].native_delivery_ready).toBe(false);
    } finally { await client.close(); await native.close(); }
  }, 10000);

  test("scheduler admits queued work while native host is busy and retains failures without keyboard fallback", async () => {
    const registration = await register(root, "codex", "busy0001");
    const { setNativeMetadata } = require("../../src/agents/launch/nativeMessages");
    setNativeMetadata(root, registration.subscriber, { native_delivery: "codex_queue", native_delivery_ready: true, activity_state: "working" });
    const queue = DeliveryQueue.forSubscriber(getUfooPaths(root).busDir, registration.subscriber);
    queue.append({ seq: 44, event: "message", data: { message: "wait for next turn", injection_mode: "queued" } });
    const injector = { inject: jest.fn().mockRejectedValue(Object.assign(new Error("response lost"), { code: "native_outcome_unknown" })) };
    const scheduler = new DeliveryScheduler(root, { injector, emitDelivery: async () => {} });
    const failed = await scheduler.deliverSubscriber(registration.subscriber);
    expect(failed.delivered).toBe(0);
    expect(queue.readPending()).toHaveLength(1);
    expect(injector.inject).toHaveBeenCalledTimes(1);
    expect(injector.inject.mock.calls[0][2]).toEqual({ deliveryId: `${registration.subscriber}:seq:44`, through_seq: 44 });
    injector.inject.mockResolvedValue(undefined);
    const accepted = await scheduler.deliverSubscriber(registration.subscriber);
    expect(accepted.delivered).toBe(1);
    expect(queue.readPending()).toHaveLength(0);
  });

  test("an unconfirmed native receiver remains gated even after force-delivery timeouts", async () => {
    const registration = await register(root, "claude-code", "unready1");
    const { setNativeMetadata } = require("../../src/agents/launch/nativeMessages");
    setNativeMetadata(root, registration.subscriber, { native_delivery: "claude_channel", native_delivery_ready: false, activity_state: "idle" });
    const queue = DeliveryQueue.forSubscriber(getUfooPaths(root).busDir, registration.subscriber);
    queue.append({ seq: 45, event: "message", data: { message: "retain until confirmed", injection_mode: "queued" } });
    const injector = { inject: jest.fn() };
    let now = 1000;
    const scheduler = new DeliveryScheduler(root, { injector, now: () => now, forceDeliveryAfterMs: 1 });
    await scheduler.deliverSubscriber(registration.subscriber);
    now += 1000000;
    await scheduler.deliverSubscriber(registration.subscriber);
    expect(injector.inject).not.toHaveBeenCalled();
    expect(queue.readPending()).toHaveLength(1);
  });

  test("scheduler defers uncertain receipts until explicit resolution, without repeated writes", async () => {
    const registration = await register(root, "codex", "recovery1");
    const { setNativeMetadata } = require("../../src/agents/launch/nativeMessages");
    const { withNativeReceipts, listNativeReceipts, resolveNativeReceipt } = require("../../src/coordination/bus/nativeReceipts");
    setNativeMetadata(root, registration.subscriber, { native_delivery: "codex_queue", native_delivery_ready: true });
    const queue = DeliveryQueue.forSubscriber(getUfooPaths(root).busDir, registration.subscriber);
    queue.append({ seq: 46, event: "message", data: { message: "recover work" } });
    const send = jest.fn().mockRejectedValue(new Error("response lost"));
    const deliver = withNativeReceipts({ projectRoot: root, subscriber: registration.subscriber, send });
    const scheduler = new DeliveryScheduler(root, {
      injector: { inject: (_id, command, options) => deliver({ command, ...options }) },
    });
    expect((await scheduler.deliverSubscriber(registration.subscriber)).delivered).toBe(0);
    expect(await scheduler.deliverSubscriber(registration.subscriber)).toMatchObject({ deferred: true, reason: "native_outcome_unknown" });
    expect(send).toHaveBeenCalledTimes(1);
    const [receipt] = listNativeReceipts(root, registration.subscriber);
    resolveNativeReceipt(root, registration.subscriber, receipt.id, "accepted");
    expect((await scheduler.deliverSubscriber(registration.subscriber)).delivered).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.readPending()).toHaveLength(0);
  });

  test("an uncertain channel write stays durable and cannot be silently replayed after restart", async () => {
    const registration = await register(root, "claude-code", "unknown1");
    const options = { agentType: "claude-code", args: [], projectRoot: root, subscriber: registration.subscriber };
    const native = await prepareNativeMessages(options);
    let attempts = 0;
    const server = net.createServer((client) => client.once("data", () => {
      attempts += 1;
      client.end("invalid receipt\n");
    }));
    await new Promise((resolve) => server.listen(native.env.UFOO_NATIVE_CHANNEL_SOCK, resolve));
    let restarted;
    try {
      const request = { command: "uncertain work", deliveryId: "seq:99" };
      await expect(native.send(request)).rejects.toMatchObject({ code: "native_outcome_unknown" });
      await expect(native.send(request)).rejects.toMatchObject({ code: "native_outcome_unknown" });
      restarted = await prepareNativeMessages(options);
      await expect(restarted.send(request)).rejects.toMatchObject({ code: "native_outcome_unknown" });
      expect(attempts).toBe(1);
      const dir = path.join(getUfooPaths(root).busQueuesDir, registration.subscriber.replace(/:/g, "_"), "native-receipts");
      const receipt = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"));
      expect(receipt.state).toBe("unknown");
      expect(JSON.stringify(receipt)).not.toContain(request.command);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await native.close(); await restarted?.close();
    }
  });

  test("a wrapper socket disconnect rejects instead of holding the daemon delivery lock forever", async () => {
    const socket = path.join(root, "wrapper.sock");
    const server = net.createServer((client) => client.once("data", () => client.destroy()));
    await new Promise((resolve) => server.listen(socket, resolve));
    try {
      const Injector = require("../../src/coordination/bus/inject");
      const injector = new Injector(getUfooPaths(root).busDir, getUfooPaths(root).agentsFile);
      await expect(injector.injectPtyAtPath(socket, "uncertain", { deliveryId: "seq:77" })).rejects.toMatchObject({ code: "native_outcome_unknown" });
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
