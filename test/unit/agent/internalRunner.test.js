const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/agent/cliRunner", () => ({
  runCliAgent: jest.fn(),
}));

jest.mock("../../../src/agent/normalizeOutput", () => ({
  normalizeCliOutput: jest.fn(),
}));

const { runCliAgent } = require("../../../src/agent/cliRunner");
const { normalizeCliOutput } = require("../../../src/agent/normalizeOutput");
const { handleEvent, createBusSender } = require("../../../src/agent/internalRunner");

describe("agent internalRunner stream forwarding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("forwards stream delta envelopes and done marker", async () => {
    runCliAgent.mockImplementationOnce(async (params) => {
      params.onStreamDelta("hello");
      params.onStreamDelta(" world");
      return { ok: true, output: [{ item: { type: "agent_message", text: "hello world" } }], sessionId: "sess-1" };
    });
    normalizeCliOutput.mockReturnValue("hello world");

    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:1", data: { message: "say hi" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "gpt-5.2-codex",
      "codex:abc",
      "codex-1",
      evt,
      state,
      busSender
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("chat:1", JSON.stringify({ stream: true, delta: "hello" }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:1", JSON.stringify({ stream: true, delta: " world" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:1",
      JSON.stringify({ stream: true, done: true, reason: "complete" })
    );
    expect(busSender.enqueue).not.toHaveBeenCalledWith("chat:1", "hello world");
    expect(busSender.flush).toHaveBeenCalled();
  });

  test("falls back to plain reply when no stream delta exists", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: [{ item: { type: "agent_message", text: "done" } }] });
    normalizeCliOutput.mockReturnValueOnce("done");

    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:2", data: { message: "task" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "gpt-5.2-codex",
      "codex:def",
      "codex-2",
      evt,
      state,
      busSender
    );

    expect(busSender.enqueue).toHaveBeenCalledTimes(1);
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:2", "done");
    expect(busSender.flush).toHaveBeenCalled();
  });

  test("appends error to stream and sends done:error on failure", async () => {
    runCliAgent.mockImplementationOnce(async (params) => {
      params.onStreamDelta("partial");
      return { ok: false, error: "boom" };
    });
    normalizeCliOutput.mockReturnValue("");

    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:3", data: { message: "task" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "gpt-5.2-codex",
      "codex:ghi",
      "codex-3",
      evt,
      state,
      busSender
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("chat:3", JSON.stringify({ stream: true, delta: "partial" }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:3", JSON.stringify({ stream: true, delta: "\n" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:3",
      JSON.stringify({ stream: true, delta: "[internal:codex] error: boom" })
    );
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:3",
      JSON.stringify({ stream: true, done: true, reason: "error" })
    );
  });

  test("skips event with no data or message", async () => {
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:x", "n", null, state, busSender);
    expect(busSender.enqueue).not.toHaveBeenCalled();

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:x", "n", { data: {} }, state, busSender);
    expect(busSender.enqueue).not.toHaveBeenCalled();
  });

  test("sends plain error reply when no stream and error", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: false, error: "fail" });
    normalizeCliOutput.mockReturnValueOnce("");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:4", data: { message: "do" } };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:y", "n", evt, state, busSender);

    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:4",
      "[internal:codex] error: fail"
    );
  });

  test("skips enqueue when reply is empty and no stream", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: "" });
    normalizeCliOutput.mockReturnValueOnce("");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:5", data: { message: "do" } };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:z", "n", evt, state, busSender);

    expect(busSender.enqueue).not.toHaveBeenCalled();
  });

  test("retries with new session on claude session errors", async () => {
    runCliAgent
      .mockResolvedValueOnce({ ok: false, error: "session already in use" })
      .mockResolvedValueOnce({ ok: true, output: "ok", sessionId: "new-sess" });
    normalizeCliOutput.mockReturnValue("ok");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: "old-sess", needsSave: false };
    const evt = { publisher: "chat:6", data: { message: "do" } };

    await handleEvent("/tmp", "claude-code", "claude-cli", "", "claude:a", "n", evt, state, busSender);

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    expect(state.cliSessionId).toBe("new-sess");
    expect(state.needsSave).toBe(true);
  });

  test("updates session ID on successful claude response", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: "done", sessionId: "sess-42" });
    normalizeCliOutput.mockReturnValue("done");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:7", data: { message: "task" } };

    await handleEvent("/tmp", "claude-code", "claude-cli", "", "claude:b", "n", evt, state, busSender);

    expect(state.cliSessionId).toBe("sess-42");
    expect(state.needsSave).toBe(true);
  });
});

describe("createBusSender", () => {
  test("enqueue and flush work without errors", async () => {
    // createBusSender needs a real project root with bus init
    // Just test that it creates the interface
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-irunner-"));
    try {
      const sender = createBusSender(tmpDir, "codex:test");
      expect(typeof sender.enqueue).toBe("function");
      expect(typeof sender.flush).toBe("function");
      // Enqueue with empty target does nothing
      sender.enqueue("", "");
      await sender.flush();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
