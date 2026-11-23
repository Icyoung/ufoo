"use strict";

jest.mock("undici", () => ({
  ...jest.requireActual("undici"),
  fetch: (...args) => global.fetch(...args),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runNativeAgentTask } = require("../../../src/code/nativeRunner");
const { createAgentHost } = require("../../../src/runtime/daemon/agentHost");
const { readAgentPerformance } = require("../../../src/coordination/history/agentTrace");
const { getNativeTransport } = require("../../../src/agents/providers/nativeTransport");

const model = "gpt-6.2-sol";
const auxModel = "gpt-6-luna";
const sessionId = "prompt-cache";

test("cache observations detect Claude effort and serialized tool schema reordering", () => {
  const { observeWireRequest } = require("../../../src/agents/providers/transports/requestCacheObservation");
  const observe = (effort, properties) => observeWireRequest({
    payload: { model: "claude-opus-5-5", output_config: { effort }, tools: [{ input_schema: { properties } }] },
    sessionId: "wire-order", transport: "anthropic-messages", credentials: "", startedAt: 0,
  });
  observe("low", { first: {}, second: {} });
  expect(observe("high", { first: {}, second: {} }).earliestChange.section).toBe("settings");
  expect(observe("high", { second: {}, first: {} }).earliestChange.section).toBe("tools");
});

function responsesResult(request, text, id = `resp-${request.model}`) {
  return new Response(JSON.stringify({
    id, object: "response", status: "completed", model: request.model,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 1000, output_tokens: 30, input_tokens_details: { cached_tokens: 100,
      cache_write_tokens: 300, cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 200 } } },
  }), { headers: { "content-type": "application/json" } });
}

