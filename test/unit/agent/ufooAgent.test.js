const fs = require("fs");
const { runUfooAgent } = require("../../../src/agent/ufooAgent");

jest.mock("../../../src/agent/cliRunner", () => ({
  runCliAgent: jest.fn(),
}));
jest.mock("../../../src/daemon/status", () => ({
  buildStatus: jest.fn(),
}));
jest.mock("../../../src/agent/normalizeOutput", () => ({
  normalizeCliOutput: jest.fn((value) => String(value || "")),
}));
jest.mock("../../../src/code/nativeRunner", () => ({
  resolveRuntimeConfig: jest.fn(() => ({
    provider: "openai",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    transport: "openai-chat",
  })),
  resolveCompletionUrl: jest.fn(() => "https://api.openai.com/v1/chat/completions"),
  resolveAnthropicMessagesUrl: jest.fn(() => "https://api.anthropic.com/v1/messages"),
}));

const { runCliAgent } = require("../../../src/agent/cliRunner");
const { buildStatus } = require("../../../src/daemon/status");

describe("ufooAgent prompt schema", () => {
  const projectRoot = "/tmp/ufoo-agent-schema-test";

  beforeEach(() => {
    if (fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(projectRoot, { recursive: true });
    buildStatus.mockReturnValue({ active_meta: [] });
    runCliAgent.mockResolvedValue({
      ok: true,
      sessionId: "sess-1",
      output: "{\"reply\":\"ok\",\"dispatch\":[],\"ops\":[]}",
    });
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    jest.clearAllMocks();
  });

  test("injects assistant_call rules into system prompt", async () => {
    const res = await runUfooAgent({
      projectRoot,
      prompt: "inspect project",
      provider: "codex-cli",
      model: "",
    });

    expect(res.ok).toBe(true);
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("assistant_call");
    expect(call.systemPrompt).toContain("Use top-level assistant_call for project exploration");
    expect(call.systemPrompt).toContain("\"assistant_call\": {\"kind\":\"explore|bash|mixed\"");
  });

  test("ucode provider uses native HTTP path instead of CLI", async () => {
    const responsePayload = { reply: "native ok", dispatch: [], ops: [] };
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(responsePayload) } }],
      }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await runUfooAgent({
      projectRoot,
      prompt: "hello",
      provider: "ucode",
      model: "gpt-4o",
    });

    expect(res.ok).toBe(true);
    expect(res.payload.reply).toBe("native ok");
    // Should NOT have called the CLI runner
    expect(runCliAgent).not.toHaveBeenCalled();
    // Should have called fetch
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("chat/completions");
    const body = JSON.parse(opts.body);
    // System prompt should contain router schema
    const systemMsg = body.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeTruthy();
    expect(systemMsg.content).toContain("ufoo-agent");

    delete global.fetch;
  });

  test("ucode provider strips markdown fence from response", async () => {
    const responsePayload = { reply: "fenced ok", dispatch: [], ops: [] };
    const fenced = "```json\n" + JSON.stringify(responsePayload, null, 2) + "\n```";
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: fenced } }],
      }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await runUfooAgent({
      projectRoot,
      prompt: "test fence",
      provider: "ucode",
      model: "gpt-4o",
    });

    expect(res.ok).toBe(true);
    expect(res.payload.reply).toBe("fenced ok");
    expect(runCliAgent).not.toHaveBeenCalled();

    delete global.fetch;
  });

  test("ucode provider handles fetch failure gracefully", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

    const res = await runUfooAgent({
      projectRoot,
      prompt: "hello",
      provider: "ucode",
      model: "",
    });

    expect(res.ok).toBe(false);
    expect(runCliAgent).not.toHaveBeenCalled();

    delete global.fetch;
  });
});
