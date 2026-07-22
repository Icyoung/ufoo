"use strict";

const {
  resolveOpenAiModelsUrl,
  resolveAnthropicModelsUrl,
  listProviderModels,
  confirmModelSupported,
  clearModelsCache,
} = require("../../../src/code/providers/modelsCatalog");

describe("modelsCatalog", () => {
  beforeEach(() => {
    clearModelsCache();
  });

  test("resolves openai and anthropic models urls from gateway bases", () => {
    expect(resolveOpenAiModelsUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
    expect(resolveOpenAiModelsUrl("https://api.openai.com/v1/chat/completions"))
      .toBe("https://api.openai.com/v1/models");
    expect(resolveAnthropicModelsUrl("https://api.anthropic.com/v1"))
      .toBe("https://api.anthropic.com/v1/models");
    expect(resolveAnthropicModelsUrl("https://api.anthropic.com/v1/messages"))
      .toBe("https://api.anthropic.com/v1/models");
  });

  test("listProviderModels reads openai-compatible catalog", async () => {
    const fetchImpl = jest.fn(async (url, init) => {
      expect(url).toBe("https://api.example.test/v1/models");
      expect(init.headers.Authorization).toBe("Bearer sk-test");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] }),
      };
    });

    const listed = await listProviderModels({
      transport: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-test",
      fetchImpl,
      skipCache: true,
    });

    expect(listed.ok).toBe(true);
    expect(listed.models).toEqual(["alpha", "beta"]);
  });

  test("listProviderModels reads anthropic catalog headers", async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      expect(init.headers["x-api-key"]).toBe("sk-ant");
      expect(init.headers["anthropic-version"]).toBe("2023-06-01");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }),
      };
    });

    const listed = await listProviderModels({
      transport: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
      fetchImpl,
      skipCache: true,
    });

    expect(listed.ok).toBe(true);
    expect(listed.models).toEqual(["claude-sonnet-4-5"]);
  });

  test("confirmModelSupported rejects unknown ids when catalog is available", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ id: "alpha" }] }),
    }));

    const denied = await confirmModelSupported({
      transport: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-test",
      model: "missing",
      fetchImpl,
      skipCache: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.error).toContain("missing");

    const ok = await confirmModelSupported({
      transport: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-test",
      model: "alpha",
      fetchImpl,
      skipCache: true,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.ok).toBe(true);
  });

  test("confirmModelSupported soft-allows when models route is down", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await confirmModelSupported({
      transport: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      apiKey: "sk-test",
      model: "anything",
      fetchImpl,
      skipCache: true,
      strict: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.warning).toContain("could not confirm");
  });
});
