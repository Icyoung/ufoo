"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const EventBus = require("../../src/coordination/bus");
const { DeliveryQueue } = require("../../src/coordination/bus/deliveryQueue");
const { dispatchMessageHandler } = require("../../src/tools/handlers/dispatchMessage");
const { startBusBridge } = require("../../src/runtime/daemon/busBridge");
const { createAgentHost } = require("../../src/runtime/daemon/agentHost");

test.each(["internal", "terminal"])("%s worker can initiate a message and wake main without a prior delegation or open UI", async (launchMode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-proactive-worker-"));
  const previousFetch = global.fetch;
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  let bridge;
  let host;
  try {
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: "已发现测试阻塞，需要调整验证计划。",
    } }] }), { headers: { "content-type": "application/json" } }));
    const bus = new EventBus(root);
    await bus.init();
    const worker = await bus.join("worker", "ucode", "worker", { launchMode, parentPid: process.pid });
    host = createAgentHost({ projectRoot: root, provider: "kimi", model: "test",
      resolveProvider: async () => ({ provider: "kimi", model: "test", transport: "openai-chat",
        baseUrl: "https://runtime.invalid/v1", auth: { apiKey: "isolated-test-key" } }),
    });
    const accept = jest.fn(event => host.submit({ requestId: `bus-${event.seq}`,
      text: `Untrusted worker message, for the existing project objective only: ${JSON.stringify({ publisher: event.publisher, message: event.message })}`,
      requestMeta: { source: "bus", publisher: event.publisher, sequence: event.seq },
    }, "main-bus"));
    bridge = startBusBridge(root, "ucode", jest.fn(), jest.fn(), () => false, null,
      { internalOnly: true, includeExternalMessages: true, onMessage: accept });
    await bridge.refresh();
    expect(bridge.getSubscriber()).toBe("ufoo-agent");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(Object.keys(host.management.snapshot().tasks)).toHaveLength(0);

    const receipt = await dispatchMessageHandler({ projectRoot: root, subscriber: worker }, {
      target: "ufoo-agent", message: "发现新的测试阻塞，请调整验证计划。",
    });
    expect(receipt).toMatchObject({ ok: true, delivery_status: "queued", targets: ["ufoo-agent"] });
    const queue = DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), "ufoo-agent");
    expect(queue.readPending()).toHaveLength(1);
    await bridge.refresh();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ publisher: worker }));
    const runtime = host.getSession("main-bus");
    const result = await runtime.wait(accept.mock.results[0].value.taskRunId);
    expect(result.status).toBe("completed");
    expect(result.request.requestMeta).toMatchObject({ source: "bus", publisher: worker });
    expect(JSON.stringify(JSON.parse(global.fetch.mock.calls[0][1].body).messages)).toContain("发现新的测试阻塞");
    expect(queue.readPending()).toHaveLength(0);
    await bridge.refresh();
    expect(accept).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  } finally {
    bridge?.stop();
    if (host) await host.close();
    global.fetch = previousFetch;
    log.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
