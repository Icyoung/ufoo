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
});
