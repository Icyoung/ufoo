const { EventEmitter } = require("events");

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

const { spawn } = require("child_process");
const {
  runCliAgent,
  extractCodexStreamDelta,
  extractCodexToolEvent,
  createCodexJsonlStreamParser,
} = require("../../../src/agent/cliRunner");

function makeChildProcess({
  stdoutChunks = [],
  stderrChunks = [],
  code = 0,
  closeDelayMs = 0,
} = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: jest.fn(),
    end: jest.fn(),
  };

  process.nextTick(() => {
    for (const chunk of stdoutChunks) {
      child.stdout.emit("data", Buffer.from(String(chunk), "utf8"));
    }
    for (const chunk of stderrChunks) {
      child.stderr.emit("data", Buffer.from(String(chunk), "utf8"));
    }
    if (closeDelayMs > 0) {
      setTimeout(() => child.emit("close", code), closeDelayMs);
    } else {
      child.emit("close", code);
    }
  });

  return child;
}

describe("agent cliRunner streaming", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("extractCodexStreamDelta reads agent_message and delta fields", () => {
    expect(extractCodexStreamDelta({
      type: "item.completed",
      item: { type: "agent_message", text: "hello" },
    })).toBe("hello");
    expect(extractCodexStreamDelta({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    })).toBe("x");
    expect(extractCodexStreamDelta({ type: "noop" })).toBe("");
  });

  test("extractCodexToolEvent recognizes core tool call events", () => {
    const event = {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "call-1",
        name: "read",
        arguments: "{\"path\":\"src/code/tui.js\"}",
      },
    };
    expect(extractCodexToolEvent(event)).toEqual(expect.objectContaining({
      tool: "read",
      phase: "start",
      args: { path: "src/code/tui.js" },
    }));
  });

  test("createCodexJsonlStreamParser emits deltas and tool events across chunk boundaries", () => {
    const deltas = [];
    const toolEvents = [];
    const parser = createCodexJsonlStreamParser({
      onDelta: (delta) => deltas.push(delta),
      onToolEvent: (event) => toolEvents.push(event),
    });

    parser.onChunk("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"Hello \"}}\n");
    parser.onChunk("not-json\n{\"type\":\"response.output_item.added\",\"item\":{\"type\":\"tool_call\",\"name\":\"bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}}\n");
    parser.onChunk("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"world\"}}");
    parser.flush();

    expect(deltas).toEqual(["Hello ", "world"]);
    expect(toolEvents).toEqual([
      expect.objectContaining({
        tool: "bash",
        args: { command: "ls" },
      }),
    ]);
  });

  test("runCliAgent forwards codex stream deltas and still returns parsed output", async () => {
    spawn.mockImplementation(() => makeChildProcess({
      stdoutChunks: [
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"A\"}}\n",
        "{\"type\":\"response.output_item.added\",\"item\":{\"type\":\"tool_call\",\"name\":\"write\",\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}}\n",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"B\"}}",
      ],
      code: 0,
    }));

    const deltas = [];
    const toolEvents = [];
    const result = await runCliAgent({
      provider: "codex-cli",
      prompt: "say hi",
      cwd: process.cwd(),
      onStreamDelta: (delta) => deltas.push(delta),
      onToolEvent: (event) => toolEvents.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.streamed).toBe(true);
    expect(Array.isArray(result.output)).toBe(true);
    expect(result.output).toHaveLength(3);
    expect(deltas).toEqual(["A", "B"]);
    expect(toolEvents).toEqual([
      expect.objectContaining({
        tool: "write",
        phase: "start",
      }),
    ]);
  });

  test("runCliAgent appends extra args before prompt", async () => {
    spawn.mockImplementation(() => makeChildProcess({
      stdoutChunks: ["{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}\n"],
      code: 0,
    }));

    const result = await runCliAgent({
      provider: "codex-cli",
      prompt: "say hi",
      cwd: process.cwd(),
      extraArgs: ["--model", "gpt-5.4-mini", "--approval-mode", "full-auto"],
    });

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "gpt-5.4-mini",
      "--approval-mode",
      "full-auto",
      "say hi",
    ]);
  });

  test("runCliAgent retries claude without unsupported no-session-persistence flag", async () => {
    spawn
      .mockImplementationOnce(() => makeChildProcess({
        stderrChunks: ["error: unknown option '--no-session-persistence'"],
        code: 1,
      }))
      .mockImplementationOnce(() => makeChildProcess({
        stdoutChunks: [JSON.stringify({ reply: "ok", dispatch: [], ops: [] })],
        code: 0,
      }));

    const result = await runCliAgent({
      provider: "claude-cli",
      prompt: "say hi",
      cwd: process.cwd(),
    });

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toContain("--no-session-persistence");
    expect(spawn.mock.calls[1][1]).not.toContain("--no-session-persistence");
  });

  test("runCliAgent strips multiple unsupported claude options progressively", async () => {
    spawn
      .mockImplementationOnce(() => makeChildProcess({
        stderrChunks: ["error: unknown option '--no-session-persistence'"],
        code: 1,
      }))
      .mockImplementationOnce(() => makeChildProcess({
        stderrChunks: ["error: unknown option '--json-schema'"],
        code: 1,
      }))
      .mockImplementationOnce(() => makeChildProcess({
        stdoutChunks: [JSON.stringify({ reply: "ok", dispatch: [], ops: [] })],
        code: 0,
      }));

    const result = await runCliAgent({
      provider: "claude-cli",
      prompt: "say hi",
      cwd: process.cwd(),
    });

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(spawn.mock.calls[1][1]).not.toContain("--no-session-persistence");
    expect(spawn.mock.calls[1][1]).toContain("--json-schema");
    expect(spawn.mock.calls[2][1]).not.toContain("--no-session-persistence");
    expect(spawn.mock.calls[2][1]).not.toContain("--json-schema");
  });

  test("runCliAgent reports timeout with configured milliseconds", async () => {
    spawn.mockImplementation(() => makeChildProcess({
      closeDelayMs: 50,
      code: 0,
    }));

    const result = await runCliAgent({
      provider: "claude-cli",
      prompt: "timeout please",
      cwd: process.cwd(),
      timeoutMs: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("CLI timeout (10ms)");
  });

  test("runCliAgent supports external cancellation via AbortSignal", async () => {
    spawn.mockImplementation(() => makeChildProcess({
      closeDelayMs: 100,
      code: 0,
    }));

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);

    const result = await runCliAgent({
      provider: "claude-cli",
      prompt: "cancel me",
      cwd: process.cwd(),
      timeoutMs: 1000,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("CLI cancelled");
  });
});
