"use strict";

const fs = require("fs");
const net = require("net");
const crypto = require("crypto");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { ensureBusLoaded, assertAgentHandle } = require("./controlPlaneService");
const { setNativeMetadata, nativeError } = require("../../agents/launch/nativeMessages");
const { getToolDefinition } = require("../../tools/registry");

async function createClaudeChannel(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const subscriber = options.subscriber || process.env.UFOO_SUBSCRIBER_ID;
  const agentHandle = options.agentHandle || process.env.UFOO_AGENT_HANDLE;
  const socketPath = options.socketPath || process.env.UFOO_NATIVE_CHANNEL_SOCK;
  if (!subscriber || !agentHandle || !socketPath) throw nativeError("Claude channel must be launched by a ufoo host");
  const authenticate = () => {
    const bus = ensureBusLoaded(projectRoot);
    const meta = assertAgentHandle(bus, subscriber, { agent_handle: agentHandle });
    if (meta.mcp_bridge === true || meta.native_delivery !== "claude_channel" || meta.native_delivery_instance !== socketPath) {
      throw nativeError("Claude channel requires its managed host identity");
    }
    return bus;
  };
  authenticate();
  const nonce = crypto.randomBytes(24).toString("hex");
  let ready = false;
  let closing = false;
  const clients = new Set();
  const receipts = new Map();
  const probeTimers = new Set();
  const stopProbes = () => { for (const timer of probeTimers) clearTimeout(timer); probeTimers.clear(); };
  const sharedNames = ["dispatch_message", "ack_bus"];
  const server = new Server({ name: "ufoo_channel", version: require("../../../package.json").version }, {
    capabilities: { experimental: { "claude/channel": {} }, tools: {} },
    instructions: "ufoo messages arrive through this channel. Only call channel_ready after receiving its native startup probe, using the probe nonce. Channel dispatch_message and ack_bus are bound to your host identity; do not provide another subscriber or handle. Process bus messages and acknowledge their through_seq. Send a reply only when there is a concrete result for the sender. Sending confirms queue persistence, not task completion.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "channel_ready", description: "Confirm receipt of the native channel startup probe; its nonce is present only in that event.",
      inputSchema: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"], additionalProperties: false } },
    ...sharedNames.map((name) => {
      const tool = getToolDefinition(name);
      return { name, description: tool.description, inputSchema: tool.input_schema };
    }),
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const bus = authenticate();
      const args = request.params.arguments || {};
      let result;
      if (request.params.name === "channel_ready") {
        if (args.nonce !== nonce) throw nativeError("Invalid channel probe receipt");
        ready = true;
        stopProbes();
        setNativeMetadata(projectRoot, subscriber, { native_delivery_ready: true });
        result = { ok: true, subscriber, channel_ready: true };
      } else {
        if (!sharedNames.includes(request.params.name)) throw nativeError("Unknown channel tool");
        if (args.agent_handle || args.project_root || (args.subscriber && args.subscriber !== subscriber)) {
          throw nativeError("Channel tools are bound to this host identity");
        }
        const tool = getToolDefinition(request.params.name);
        result = await tool.handler({ projectRoot, subscriber, callerTier: "worker", eventBus: bus }, args);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err.message }] };
    }
  });
  const listener = net.createServer((client) => {
    clients.add(client);
    client.on("error", () => {});
    client.once("close", () => clients.delete(client));
    client.setTimeout(10000, () => client.destroy());
    let buffer = "";
    let handled = false;
    client.on("data", (data) => {
      if (handled) return;
      buffer += data;
      if (buffer.length > 1024 * 1024) { client.destroy(); return; }
      if (!buffer.includes("\n")) return;
      handled = true;
      void (async () => {
        const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        authenticate();
        if (!ready || closing) throw nativeError("Claude has not confirmed native channel readiness");
        if (typeof request.command !== "string" || !request.command.trim() || !request.deliveryId) throw nativeError("Invalid native delivery request");
        const id = String(request.deliveryId);
        const digest = crypto.createHash("sha256").update(request.command).digest("hex");
        let previous = receipts.get(id);
        if (previous && previous.digest !== digest) throw nativeError("Delivery ID was reused for different content");
        if (previous?.failed && request.retryAuthorized === true) {
          receipts.delete(id);
          previous = null;
        }
        if (!previous) {
          // Record before the write. Never emit the same event twice if its
          // socket receipt is lost; the host also keeps durable write receipts.
          const receipt = { digest };
          receipts.set(id, receipt);
          receipt.write = server.notification({ method: "notifications/claude/channel", params: {
            content: request.command,
            meta: { subscriber, delivery_id: id, ...(request.through_seq ? { through_seq: String(request.through_seq) } : {}) },
          } }).catch((error) => { receipt.failed = true; throw error; });
        }
        // Concurrent socket retries share the write and its failure outcome.
        await receipts.get(id).write;
        client.end(`${JSON.stringify({ ok: true, queued: true })}\n`);
      })().catch((err) => {
        if (!client.destroyed) client.end(`${JSON.stringify({ ok: false, error: err.message, code: err.code || "native_outcome_unknown" })}\n`);
      });
    });
  });
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  const close = async () => {
    if (closing) return;
    closing = true;
    ready = false;
    stopProbes();
    try {
      authenticate();
      setNativeMetadata(projectRoot, subscriber, { native_delivery_ready: false });
    } catch { /* host may already have left or replaced this receiver */ }
    for (const client of clients) client.destroy();
    await new Promise((resolve) => listener.close(resolve));
    fs.rmSync(socketPath, { force: true });
    await server.close();
  };
  server.onclose = () => { void close(); };
  server.oninitialized = () => {
    // Claude installs its channel notification handler after initialization.
    // An immediate notification can be lost before that handler exists.
    for (const delay of [250, 1000, 3000]) {
      const timer = setTimeout(() => {
        probeTimers.delete(timer);
        if (ready || closing) return;
        void server.notification({ method: "notifications/claude/channel", params: {
          content: `ufoo native channel startup probe. Call channel_ready with nonce ${nonce} to confirm this event arrived. This probe is not a user task.`,
          meta: { kind: "startup_probe" },
        } }).catch(() => close());
      }, delay);
      probeTimers.add(timer);
    }
  };
  try { await server.connect(options.transport || new StdioServerTransport()); }
  catch (err) { await close(); throw err; }
  return { server, close, socketPath };
}

async function runClaudeChannel() {
  const channel = await createClaudeChannel();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void channel.close().finally(() => process.exit(0)); });
  return channel;
}

module.exports = { createClaudeChannel, runClaudeChannel };
