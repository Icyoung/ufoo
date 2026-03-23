const { runBusCoreCommand } = require("../../../src/cli/busCoreCommands");

describe("busCoreCommands", () => {
  test("send joins multi-word message and defaults to immediate", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      send: jest.fn().mockResolvedValue({}),
    };

    await runBusCoreCommand(eventBus, "send", ["codex:1", "hello", "world"]);

    expect(eventBus.ensureJoined).toHaveBeenCalledTimes(1);
    expect(eventBus.send).toHaveBeenCalledWith("codex:1", "hello world", "codex:sender", {
      injectionMode: "immediate",
      source: "",
    });
  });

  test("send supports queued mode and explicit source", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      send: jest.fn().mockResolvedValue({}),
    };

    await runBusCoreCommand(eventBus, "send", ["--queued", "--source", "chat-agent", "codex:1", "follow", "up"]);

    expect(eventBus.send).toHaveBeenCalledWith("codex:1", "follow up", "codex:sender", {
      injectionMode: "queued",
      source: "chat-agent",
    });
  });

  test("send keeps flag-like tokens inside message body", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      send: jest.fn().mockResolvedValue({}),
    };

    await runBusCoreCommand(eventBus, "send", ["codex:1", "message", "--source", "foo"]);

    expect(eventBus.send).toHaveBeenCalledWith("codex:1", "message --source foo", "codex:sender", {
      injectionMode: "immediate",
      source: "",
    });
  });

  test("send throws when missing args", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      send: jest.fn().mockResolvedValue({}),
    };
    await expect(runBusCoreCommand(eventBus, "send", ["only-target"])).rejects.toThrow("send requires");
  });

  test("init command", async () => {
    const eventBus = { init: jest.fn().mockResolvedValue() };
    await runBusCoreCommand(eventBus, "init");
    expect(eventBus.init).toHaveBeenCalled();
  });

  test("join command", async () => {
    const eventBus = { join: jest.fn().mockResolvedValue("codex:s1") };
    const result = await runBusCoreCommand(eventBus, "join", ["s1", "codex", "builder"]);
    expect(eventBus.join).toHaveBeenCalledWith("s1", "codex", "builder");
    expect(result.subscriber).toBe("codex:s1");
  });

  test("leave command", async () => {
    const eventBus = { leave: jest.fn().mockResolvedValue(true) };
    await runBusCoreCommand(eventBus, "leave", ["codex:test"]);
    expect(eventBus.leave).toHaveBeenCalledWith("codex:test");
  });

  test("broadcast command", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      broadcast: jest.fn().mockResolvedValue(),
    };
    await runBusCoreCommand(eventBus, "broadcast", ["hello"]);
    expect(eventBus.broadcast).toHaveBeenCalledWith("hello", "codex:sender");
  });

  test("wake command", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      wake: jest.fn().mockResolvedValue(),
    };
    await runBusCoreCommand(eventBus, "wake", ["codex:target"]);
    expect(eventBus.wake).toHaveBeenCalledWith("codex:target", expect.objectContaining({ publisher: "codex:sender" }));
  });

  test("check command", async () => {
    const eventBus = { check: jest.fn().mockResolvedValue([]) };
    await runBusCoreCommand(eventBus, "check", ["codex:test"]);
    expect(eventBus.check).toHaveBeenCalledWith("codex:test");
  });

  test("ack command", async () => {
    const eventBus = { ack: jest.fn().mockResolvedValue(0) };
    await runBusCoreCommand(eventBus, "ack", ["codex:test"]);
    expect(eventBus.ack).toHaveBeenCalledWith("codex:test");
  });

  test("consume command", async () => {
    const eventBus = { consume: jest.fn().mockResolvedValue({ consumed: [], newOffset: 0 }) };
    await runBusCoreCommand(eventBus, "consume", ["codex:test"]);
    expect(eventBus.consume).toHaveBeenCalledWith("codex:test", false);
  });

  test("consume with --from-beginning", async () => {
    const eventBus = { consume: jest.fn().mockResolvedValue({ consumed: [], newOffset: 0 }) };
    await runBusCoreCommand(eventBus, "consume", ["codex:test", "--from-beginning"]);
    expect(eventBus.consume).toHaveBeenCalledWith("codex:test", true);
  });

  test("status command", async () => {
    const eventBus = { status: jest.fn().mockResolvedValue() };
    await runBusCoreCommand(eventBus, "status");
    expect(eventBus.status).toHaveBeenCalled();
  });

  test("resolve command", async () => {
    const eventBus = { resolve: jest.fn().mockResolvedValue(null) };
    await runBusCoreCommand(eventBus, "resolve", ["codex:me", "claude-code"]);
    expect(eventBus.resolve).toHaveBeenCalledWith("codex:me", "claude-code");
  });

  test("rename command", async () => {
    const eventBus = { rename: jest.fn().mockResolvedValue() };
    await runBusCoreCommand(eventBus, "rename", ["codex:test", "new-name"]);
    expect(eventBus.rename).toHaveBeenCalledWith("codex:test", "new-name");
  });

  test("whoami command", async () => {
    const eventBus = { whoami: jest.fn().mockResolvedValue("codex:test") };
    await runBusCoreCommand(eventBus, "whoami");
    expect(eventBus.whoami).toHaveBeenCalled();
  });

  test("unknown command throws", async () => {
    await expect(runBusCoreCommand({}, "unknown")).rejects.toThrow("Unknown bus subcommand");
  });

  test("send with --immediate flag (explicit)", async () => {
    const eventBus = {
      ensureJoined: jest.fn().mockResolvedValue("codex:sender"),
      send: jest.fn().mockResolvedValue({}),
    };
    await runBusCoreCommand(eventBus, "send", ["--immediate", "codex:1", "msg"]);
    expect(eventBus.send).toHaveBeenCalledWith("codex:1", "msg", "codex:sender", {
      injectionMode: "immediate",
      source: "",
    });
  });
});
