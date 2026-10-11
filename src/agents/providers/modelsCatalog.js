"use strict";

/**
 * Live provider model catalog via the OpenAI-compatible / Anthropic models route.
 *
 * Shared by ucode /model and dashboard settings so model choices follow the
 * configured provider's catalog.
 */

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;
const { createHash } = require("crypto");
const { resolveCodexClientVersion, resolveCodexUserAgent, resolveGrokClientVersion } = require("./clientIdentity");
const { normalizeProvider } = require("./runtimeConfig");

const OFFICIAL_MODEL_ORIGINS = Object.freeze({
  openai: ["https://api.openai.com"],
  codex: ["https://chatgpt.com", "https://api.openai.com"],
  anthropic: ["https://api.anthropic.com"],
  kimi: ["https://api.kimi.com"],
  "grok-build": ["https://api.x.ai"],
  xai: ["https://api.x.ai"],
});

function usesCustomModelEndpoint({ provider = "", transport = "", baseUrl = "", allowUnlistedModels = false } = {}) {
  if (allowUnlistedModels || provider === "custom") return true;
  if (!String(baseUrl || "").trim()) return false;
  const normalizedProvider = normalizeProvider(provider)
    || (transport === "anthropic-messages" ? "anthropic" : "openai");
  try {
    const origin = new URL(baseUrl).origin;
    return !(OFFICIAL_MODEL_ORIGINS[normalizedProvider] || []).includes(origin);
  } catch {
    return false;
  }
}

/** @type {Map<string, { at: number, result: object }>} */
const modelsCache = new Map();

function clipText(value = "", maxChars = 400) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

function resolveOpenAiModelsUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\/+$/, "");
  if (/\/models$/i.test(normalized)) return normalized;
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized.replace(/\/chat\/completions$/i, "/models");
  }
  if (/\/responses$/i.test(normalized)) return normalized.replace(/\/responses$/i, "/models");
  if (/\/v1$/i.test(normalized)) return `${normalized}/models`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/models`;
  return `${normalized}/models`;
}

function resolveAnthropicModelsUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim() || DEFAULT_ANTHROPIC_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (/\/models$/i.test(normalized)) return normalized;
  if (/\/messages$/i.test(normalized)) {
    return normalized.replace(/\/messages$/i, "/models");
  }
  if (/\/v1$/i.test(normalized)) return `${normalized}/models`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/models`;
  return `${normalized}/models`;
}

