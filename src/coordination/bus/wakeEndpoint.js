"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../state/paths");
const { withFileLock } = require("../state/fileLock");

const WAKE_ADAPTERS = Object.freeze({
  "bearer-json": Object.freeze({
    acceptedStatuses: Object.freeze([200]),
  }),
});

function isWakeMeta(meta) {
  return Boolean(
    meta
    && meta.status !== "inactive"
    && meta.launch_mode === "wake"
    && typeof meta.wake_adapter === "string"
    && WAKE_ADAPTERS[meta.wake_adapter]
  );
}

function assertHttpsWakeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("wake URL must be an http(s) URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("wake URL must not include credentials");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && loopback) return parsed.toString();
  throw new Error("wake URL must use https");
}

function normalizeAdapter(adapter) {
  const name = String(adapter || "bearer-json").trim();
  if (!WAKE_ADAPTERS[name]) {
    throw new Error(`Unknown wake adapter "${name}"`);
  }
  return name;
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, data, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode });
  fs.renameSync(tmp, filePath);
  fs.chmodSync(filePath, mode);
}

function endpointStore(projectRoot) {
  const filePath = getUfooPaths(projectRoot).wakeEndpointsFile;
  const parsed = readJsonFile(filePath) || { version: 1, endpoints: {} };
  if (!parsed.endpoints || typeof parsed.endpoints !== "object") parsed.endpoints = {};
  parsed.version = 1;
  return { filePath, data: parsed };
}

function receiptStore(projectRoot) {
  const filePath = getUfooPaths(projectRoot).wakeReceiptsFile;
  const parsed = readJsonFile(filePath) || { version: 1, accepted: {} };
  if (!parsed.accepted || typeof parsed.accepted !== "object") parsed.accepted = {};
  parsed.version = 1;
  return { filePath, data: parsed };
}

function writeWakeEndpoint(projectRoot, subscriber, endpoint = {}) {
  const adapter = normalizeAdapter(endpoint.adapter);
  const url = assertHttpsWakeUrl(endpoint.url);
  const key = String(endpoint.key || "");
  if (!key.trim()) throw new Error("wake key is empty");
  if (key.length > 4096) throw new Error("wake key is too long");
  if (/[\r\n]/.test(key)) throw new Error("wake key must be a single line");
  return withFileLock(getUfooPaths(projectRoot).wakeEndpointsFile, () => {
    const store = endpointStore(projectRoot);
    store.data.endpoints[subscriber] = { adapter, url, key };
    writeJsonFile(store.filePath, store.data, 0o600);
    return { adapter, url };
  });
}

function readWakeEndpoint(projectRoot, subscriber) {
  const record = endpointStore(projectRoot).data.endpoints[subscriber];
  if (!record || typeof record !== "object") return null;
  if (!WAKE_ADAPTERS[record.adapter] || typeof record.url !== "string" || typeof record.key !== "string") {
    return null;
  }
  return { adapter: record.adapter, url: record.url, key: record.key };
}

function removeWakeEndpoint(projectRoot, subscriber) {
  return withFileLock(getUfooPaths(projectRoot).wakeEndpointsFile, () => {
    const store = endpointStore(projectRoot);
    if (!store.data.endpoints[subscriber]) return false;
    delete store.data.endpoints[subscriber];
    writeJsonFile(store.filePath, store.data, 0o600);
    withFileLock(getUfooPaths(projectRoot).wakeReceiptsFile, () => {
      const receipts = receiptStore(projectRoot);
      if (receipts.data.accepted[subscriber]) {
        delete receipts.data.accepted[subscriber];
        writeJsonFile(receipts.filePath, receipts.data, 0o600);
      }
    });
    return true;
  });
}

function hasWakeAccepted(projectRoot, subscriber, seq) {
  const accepted = receiptStore(projectRoot).data.accepted[subscriber] || {};
  return Boolean(accepted[String(seq)]);
}

function markWakeAccepted(projectRoot, subscriber, seq) {
  return withFileLock(getUfooPaths(projectRoot).wakeReceiptsFile, () => {
    const store = receiptStore(projectRoot);
    if (!store.data.accepted[subscriber]) store.data.accepted[subscriber] = {};
    store.data.accepted[subscriber][String(seq)] = new Date().toISOString();
    writeJsonFile(store.filePath, store.data, 0o600);
  });
}

function readWakeKeyFile(filePath) {
  const resolved = String(filePath || "").trim();
  if (!resolved) throw new Error("wake key file is required");
  let key = "";
  try {
    key = fs.readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`cannot read wake key file: ${error.message}`);
  }
  key = key.replace(/\r?\n$/, "");
  if (!key.trim()) throw new Error("wake key file is empty");
  return key;
}

async function wakeBearerJson({ url, key, payload, fetchImpl, signal }) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
    signal,
    redirect: "error",
  });
  try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch { /* response body is optional */ }
  return {
    accepted: response.status === 200,
    status: response.status,
  };
}

async function wakeSubscriber(endpoint, payload, fetchImpl = global.fetch, { timeoutMs = 10000 } = {}) {
  if (!endpoint) throw new Error("wake endpoint is missing");
  if (typeof fetchImpl !== "function") throw new Error("wake fetch is unavailable");
  if (endpoint.adapter === "bearer-json") {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("wake request timed out"), { code: "WAKE_TIMEOUT" }));
      }, timeoutMs);
    });
    try { return await Promise.race([wakeBearerJson({ ...endpoint, payload, fetchImpl, signal: controller.signal }), timeout]); }
    finally { clearTimeout(timer); }
  }
  throw new Error(`Unknown wake adapter "${endpoint.adapter}"`);
}

module.exports = {
  WAKE_ADAPTERS,
  isWakeMeta,
  assertHttpsWakeUrl,
  writeWakeEndpoint,
  readWakeEndpoint,
  removeWakeEndpoint,
  hasWakeAccepted,
  markWakeAccepted,
  readWakeKeyFile,
  wakeSubscriber,
};
