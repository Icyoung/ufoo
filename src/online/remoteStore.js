"use strict";

/**
 * Persistent remote device identity, configuration, and paired client store.
 *
 * Stored under ~/.ufoo/remote/ (or UFOO_REMOTE_DIR / explicit remoteDir)
 * with 0o700 directory mode and 0o600 file permissions.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  generateEcdhKeyPair,
  randomHex,
  sanitizePublicKeyJwk,
  computeKeyFingerprint,
} = require("./remoteCrypto");

const DEFAULT_RELAY_URL = "wss://online.ufoo.dev/ufoo/online";

function defaultRemoteDir() {
  if (process.env.UFOO_REMOTE_DIR && process.env.UFOO_REMOTE_DIR.trim()) {
    return path.resolve(process.env.UFOO_REMOTE_DIR.trim());
  }
  return path.join(os.homedir(), ".ufoo", "remote");
}

function ensureRemoteDir(remoteDir = defaultRemoteDir()) {
  fs.mkdirSync(remoteDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(remoteDir, 0o700);
  } catch {
    // ignore on platforms without POSIX chmod
  }
  return remoteDir;
}

function writePrivateJson(filePath, data) {
  ensureRemoteDir(path.dirname(filePath));
  const payload = JSON.stringify(data, null, 2) + "\n";
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tmpPath, payload, { mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // ignore
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function identityPath(remoteDir = defaultRemoteDir()) {
  return path.join(remoteDir, "identity.json");
}

function configPath(remoteDir = defaultRemoteDir()) {
  return path.join(remoteDir, "config.json");
}

function pairedClientsPath(remoteDir = defaultRemoteDir()) {
  return path.join(remoteDir, "paired_clients.json");
}

async function loadOrCreateDeviceIdentity(remoteDir = defaultRemoteDir(), options = {}) {
  const file = identityPath(remoteDir);
  const existing = readJsonSafe(file, null);
  if (
    existing
    && typeof existing.device_id === "string"
    && existing.device_id
    && existing.public_key_jwk
    && existing.private_key_jwk
  ) {
    if (!existing.fingerprint) {
      existing.fingerprint = await computeKeyFingerprint(existing.public_key_jwk);
      writePrivateJson(file, existing);
    }
    return existing;
  }

  const kp = await generateEcdhKeyPair();
  const deviceName = String(options.deviceName || os.hostname() || "ufoo-host").trim();
  const record = {
    version: 1,
    device_id: `dev_${randomHex(12)}`,
    device_name: deviceName,
    created_at: new Date().toISOString(),
    public_key_jwk: kp.publicKeyJwk,
    private_key_jwk: kp.privateKeyJwk,
    fingerprint: kp.fingerprint,
  };
  writePrivateJson(file, record);
  return record;
}

function loadDeviceIdentitySync(remoteDir = defaultRemoteDir()) {
  return readJsonSafe(identityPath(remoteDir), null);
}

function loadRemoteConfig(remoteDir = defaultRemoteDir()) {
  const raw = readJsonSafe(configPath(remoteDir), {});
  return {
    enabled: Boolean(raw.enabled),
    relay_url: typeof raw.relay_url === "string" && raw.relay_url.trim()
      ? raw.relay_url.trim()
      : DEFAULT_RELAY_URL,
    web_base_url: typeof raw.web_base_url === "string" ? raw.web_base_url.trim() : "",
    auth_token: typeof raw.auth_token === "string" ? raw.auth_token.trim() : "",
    allow_insecure_ws: Boolean(raw.allow_insecure_ws),
  };
}

function saveRemoteConfig(remoteDir = defaultRemoteDir(), patch = {}) {
  const prev = loadRemoteConfig(remoteDir);
  const next = {
    ...prev,
    ...(patch.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
    ...(patch.relay_url !== undefined ? { relay_url: String(patch.relay_url || DEFAULT_RELAY_URL).trim() } : {}),
    ...(patch.web_base_url !== undefined ? { web_base_url: String(patch.web_base_url || "").trim() } : {}),
    ...(patch.auth_token !== undefined ? { auth_token: String(patch.auth_token || "").trim() } : {}),
    ...(patch.allow_insecure_ws !== undefined ? { allow_insecure_ws: Boolean(patch.allow_insecure_ws) } : {}),
    updated_at: new Date().toISOString(),
  };
  writePrivateJson(configPath(remoteDir), next);
  return next;
}

function loadPairedClientsMap(remoteDir = defaultRemoteDir()) {
  const raw = readJsonSafe(pairedClientsPath(remoteDir), { version: 1, clients: {} });
  if (!raw || typeof raw !== "object" || !raw.clients || typeof raw.clients !== "object") {
    return {};
  }
  return raw.clients;
}

function savePairedClientsMap(remoteDir = defaultRemoteDir(), clients = {}) {
  writePrivateJson(pairedClientsPath(remoteDir), {
    version: 1,
    clients,
  });
}

async function upsertPairedClient(remoteDir = defaultRemoteDir(), record = {}) {
  const clientId = String(record.client_id || "").trim();
  if (!clientId) throw new Error("client_id is required");
  const publicKeyJwk = sanitizePublicKeyJwk(record.public_key_jwk || record.public_key);
  const fingerprint = record.fingerprint || await computeKeyFingerprint(publicKeyJwk);
  const clients = loadPairedClientsMap(remoteDir);
  const prev = clients[clientId] || {};
  const now = new Date().toISOString();
  const next = {
    client_id: clientId,
    label: String(record.label || prev.label || "Remote Client").trim().slice(0, 64),
    public_key_jwk: publicKeyJwk,
    fingerprint,
    token_hash: String(record.token_hash || prev.token_hash || "").trim(),
    paired_at: prev.paired_at || record.paired_at || now,
    last_seen: record.last_seen || now,
    revoked_at: null,
  };
  clients[clientId] = next;
  savePairedClientsMap(remoteDir, clients);
  return next;
}

function getPairedClient(remoteDir = defaultRemoteDir(), clientId) {
  if (!clientId) return null;
  const clients = loadPairedClientsMap(remoteDir);
  return clients[String(clientId)] || null;
}

function touchPairedClient(remoteDir = defaultRemoteDir(), clientId) {
  const id = String(clientId || "").trim();
  if (!id) return null;
  const clients = loadPairedClientsMap(remoteDir);
  if (!clients[id] || clients[id].revoked_at) return null;
  clients[id].last_seen = new Date().toISOString();
  savePairedClientsMap(remoteDir, clients);
  return clients[id];
}

function revokePairedClient(remoteDir = defaultRemoteDir(), clientId) {
  const id = String(clientId || "").trim();
  if (!id) return { ok: false, error: "client_id is required" };
  const clients = loadPairedClientsMap(remoteDir);
  if (!clients[id]) {
    return { ok: false, error: `Paired client not found: ${id}` };
  }
  clients[id] = {
    ...clients[id],
    revoked_at: new Date().toISOString(),
  };
  savePairedClientsMap(remoteDir, clients);
  return { ok: true, client: clients[id] };
}

function listPairedClients(remoteDir = defaultRemoteDir(), { includeRevoked = false } = {}) {
  const clients = loadPairedClientsMap(remoteDir);
  return Object.values(clients)
    .filter((item) => includeRevoked || !item.revoked_at)
    .sort((a, b) => String(b.paired_at || "").localeCompare(String(a.paired_at || "")));
}

function listActiveRelayPairDescriptors(remoteDir = defaultRemoteDir()) {
  return listPairedClients(remoteDir, { includeRevoked: false })
    .filter((item) => Boolean(item.token_hash))
    .map((item) => ({
      client_id: item.client_id,
      label: item.label,
      token_hash: item.token_hash,
      client_public_key: item.public_key_jwk,
      paired_at: item.paired_at,
    }));
}

module.exports = {
  DEFAULT_RELAY_URL,
  defaultRemoteDir,
  ensureRemoteDir,
  identityPath,
  configPath,
  pairedClientsPath,
  loadOrCreateDeviceIdentity,
  loadDeviceIdentitySync,
  loadRemoteConfig,
  saveRemoteConfig,
  upsertPairedClient,
  getPairedClient,
  touchPairedClient,
  revokePairedClient,
  listPairedClients,
  listActiveRelayPairDescriptors,
};
