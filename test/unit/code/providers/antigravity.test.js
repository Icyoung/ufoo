"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getNativeTransport } = require("../../../../src/agents/providers/nativeTransport");
const { resolveRuntimeConfig } = require("../../../../src/agents/providers/runtimeConfig");
const { resolveUpstreamRuntime } = require("../../../../src/agents/providers/upstreamRuntime");
const { listProviderModels } = require("../../../../src/agents/providers/modelsCatalog");
const { createAgentHost } = require("../../../../src/runtime/daemon/agentHost");
const { runNativeAgentTask } = require("../../../../src/code/nativeRunner");
const { materializeAnswerToolResult } = require("../../../../src/agents/runtime/protocol/materialize");
const { resolveAgyCredentials } = require("../../../../src/agents/providers/credentials/agy");

describe("Antigravity native provider", () => {
  let root;
  const model = "gemini-4-carbon-high";
  const baseUrl = "https://daily-cloudcode-pa.googleapis.com";
  const transport = getNativeTransport("antigravity");

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agy-"));
    fs.mkdirSync(path.join(root, ".ufoo"));
    fs.writeFileSync(path.join(root, ".ufoo/config.json"), JSON.stringify({ agentProvider: "agy-cli" }));
    const globalConfig = path.join(root, "global-config.json");
    fs.writeFileSync(globalConfig, JSON.stringify({ ucodeModel: "gpt-6.1-sol", ucodeAuxModel: "gpt-6-luna" }));
    jest.replaceProperty(process, "env", {
      ...process.env,
      UFOO_GLOBAL_CONFIG_PATH: globalConfig,
      UFOO_UCODE_MODEL: "",
      UFOO_UCODE_AUX_MODEL: "",
      UFOO_AGY_ACCESS_TOKEN: "test-access-token",
      UFOO_AGY_PROJECT_ID: "cloud-code-project",
      UFOO_AGY_AUTH_PATH: "",
      UFOO_AGY_BASE_URL: baseUrl,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function sse(...responses) {
    return new Response(responses.map((response) => `data: ${JSON.stringify({ response })}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }

  function turn(parts, finishReason, usageMetadata) {
    return { candidates: [{ content: { role: "model", parts }, finishReason }], usageMetadata };
  }

  test("main and native coding select the Antigravity wire protocol and model", async () => {
    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "antigravity", useCodingConfig: false })).toMatchObject({
      provider: "agy", transport: "antigravity", model, baseUrl, auxModel: "gemini-4-hydrogen-high",
    });
    await expect(resolveUpstreamRuntime({ projectRoot: root, provider: "agy-cli" })).resolves.toMatchObject({
      provider: "agy", transport: "antigravity", model, baseUrl,
    });
    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "agy" })).toMatchObject({
      model, auxModel: "gemini-4-hydrogen-high",
    });
    fs.writeFileSync(process.env.UFOO_GLOBAL_CONFIG_PATH, JSON.stringify({
      ucodeProvider: "antigravity", ucodeModel: "gemini-4-hydrogen-low", ucodeAuxModel: "gemini-3.8-flash-high",
    }));
    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "agy" })).toMatchObject({
      model: "gemini-4-hydrogen-low", auxModel: "gemini-3.8-flash-high",
    });
  });

  test("streams signed parallel tool calls and replays their matching results", async () => {
    const fetch = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(sse(
        turn([{ text: "Checking", thought: true, thoughtSignature: "thought-signature" }]),
        turn([{ functionCall: { name: "read", args: { path: "a" }, id: "upstream-a" }, thoughtSignature: "call-signature" },
          { functionCall: { name: "read", args: { path: "b" } } }], "STOP"),
      ))
      .mockResolvedValueOnce(sse(turn([{ text: "Done" }], "STOP", {
        promptTokenCount: 30, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 10,
      })));
    const messages = [];
    transport.prepareMessages({ messages, prompt: "Read two files." });
    const delta = jest.fn();
    const options = {
      url: transport.resolveUrl(baseUrl), model, sessionId: "session", messages,
      systemBlocks: [{ text: "Follow repository instructions." }],
      tools: [{ type: "function", function: { name: "read", description: "Read a file",
        parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } } }],
      onThinkingDelta: delta,
    };
    const first = await transport.runTurn(options);
    const pendingCalls = transport.prepareToolCalls({ messages, turnResult: first, toolCalls: transport.getToolCalls(first) });
    const collected = [];
    transport.appendToolResult({ collected, call: pendingCalls[0], toolResult: { ok: true, text: "hello" } });
    transport.flushToolResults({ messages, collected });
    expect(materializeAnswerToolResult(messages, { transport: transport.name, call: pendingCalls[1] }, { value: "yes" }).ok).toBe(true);
    // Deferred results may arrive in distinct journal messages in one batch.
    const second = await transport.runTurn({ ...options, messages: JSON.parse(JSON.stringify(messages)) });
    const [firstUrl, firstInit] = fetch.mock.calls[0];
    expect(firstUrl).toBe(`${baseUrl}/v1internal:streamGenerateContent?alt=sse`);
    expect(firstInit.headers.Authorization).toBe("Bearer test-access-token");
    const firstBody = JSON.parse(firstInit.body);
    expect(firstBody).toMatchObject({
      model, project: "cloud-code-project", requestType: "agent",
      request: {
        systemInstruction: { parts: [{ text: "Follow repository instructions." }] },
        tools: [{ functionDeclarations: [{ name: "read", parameters: { type: "object", required: ["path"] } }] }],
      },
    });
    const replay = JSON.parse(fetch.mock.calls[1][1].body).request;
    expect(replay.sessionId).toBe(firstBody.request.sessionId);
    expect(replay.contents[1]).toEqual({ role: "model", parts: [
      { text: "Checking", thought: true, thoughtSignature: "thought-signature" },
      { functionCall: { name: "read", args: { path: "a" }, id: "upstream-a" }, thoughtSignature: "call-signature" },
      { functionCall: { name: "read", args: { path: "b" } } },
    ] });
    expect(replay.contents.slice(2)).toEqual([{ role: "user", parts: [
      { functionResponse: { name: "read", id: "upstream-a", response: { output: '{"ok":true,"text":"hello"}' } } },
      { functionResponse: { name: "read", response: { output: '{"value":"yes"}' } } },
    ] }]);
    expect(delta).toHaveBeenCalledWith("Checking");
    expect(second).toMatchObject({ text: "Done", usage: { input: 30, output: 6, cacheRead: 10 } });
  });

  test("rejects a truncated stream before dispatching any tool call", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(sse(turn([{ functionCall: { name: "read", args: { path: "a" } } }])));
    await expect(transport.runTurn({
      url: transport.resolveUrl(baseUrl), model, messages: [{ role: "user", content: "Read one file." }],
    })).rejects.toThrow("before a finish reason");
  });

  test("reads the agy macOS login and discovers its project once per access token", async () => {
    const token = { access_token: "keychain-token", expiry: new Date(Date.now() + 3600000).toISOString() };
    const wrapped = `go-keyring-base64:${Buffer.from(JSON.stringify({ token })).toString("base64")}`;
    const runCommand = jest.fn().mockResolvedValue({ stdout: wrapped });
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({
      cloudaicompanionProject: { id: "local-agy-project" },
    })));
    const options = { baseUrl, homeDir: root, platform: "darwin", env: {}, runCommand, fetchImpl };
    await expect(resolveAgyCredentials(options)).resolves.toMatchObject({
      accessToken: "keychain-token", projectId: "local-agy-project", source: "agy macOS Keychain",
    });
    await resolveAgyCredentials(options);
    expect(runCommand).toHaveBeenCalledWith("/usr/bin/security",
      ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], expect.any(Object));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/v1internal:loadCodeAssist`, expect.objectContaining({
      method: "POST",
      body: '{"metadata":{"ideType":"ANTIGRAVITY"}}',
      headers: expect.objectContaining({ Authorization: "Bearer keychain-token" }),
    }));
    await expect(resolveAgyCredentials({ ...options, baseUrl: "https://custom.invalid" })).rejects.toThrow("explicit");
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  test("has agy renew its own expired token and rereads the file", async () => {
    const dir = path.join(root, ".gemini", "antigravity-cli");
    const file = path.join(dir, "antigravity-oauth-token");
    fs.mkdirSync(dir, { recursive: true });
    const writeToken = (accessToken, expiresInMs) => fs.writeFileSync(file, JSON.stringify({
      token: { access_token: accessToken, expiry: new Date(Date.now() + expiresInMs).toISOString() },
    }));
    writeToken("expired-agy-token", -60000);
    const runCommand = jest.fn(() => writeToken("renewed-agy-token", 3600000));
    await expect(resolveAgyCredentials({
      baseUrl, homeDir: root, platform: "win32", env: { UFOO_AGY_PROJECT_ID: "known-project" }, runCommand,
    })).resolves.toMatchObject({ accessToken: "renewed-agy-token", projectId: "known-project", source: "agy auth file" });
    expect(runCommand).toHaveBeenCalledWith("agy", ["models"],
      expect.objectContaining({ env: expect.objectContaining({ AGY_CLI_DISABLE_AUTO_UPDATE: "true" }) }));
  });

  test("runs through the main agent and standalone ucode entry points", async () => {
    const fetch = jest.spyOn(global, "fetch")
      .mockResolvedValueOnce(sse(turn([{ text: "Main response" }], "STOP")))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        response: turn([{ text: "Coding response" }], "STOP"),
      }), { headers: { "content-type": "application/json" } }));
    const host = createAgentHost({ projectRoot: root });
    try {
      const main = await host.runPrompt({ prompt: "Main prompt", requestId: "main-1" });
      expect(main).toMatchObject({ ok: true, payload: { reply: "Main response" } });
      const coding = await runNativeAgentTask({ workspaceRoot: root, provider: "agy", prompt: "Coding prompt" });
      expect(coding).toMatchObject({ ok: true, output: "Coding response" });
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([
        transport.resolveUrl(baseUrl),
        transport.resolveUrl(baseUrl),
      ]);
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body).model)).toEqual([model, model]);
    } finally {
      await host.close();
    }
  });

  test("discovers model IDs using the selected Antigravity auth file", async () => {
    const authPath = path.join(root, "antigravity.json");
    fs.writeFileSync(authPath, JSON.stringify({
      type: "antigravity", access_token: "file-access-token", project_id: "file-project",
      expired: new Date(Date.now() + 60000).toISOString(),
    }));
    const env = { UFOO_AGY_AUTH_PATH: authPath };
    const fetchImpl = jest.fn().mockResolvedValue(new Response(JSON.stringify({ models: {
      [model]: { displayName: "Gemini" },
      "claude-opus-4-6-thinking": { displayName: "Claude" },
    } })));
    const result = await listProviderModels({ baseUrl, provider: "agy", transport: "antigravity", env, fetchImpl });
    expect(result).toMatchObject({ ok: true, models: [model, "claude-opus-4-6-thinking"] });
    expect(fetchImpl).toHaveBeenCalledWith(`${baseUrl}/v1internal:fetchAvailableModels`, expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer file-access-token" }),
      body: '{"project":"file-project"}',
    }));
    fs.writeFileSync(authPath, JSON.stringify({
      type: "antigravity", access_token: "expired-token", project_id: "file-project",
      expired: new Date(Date.now() - 60000).toISOString(),
    }));
    await expect(listProviderModels({ baseUrl, provider: "agy", transport: "antigravity", env, fetchImpl }))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