describe("prompt caching across both native entry points", () => {
  let root;
  let host;
  let oldEnv;
  let oldFetch;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cache-requests-"));
    oldEnv = process.env;
    oldFetch = global.fetch;
    process.env = { ...oldEnv, UFOO_GLOBAL_CONFIG_PATH: path.join(root, "global.json") };
    for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "UFOO_CODEX_BASE_URL", "UFOO_UCODE_BASE_URL", "UFOO_UCODE_API_KEY"]) delete process.env[name];
    const authPath = path.join(root, "auth.json");
    fs.mkdirSync(path.join(root, ".ufoo"));
    fs.writeFileSync(path.join(root, ".ufoo", "config.json"), JSON.stringify({ codexAuthPath: authPath, agentProvider: "codex-cli", agentModel: model }));
    fs.writeFileSync(authPath, JSON.stringify({ tokens: { access_token: "test-oauth-token", account_id: "test-account" },
      expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  });
  afterEach(async () => {
    if (host) await host.close();
    host = null;
    global.fetch = oldFetch;
    process.env = oldEnv;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function entryPoint(entry, contextPolicy) {
    if (entry === "main") {
      host = createAgentHost({ projectRoot: root, provider: "codex", model, contextPolicy });
      return async (prompt, requestId) => (await host.runPrompt({ prompt, requestId, sessionId })).payload.runtime.taskRunId;
    }
    let messages = [];
    return async (prompt, logicalTurnId) => {
      const result = await runNativeAgentTask({ workspaceRoot: root, provider: "codex", model, prompt, sessionId,
        logicalTurnId, contextPolicy, messages });
      expect(result.ok).toBe(true);
      messages = result.messages;
      return logicalTurnId;
    };
  }

  test.each([[{}, 1_050_000], [{ contextWindowTokens: 48000 }, 48000]])("reports the effective window in live and final ucode meters with %j", async (contextPolicy, expected) => {
    process.env.OPENAI_API_KEY = "test-api-key";
    global.fetch = jest.fn(async (_url, { body }) => responsesResult(JSON.parse(body), "done"));
    const onContextUsage = jest.fn();
    const result = await runNativeAgentTask({ workspaceRoot: root, provider: "codex", model, prompt: "continue", sessionId,
      contextPolicy, onContextUsage });
    expect(result.ok).toBe(true);
    expect(result.contextMeter.limitTokens).toBe(expected);
    expect(onContextUsage).toHaveBeenCalledWith(expect.objectContaining({ limitTokens: expected }));
  });

  describe.each(["main", "ucode"])("%s", entry => {
    test.each([
      ["API key", "https://api.openai.com/v1/responses", "openai-responses"],
      ["subscription", "https://chatgpt.com/backend-api/codex/responses", "codex-subscription"],
      ["proxy override", "https://proxy.example/backend-api/codex/responses", "responses-compatible"],
    ])("routes the foreground and enrichment through %s", async (credential, url, channel) => {
      if (credential === "API key") process.env.OPENAI_API_KEY = "test-api-key";
      if (credential === "proxy override") process.env.UFOO_CODEX_BASE_URL = "https://proxy.example/backend-api/codex";
      global.fetch = jest.fn(async (_url, { body }) => {
        const payload = JSON.parse(body);
        return responsesResult(payload, payload.model === auxModel ? '{"topic":"summary"}' : "done");
      });
      const run = entryPoint(entry, { auxModel, awaitEnrich: true });
      const taskRunId = await run("Complete the caching task.", "cache-request");
      expect(global.fetch).toHaveBeenCalledTimes(2);
      for (const [sentUrl, options] of global.fetch.mock.calls) {
        expect(sentUrl).toBe(url);
        const body = JSON.parse(options.body);
        const headers = new Headers(options.headers);
        expect(body.model).toMatch(/^gpt-6/);
        expect(body.prompt_cache_options).toBeUndefined();
        if (channel === "codex-subscription") {
          expect(body.max_output_tokens).toBeUndefined();
          expect(headers.get("session-id")).toContain(sessionId);
          expect(headers.get("chatgpt-account-id")).toBe("test-account");
        } else {
          expect(body.max_output_tokens).toBeGreaterThan(0);
          expect(headers.get("session-id")).toBeNull();
          expect(headers.get("chatgpt-account-id")).toBeNull();
        }
      }
      const { modelRequests, modelCost } = readAgentPerformance(root, { task_id: taskRunId }).runs[0];
      expect(modelRequests.map(request => [request.purpose, request.model, request.channel])).toEqual([
        ["foreground", model, channel], ["turn_enrich", auxModel, channel],
      ]);
      expect(modelCost.pricedRequests).toBe(channel === "openai-responses" ? 2 : 0);
    });

    test("attributes retrieval and a late enrichment to their originating foreground task", async () => {
      process.env.OPENAI_API_KEY = "test-api-key";
      let blockEnrichment = false;
      let unblockEnrichment;
      const enrichmentGate = new Promise(resolve => { unblockEnrichment = resolve; });
      global.fetch = jest.fn(async (_url, { body }) => {
        const payload = JSON.parse(body);
        if (payload.instructions.startsWith("Select relevant")) return responsesResult(payload, '{"isNewTopic":true}', "resp-topic");
        if (payload.model === auxModel) {
          if (blockEnrichment) await enrichmentGate;
          return responsesResult(payload, '{"topic":"summary"}', "resp-enrichment");
        }
        return responsesResult(payload, "done", "resp-foreground");
      });
      const run = entryPoint(entry, { auxModel, rawTurnCount: 2, hardMaxTurns: 3, enableModelSelector: true, backgroundEnrich: true });
      for (let index = 0; index < 8; index++) await run(`Please inspect the current module step ${index}.`, `primer-${index}`);
      blockEnrichment = true;
      const taskRunId = await run("Where did things stand on this question?", "cost-task");
      const metrics = () => readAgentPerformance(root, { task_id: taskRunId }).runs[0];
      const pending = metrics();
      expect(pending.status).toBe("completed");
      expect(pending.modelRequests.map(request => [request.purpose, request.status])).toEqual([
        ["topic_select", "completed"], ["foreground", "completed"], ["turn_enrich", "started"],
      ]);
      expect(pending.modelCost.inputCostUsd).toBeNull();
      expect(pending.timings.firstTextMs).not.toBeNull();
      unblockEnrichment();
      await new Promise(resolve => setImmediate(resolve));
      const settled = metrics();
      expect(settled.modelRequests.map(request => request.providerRequestId)).toEqual(["resp-topic", "resp-foreground", "resp-enrichment"]);
      expect(new Set(settled.modelRequests.map(request => request.modelRequestId)).size).toBe(3);
      expect(settled.modelCost).toMatchObject({ requests: 3, pricedRequests: 3, cacheRead: 300, cacheCreation: 900 });
      expect(settled.modelCost.inputCostUsd).toBeCloseTo(0.002707, 8);
      expect(settled.timings.firstTextMs).toBe(pending.timings.firstTextMs);
      expect(settled.modelRequests[1].cache).toMatchObject({ channel: "openai-responses", strategyVersion: 1,
        startIntervalMs: expect.any(Number), prefixDigest: expect.stringMatching(/^[a-f0-9]{64}$/), commonPrefixEstimatedTokens: expect.any(Number) });
      expect(settled.modelRequests[1].cache.earliestChange).toMatchObject({ section: expect.any(String), index: expect.any(Number) });
    });
  });

  test("selects at most four Claude wire breakpoints and records both usage TTLs", async () => {
    let captured;
    global.fetch = jest.fn(async (_url, { body }) => {
      captured = JSON.parse(body);
      return new Response(JSON.stringify({ id: "msg-claude", model: "claude-opus-5-5", content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 200, output_tokens: 11, cache_read_input_tokens: 400, cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } },
      }), { headers: { "content-type": "application/json" } });
    });
    const ephemeral = { type: "ephemeral" };
    const historical = { role: "assistant", content: [{ type: "text", text: "historical text", cache_control: ephemeral },
      { type: "thinking", thinking: "private thought", signature: "sig", cache_control: ephemeral }] };
    Object.defineProperty(historical, Symbol.for("ufoo.stableHistoryBoundary"), { value: true });
    const messages = [historical, { role: "user", content: [{ type: "tool_result", tool_use_id: "old-call", content: "result" },
      { type: "text", text: "", cache_control: ephemeral }] }];
    const result = await getNativeTransport("anthropic-messages").runTurn({ url: "https://api.anthropic.com/v1/messages", apiKey: "test-key",
      systemBlocks: ["permanent", "project", "epoch"].map(text => ({ text, cacheable: true })), messages, model: "claude-opus-5-5",
      tools: [{ cache_control: ephemeral, function: { name: "read", description: "Read", parameters: { type: "object" } } }],
    });
    const marked = [...captured.tools, ...captured.system, ...captured.messages.flatMap(message => message.content)].filter(block => block.cache_control);
    expect(marked.map(block => block.text || block.type)).toEqual(["project", "epoch", "historical text", "tool_result"]);
    expect(historical.content[1].cache_control).toBe(ephemeral);
    expect(result.usage).toMatchObject({ input: 200, output: 11, cacheRead: 400, cacheCreation: 300,
      inputIncludesCache: false, cacheWriteByTtl: { "5m": 100, "1h": 200 } });
  });

  test("Responses retains ordered encrypted items and pairs the answer after ask_user and restart", async () => {
    process.env.OPENAI_API_KEY = "test-api-key";
    const captures = {};
    const createHost = () => createAgentHost({ projectRoot: root, provider: "codex", model,
      contextPolicy: { cacheStrategy: "stable-prefix", backgroundEnrich: false, enableModelSelector: false } });
    const read = { type: "function_call", call_id: "read-one", name: "read", arguments: '{"path":"report.txt"}' };
    const ask = { type: "function_call", call_id: "ask-one", name: "ask_user", arguments: '{"kind":"choice","prompt":"Which file?","options":["a","b"]}' };
    fs.writeFileSync(path.join(root, "report.txt"), "review report");
    for (const restart of [false, true]) {
      const comparisonSession = restart ? "reopened" : "continuous";
      let callNumber = 0;
      global.fetch = jest.fn(async (_url, { body }) => {
        const request = JSON.parse(body);
        const current = callNumber++;
        if (current === 2) {
          captures[comparisonSession] = request;
          return responsesResult(request, "done");
        }
        const output = [
          { type: "reasoning", id: `rs-${current}`, encrypted_content: `cipher-${current}`, summary: [] },
          { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: `Progress ${current}` }] },
          current === 0 ? read : ask,
        ];
        return new Response(JSON.stringify({ object: "response", status: "completed", model, output }), { headers: { "content-type": "application/json" } });
      });
      host = createHost();
      const run = await host.runPrompt({ prompt: "Review the report and ask before choosing.", requestId: "question", sessionId: comparisonSession });
      expect(run.payload.runtime.status).toBe("waiting_user");
      const interactionId = run.payload.runtime.interaction.id;
      if (restart) { await host.close(); host = createHost(); await host.recover(); }
      const runtime = host.findRuntime({ interactionId });
      const accepted = await runtime.resume({ interactionId, answer: "1" });
      expect((await runtime.wait(accepted.taskRunId)).status).toBe("completed");
      expect(runtime.events().filter(event => event.type === "tool.started" && event.toolName === "read")).toHaveLength(1);
      await host.close();
      host = null;
    }
    const normalize = body => body.input.filter(item => item.type === "reasoning" || item.type?.startsWith("function_call") || item.phase)
      .map(item => {
        if (item.type !== "function_call_output") return item;
        const { interactionId, artifactId, ...output } = JSON.parse(item.output);
        return { ...item, output };
      });
    expect(normalize(captures.reopened)).toEqual(normalize(captures.continuous));
    expect(captures.reopened.input[0].role).toBe("developer");
    expect(captures.reopened.input.filter(item => item.type === "reasoning").map(item => item.encrypted_content)).toEqual(["cipher-0", "cipher-1"]);
    expect(captures.reopened.input.filter(item => item.type === "function_call_output").map(item => item.call_id)).toEqual(["read-one", "ask-one"]);
  });
});
