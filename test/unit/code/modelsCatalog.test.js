"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveCodexUserAgent, resolveGrokClientVersion } = require("../../../src/agents/providers/clientIdentity");
const {
  resolveCodexClientVersion,
  resolveOpenAiModelsUrl,
  resolveAnthropicModelsUrl,
  listProviderModels,
  confirmModelSupported,
  clearModelsCache,
} = require("../../../src/code/providers/modelsCatalog");

describe("modelsCatalog", () => {
  let codexHome;
  beforeEach(() => {
    clearModelsCache();
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-catalog-"));
  });
  afterEach(() => fs.rmSync(codexHome, { recursive: true, force: true }));

  test("uses local Codex version metadata with an explicit override and an SDK fallback", () => {
    const cacheFile = path.join(codexHome, "models_cache.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ client_version: "99.2.1" }));
    expect(resolveCodexClientVersion({ env: {}, codexHome })).toBe("99.2.1");
    expect(resolveCodexUserAgent({ env: {}, codexHome })).toContain("codex-tui/99.2.1 ");
    expect(resolveCodexUserAgent({ env: { UFOO_CODEX_USER_AGENT: "explicit-client/1.0" }, codexHome })).toBe("explicit-client/1.0");
    expect(resolveCodexClientVersion({ env: { UFOO_CODEX_CLIENT_VERSION: "0.159.2" }, codexHome })).toBe("0.159.2");
    fs.writeFileSync(cacheFile, "invalid cache");
    expect(resolveCodexClientVersion({ env: {}, codexHome })).toBe(require("../../../node_modules/@openai/codex-sdk/package.json").version);
  });

  test("a newer Codex client version bypasses the older cached server catalog", async () => {
    const cacheFile = path.join(codexHome, "models_cache.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ client_version: "99.0.0" }));
    const fetchImpl = jest.fn(async (url) => new Response(JSON.stringify({ models: [{ slug: url.includes("99.0.1") ? "new-model" : "old-model", visibility: "list" }] })));
    const options = { provider: "codex", baseUrl: "https://catalog.test/codex", codexHome, fetchImpl };
    expect((await listProviderModels(options)).models).toEqual(["old-model"]);
    fs.writeFileSync(cacheFile, JSON.stringify({ client_version: "99.0.1" }));
    expect((await listProviderModels(options)).models).toEqual(["new-model"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  test("reads every catalog page and reuses the provider's OAuth headers", async () => {
    const fetchImpl = jest.fn(async (url, request) => {
      expect(request.headers.authorization).toBe("Bearer isolated-oauth");
      return new Response(JSON.stringify(url.includes("after=") ? { data: [{ id: "last-model" }], has_more: false }
        : { data: [{ id: "first-model" }], has_more: true, last_id: "first-model" }));
    });
    const listed = await listProviderModels({ baseUrl: "https://catalog.test/v1/responses", requestHeaders: { authorization: "Bearer isolated-oauth" }, fetchImpl });
    expect(listed.models).toEqual(["first-model", "last-model"]);
    expect(fetchImpl.mock.calls[1][0]).toBe("https://catalog.test/v1/models?after=first-model");
  });

  test("Codex catalogs use model slugs and the direct backend version parameter", async () => {
    const fetchImpl = jest.fn(async (url, request) => {
      expect(url).toBe("https://catalog.test/backend-api/codex/models?client_version=0.159.2");
      expect(request.headers["User-Agent"]).toContain("codex-tui/0.159.2 ");
      return new Response(JSON.stringify({ models: [
        { slug: "codex-model-a", visibility: "list" },
        { slug: "codex-auto-review", visibility: "hide" },
        { slug: "codex-model-b", visibility: "list" },
      ] }));
    });
    expect((await listProviderModels({ provider: "codex", clientVersion: "0.159.2", transport: "codex-responses", baseUrl: "https://catalog.test/backend-api/codex", fetchImpl })).models)
      .toEqual(["codex-model-a", "codex-model-b"]);
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

  test("listProviderModels uses the Grok Shell catalog shape and client identity", async () => {
    const version = resolveGrokClientVersion();
    const fetchImpl = jest.fn(async (url, init) => {
      expect(url).toBe(`https://proxy.example.test/v1/models?client_version=${version}`);
      expect(init.headers.Authorization).toBe("Bearer sk-grok");
      expect(init.headers["User-Agent"]).toBe(`grok-shell/${version}`);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          object: "list",
          data: [{ id: "grok-4.6", model: "grok-4.6", api_backend: "responses" }],
        }),
      };
    });

    const listed = await listProviderModels({
      provider: "grok-build",
      transport: "openai-responses",
      baseUrl: "https://proxy.example.test/v1",
      apiKey: "sk-grok",
      fetchImpl,
      skipCache: true,
    });
    expect(listed.models).toEqual(["grok-4.6"]);
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
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "missing",
      fetchImpl,
      skipCache: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.error).toContain("missing");

    const ok = await confirmModelSupported({
      transport: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
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
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "anything",
      fetchImpl,
      skipCache: true,
      strict: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.warning).toContain("could not confirm");
  });

  test("a stale Claude gateway catalog cannot reject a supported manual model", async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-opus-4-5" }] })));
    const runtime = { provider: "claude-cli", transport: "anthropic-messages", baseUrl: "https://gateway.test/v1", fetchImpl };
    expect((await listProviderModels(runtime)).models).toEqual(["claude-opus-4-5"]);
    fetchImpl.mockClear();
    expect(await confirmModelSupported({ ...runtime, model: "claude-opus-5-5", strict: true }))
      .toMatchObject({ ok: true, allowed: true, model: "claude-opus-5-5", warning: "", error: "" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    ["openai", "openai-chat"], ["codex-cli", "codex-responses"],
    ["claude", "anthropic-messages"], ["kimi", "openai-chat"], ["grok-build", "openai-responses"],
  ])("custom URLs accept model aliases for %s without fetching a catalog", async (provider, transport) => {
    const fetchImpl = jest.fn();
    const result = await confirmModelSupported({ provider, transport, baseUrl: "http://localhost:8317/v1",
      model: "gateway-only-alias", fetchImpl });
    expect(result).toMatchObject({ ok: true, allowed: true, model: "gateway-only-alias" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("explicit custom configuration accepts manual IDs even at an official URL but still rejects empty IDs", async () => {
    const fetchImpl = jest.fn();
    const options = { provider: "openai", baseUrl: "https://api.openai.com/v1", allowUnlistedModels: true, fetchImpl };
    expect((await confirmModelSupported({ ...options, model: "manual-model" })).allowed).toBe(true);
    expect((await confirmModelSupported({ ...options, model: " " })).allowed).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
