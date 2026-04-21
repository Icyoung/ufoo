const fs = require("fs");
const os = require("os");
const path = require("path");

const EventBus = require("../../../src/bus");
const { dispatchMessageHandler } = require("../../../src/tools/handlers/dispatchMessage");
const { ackBusHandler } = require("../../../src/tools/handlers/ackBus");

describe("tool handlers", () => {
  let projectRoot;
  let eventBus;
  let sender;
  let receiver;
  let logSpy;
  let errorSpy;

  beforeEach(async () => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-tool-handlers-"));
    eventBus = new EventBus(projectRoot);
    await eventBus.init();
    sender = await eventBus.join("sender", "codex", "sender");
    receiver = await eventBus.join("receiver", "claude-code", "receiver");
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("dispatch_message sends to a concrete subscriber with caller-owned source", async () => {
    const result = await dispatchMessageHandler(
      { projectRoot, subscriber: sender, eventBus },
      { target: receiver, message: "handle this", source: sender, mode: "immediate" }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        target: receiver,
        source: sender,
        mode: "immediate",
        delivered: 1,
        queued: 0,
        targets: [receiver],
      })
    );

    eventBus.loadBusData();
    const pending = await eventBus.messageManager.check(receiver);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(
      expect.objectContaining({
        publisher: sender,
        target: receiver,
        data: expect.objectContaining({
          message: "handle this",
          source: sender,
          injection_mode: "immediate",
        }),
      })
    );
  });

  test("dispatch_message allows broadcast target alias", async () => {
    const result = await dispatchMessageHandler(
      { projectRoot, subscriber: sender, eventBus },
      { target: "broadcast", message: "hello all" }
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        target: "broadcast",
        mode: "immediate",
      })
    );
    expect(result.targets).toEqual(expect.arrayContaining([sender, receiver]));
  });

  test("dispatch_message rejects mismatched source", async () => {
    await expect(
      dispatchMessageHandler(
        { projectRoot, subscriber: sender, eventBus },
        { target: receiver, message: "handle this", source: "codex:other" }
      )
    ).rejects.toMatchObject({
      code: "forbidden_source",
    });
  });

  test("dispatch_message rejects missing targets and non-agent queues", async () => {
    await expect(
      dispatchMessageHandler(
        { projectRoot, subscriber: sender, eventBus },
        { target: "ghost-queue", message: "handle this" }
      )
    ).rejects.toMatchObject({
      code: "invalid_target",
    });
  });

  test("dispatch_message rejects invalid modes", async () => {
    await expect(
      dispatchMessageHandler(
        { projectRoot, subscriber: sender, eventBus },
        { target: receiver, message: "handle this", mode: "later" }
      )
    ).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  });

  test("ack_bus acknowledges only the caller-owned queue", async () => {
    await eventBus.send(sender, "pending item", receiver, { silent: true });
    eventBus.loadBusData();
    const before = await eventBus.messageManager.check(sender);
    expect(before).toHaveLength(1);

    const result = await ackBusHandler(
      { projectRoot, subscriber: sender, eventBus },
      { subscriber: sender }
    );

    expect(result).toEqual({
      ok: true,
      subscriber: sender,
      acknowledged: 1,
    });
    eventBus.loadBusData();
    await expect(eventBus.messageManager.check(sender)).resolves.toHaveLength(0);
  });

  test("ack_bus rejects attempts to acknowledge another queue", async () => {
    await expect(
      ackBusHandler(
        { projectRoot, subscriber: sender, eventBus },
        { subscriber: receiver }
      )
    ).rejects.toMatchObject({
      code: "forbidden_ack",
    });
  });
});
