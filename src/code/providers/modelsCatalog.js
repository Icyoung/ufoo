"use strict";

/**
 * Live provider model catalog via the OpenAI-compatible / Anthropic models route.
 *
 * Used by /model suggestions and settings validation so ucode only offers
 * (and preferably accepts) models the configured endpoint actually lists.
 */

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 60_000;

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

function resolveModelsUrl({ transport = "", baseUrl = "" } = {}) {
  if (String(transport || "") === "anthropic-messages") {
    return resolveAnthropicModelsUrl(baseUrl);
  }
  return resolveOpenAiModelsUrl(baseUrl);
}

function cacheKey({ transport = "", baseUrl = "", apiKey = "", provider = "" } = {}) {
  const keyTail = apiKey ? String(apiKey).slice(-8) : "";
  return `${provider}|${transport}|${baseUrl}|${keyTail}`;
}

function extractModelIds(payload) {
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
      else push(item.id || item.model || item.name);
    }
  }

  if (Array.isArray(payload.models)) {
    for (const item of payload.models) {
      if (!item) continue;
      if (typeof item === "string") push(item);
      else push(item.id || item.model || item.name);
    }
  }

  return ids;
}

function buildListHeaders({ transport = "", apiKey = "" } = {}) {
  const headers = {
    Accept: "application/json",
  };
  const key = String(apiKey || "").trim();
  if (!key) return headers;

  if (String(transport || "") === "anthropic-messages") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
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
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const skipCache = options.skipCache === true;
  const url = resolveModelsUrl({ transport, baseUrl });

  if (!url) {
    return {
      ok: false,
      models: [],
      url: "",
      error: "models url unavailable (set ucode base url)",
      status: 0,
      cached: false,
    };
  }

  const key = cacheKey({ transport, baseUrl, apiKey, provider });
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
    const response = await fetchImpl(url, {
      method: "GET",
      headers: buildListHeaders({ transport, apiKey }),
      signal: controller ? controller.signal : undefined,
    });
    const status = Number(response && response.status) || 0;
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

    const models = extractModelIds(payload);
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
  resolveOpenAiModelsUrl,
  resolveAnthropicModelsUrl,
  resolveModelsUrl,
  listProviderModels,
  confirmModelSupported,
  modelSupported,
  extractModelIds,
  clearModelsCache,
  CACHE_TTL_MS,
};