function resolveModelsUrl({ transport = "", baseUrl = "", provider = "", clientVersion = "", codexHome = "" } = {}) {
  let url;
  if (String(transport || "") === "anthropic-messages") {
    url = resolveAnthropicModelsUrl(baseUrl);
  } else {
    url = resolveOpenAiModelsUrl(baseUrl);
  }
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "codex" && /\/codex(?:\/|$)/.test(url)) {
    const version = resolveCodexClientVersion({ codexHome, clientVersion });
    if (!version) return url;
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}client_version=${encodeURIComponent(version)}`;
  }
  if (normalizedProvider === "grok" || normalizedProvider === "grok-build" || normalizedProvider === "grok-shell") {
    const separator = url.includes("?") ? "&" : "?";
    const version = resolveGrokClientVersion();
    return `${url}${separator}client_version=${encodeURIComponent(version)}`;
  }
  return url;
}

function cacheKey({ transport = "", baseUrl = "", url = "", apiKey = "", provider = "", requestHeaders = {} } = {}) {
  const authHash = createHash("sha256").update(JSON.stringify([apiKey, requestHeaders])).digest("hex");
  return `${provider}|${transport}|${url || baseUrl}|${authHash}`;
}

function extractModelIds(payload, { visibleOnly = false } = {}) {
  const ids = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  if (!payload || typeof payload !== "object") return ids;

  if (Array.isArray(payload.data)) {
    for (const item of payload.data) {
      if (!item) continue;
      if (typeof item === "string") push(item);
      else if (!visibleOnly || !item.visibility || item.visibility === "list") push(item.id || item.slug || item.model || item.name);
    }
  }

  if (Array.isArray(payload.models)) {
    for (const item of payload.models) {
      if (!item) continue;
      if (typeof item === "string") push(item);
      else if (!visibleOnly || !item.visibility || item.visibility === "list") push(item.id || item.slug || item.model || item.name);
    }
  }

  return ids;
}

function buildListHeaders({ transport = "", apiKey = "", provider = "", clientVersion = "", codexHome = "" } = {}) {
  const headers = {
    Accept: "application/json",
  };
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "grok" || normalizedProvider === "grok-build" || normalizedProvider === "grok-shell") {
    const version = resolveGrokClientVersion();
    headers["User-Agent"] = `grok-shell/${version}`;
  }
  if (normalizedProvider === "codex") {
    headers["User-Agent"] = resolveCodexUserAgent({ clientVersion, codexHome });
    headers.Originator = "codex-tui";
  }
  const key = String(apiKey || "").trim();

  if (String(transport || "") === "anthropic-messages") {
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

/**
 * Fetch the provider's models catalog.
 * @returns {Promise<{
 *   ok: boolean,
 *   models: string[],
 *   url: string,
 *   error: string,
 *   status: number,
 *   cached: boolean,
 * }>}
 */
async function listProviderModels(options = {}) {
  const transport = String(options.transport || "openai-chat").trim() || "openai-chat";
  const baseUrl = String(options.baseUrl || "").trim();
  const apiKey = String(options.apiKey || "").trim();
  const provider = String(options.provider || "").trim();
  const requestHeaders = options.requestHeaders || {};
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const skipCache = options.skipCache === true;
  const url = resolveModelsUrl({ transport, baseUrl, provider, clientVersion: options.clientVersion, codexHome: options.codexHome });

  if (!url) {
    return {
      ok: false,
      models: [],
      url: "",
      error: "models url unavailable (configure the provider API URL)",
      status: 0,
      cached: false,
    };
  }

  const key = cacheKey({ transport, baseUrl, url, apiKey, provider, requestHeaders });
  if (!skipCache) {
    const hit = modelsCache.get(key);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) {
      return { ...hit.result, cached: true };
    }
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
      try { controller.abort(); } catch { /* ignore */ }
    }, timeoutMs)
    : null;
  if (timer && typeof timer.unref === "function") timer.unref();

  try {
    let nextUrl = url;
    const models = [];
    const seenPages = new Set();
    let status = 0;
    do {
      if (seenPages.has(nextUrl)) throw new Error("models route repeated a pagination cursor");
      seenPages.add(nextUrl);
      const response = await fetchImpl(nextUrl, {
        method: "GET",
        headers: { ...buildListHeaders({ transport, apiKey, provider, clientVersion: options.clientVersion, codexHome: options.codexHome }), ...requestHeaders },
        signal: controller ? controller.signal : undefined,
      });
      status = Number(response && response.status) || 0;
      const bodyText = await response.text().catch(() => "");
      let payload = null;
      try {
        payload = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const result = {
          ok: false,
          models: [],
          url,
          error: `models route failed (${status}): ${clipText(bodyText || response.statusText || "unknown")}`,
          status,
          cached: false,
        };
        return result;
      }

      for (const id of extractModelIds(payload, { visibleOnly: provider.toLowerCase() === "codex" })) {
        if (!models.includes(id)) models.push(id);
      }
      nextUrl = "";
      if (payload && payload.has_more) {
        const cursor = payload.last_id || payload.data?.at(-1)?.id;
        if (!cursor) throw new Error("models route omitted its pagination cursor");
        const pageUrl = new URL(url);
        pageUrl.searchParams.set(transport === "anthropic-messages" ? "after_id" : "after", cursor);
        nextUrl = pageUrl.toString();
      }
    } while (nextUrl);
    const result = {
      ok: true,
      models,
      url,
      error: models.length === 0 ? "models route returned an empty catalog" : "",
      status,
      cached: false,
    };
    // Cache successful responses even when empty — avoids hammering a broken gateway.
    modelsCache.set(key, { at: Date.now(), result: { ...result, cached: false } });
    return result;
  } catch (err) {
    const message = err && err.name === "AbortError"
      ? `models route timed out after ${timeoutMs}ms`
      : (err && err.message ? err.message : String(err || "models route failed"));
    return {
      ok: false,
      models: [],
      url,
      error: message,
      status: 0,
      cached: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modelSupported(model = "", models = []) {
  const needle = String(model || "").trim();
  if (!needle) return false;
  const list = Array.isArray(models) ? models : [];
  return list.some((id) => String(id || "").trim() === needle);
}

/**
 * Validate a model id against the live catalog.
 * Custom endpoints accept any nonempty id; their catalog is only a suggestion.
 * Soft mode: when the catalog cannot be fetched, allow with a warning.
 */
async function confirmModelSupported(options = {}) {
  const model = String(options.model || "").trim();
  if (!model) {
    return {
      ok: false,
      allowed: false,
      model: "",
      models: [],
      error: "model id is empty",
      warning: "",
      catalog: null,
    };
  }

  if (usesCustomModelEndpoint(options)) {
    return { ok: true, allowed: true, model, models: [], error: "", warning: "", catalog: null };
  }

  const catalog = await listProviderModels(options);
  if (!catalog.ok) {
    return {
      ok: false,
      allowed: options.strict === true ? false : true,
      model,
      models: [],
      error: catalog.error || "models route unavailable",
      warning: options.strict === true
        ? ""
        : `could not confirm model via models route (${catalog.error || "unavailable"}); accepting ${model}`,
      catalog,
    };
  }

  if (catalog.models.length === 0) {
    return {
      ok: false,
      allowed: options.strict === true ? false : true,
      model,
      models: [],
      error: catalog.error || "empty models catalog",
      warning: options.strict === true
        ? ""
        : `models route returned no models; accepting ${model}`,
      catalog,
    };
  }

  if (!modelSupported(model, catalog.models)) {
    const sample = catalog.models.slice(0, 8).join(", ");
    const more = catalog.models.length > 8 ? ` (+${catalog.models.length - 8} more)` : "";
    return {
      ok: false,
      allowed: false,
      model,
      models: catalog.models,
      error: `model "${model}" is not in the provider catalog${sample ? ` (available: ${sample}${more})` : ""}`,
      warning: "",
      catalog,
    };
  }

  return {
    ok: true,
    allowed: true,
    model,
    models: catalog.models,
    error: "",
    warning: "",
    catalog,
  };
}

function clearModelsCache() {
  modelsCache.clear();
}

module.exports = {
  resolveCodexClientVersion,
  resolveOpenAiModelsUrl,
  resolveAnthropicModelsUrl,
  resolveModelsUrl,
  listProviderModels,
  usesCustomModelEndpoint,
  confirmModelSupported,
  modelSupported,
  extractModelIds,
  clearModelsCache,
  CACHE_TTL_MS,
};
