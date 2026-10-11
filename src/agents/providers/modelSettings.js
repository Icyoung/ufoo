"use strict";

const { loadConfig } = require("../../config");
const { resolveUpstreamRuntime } = require("./upstreamRuntime");
const { listProviderModels, confirmModelSupported, usesCustomModelEndpoint } = require("./modelsCatalog");

async function resolveAgentModelCatalog(projectRoot, options = {}) {
  const config = options.config || loadConfig(projectRoot);
  if (config.agentProvider === "custom") {
    const { resolveTransport } = require("./runtimeConfig");
    return { provider: "openai", transport: resolveTransport({ provider: "openai", baseUrl: config.agentBaseUrl }),
      baseUrl: config.agentBaseUrl, apiKey: config.agentApiKey || "", allowUnlistedModels: true, fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs, skipCache: options.skipCache };
  }
  const runtime = await (options.resolveRuntime || resolveUpstreamRuntime)({
    projectRoot, provider: config.agentProvider, model: config.agentModel,
    loadConfigImpl: () => config,
  });
  return { provider: runtime.provider, transport: runtime.transport, baseUrl: runtime.baseUrl,
    apiKey: runtime.auth?.apiKey || "", requestHeaders: { ...runtime.auth?.headers,
      ...(runtime.provider === "codex" && runtime.credential?.accountId ? { "chatgpt-account-id": runtime.credential.accountId } : {}) },
    fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs, skipCache: options.skipCache };
}

async function listAgentModels(projectRoot, options = {}) {
  const runtime = await resolveAgentModelCatalog(projectRoot, options);
  return { ...await listProviderModels(runtime), allowUnlistedModels: usesCustomModelEndpoint(runtime) };
}

async function confirmAgentModel(projectRoot, model, options = {}) {
  return confirmModelSupported({ ...await resolveAgentModelCatalog(projectRoot, options), model });
}

module.exports = { listAgentModels, confirmAgentModel, resolveAgentModelCatalog };
