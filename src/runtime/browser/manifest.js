"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RUNTIME_COMPONENT_NAME = "@playwright/mcp";
const RUNTIME_COMPONENT_VERSION = "0.0.85";
const PROTOCOL_VERSION = 1;
const CDP_RELAY_PROTOCOL_VERSION = 2;
const COMPATIBLE_EXTENSION_MIN_VERSION = "0.1.0";
const COMPATIBLE_EXTENSION_MAX_MAJOR = 1;

const NATIVE_HOST_NAME = "com.ufoo.browser";
const DEV_NATIVE_HOST_NAME = "com.ufoo.browser.dev";

// Deterministic key and extension ID for unpacked developer loading of extensions/ufoo-browser.
const DEV_EXTENSION_ID = "hepkcmckfedpfpijhdpbfccnddjpdceh";
const SUPPORTED_PLATFORMS = new Set(["darwin"]);

/**
 * Compute Chrome's deterministic 32-char a-p extension ID from an SPKI DER base64 public key.
 */
function computeExtensionIdFromPublicKey(base64Key = "") {
  const raw = String(base64Key || "").trim();
  if (!raw) return "";
  const der = Buffer.from(raw, "base64");
  const digest = crypto.createHash("sha256").update(der).digest();
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = digest[i];
    id += String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

function getRepoExtensionDir() {
  return path.resolve(__dirname, "..", "..", "..", "extensions", "ufoo-browser");
}

function getReleaseManifest(env = process.env) {
  const releaseExtensionId = String(env.UFOO_BROWSER_STORE_EXTENSION_ID || "").trim();
  const storeUrl = String(env.UFOO_BROWSER_STORE_URL || "").trim()
    || (releaseExtensionId ? `https://chromewebstore.google.com/detail/ufoo-browser/${releaseExtensionId}` : "");
  const componentTarballUrl = String(env.UFOO_BROWSER_COMPONENT_TARBALL || "").trim();
  const componentTarballSha256 = String(env.UFOO_BROWSER_COMPONENT_SHA256 || "").trim().toLowerCase();
  const devDir = getRepoExtensionDir();
  return {
    schemaVersion: 1,
    runtimeComponentName: RUNTIME_COMPONENT_NAME,
    runtimeComponentVersion: RUNTIME_COMPONENT_VERSION,
    componentTarballUrl,
    componentTarballSha256,
    protocolVersion: PROTOCOL_VERSION,
    cdpRelayProtocolVersion: CDP_RELAY_PROTOCOL_VERSION,
    compatibleExtensionMinVersion: COMPATIBLE_EXTENSION_MIN_VERSION,
    compatibleExtensionMaxMajor: COMPATIBLE_EXTENSION_MAX_MAJOR,
    nativeHostName: NATIVE_HOST_NAME,
    devNativeHostName: DEV_NATIVE_HOST_NAME,
    releaseExtensionId,
    storeUrl,
    storePublished: Boolean(releaseExtensionId && storeUrl),
    devExtensionId: DEV_EXTENSION_ID,
    devExtensionDir: fs.existsSync(devDir) ? devDir : "",
  };
}

function parseSemverTuple(version = "") {
  const match = String(version || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left = "", right = "") {
  const a = parseSemverTuple(left);
  const b = parseSemverTuple(right);
  if (!a || !b) return NaN;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Validate extension version and protocol version against the host compatibility range.
 */
function isExtensionCompatible({ extensionVersion = "", protocolVersion = 0 } = {}, manifest = getReleaseManifest()) {
  const proto = Number(protocolVersion);
  if (!Number.isInteger(proto) || proto !== manifest.protocolVersion) {
    return {
      ok: false,
      reason: `protocol_version_mismatch (expected ${manifest.protocolVersion}, got ${protocolVersion || "none"})`,
    };
  }
  const parsed = parseSemverTuple(extensionVersion);
  if (!parsed) {
    return { ok: false, reason: `invalid_extension_version (${extensionVersion || "empty"})` };
  }
  if (parsed[0] > manifest.compatibleExtensionMaxMajor) {
    return {
      ok: false,
      reason: `extension_major_too_new (${extensionVersion} > ${manifest.compatibleExtensionMaxMajor}.x)`,
    };
  }
  if (compareSemver(extensionVersion, manifest.compatibleExtensionMinVersion) < 0) {
    return {
      ok: false,
      reason: `extension_version_too_old (${extensionVersion} < ${manifest.compatibleExtensionMinVersion})`,
    };
  }
  return { ok: true, reason: "" };
}

function isSupportedPlatform(platform = process.platform, env = process.env) {
  const effective = String(env.UFOO_BROWSER_PLATFORM || platform || "").trim();
  return SUPPORTED_PLATFORMS.has(effective);
}

function resolveAllowedExtensionIds({ dev = true, env = process.env } = {}) {
  const manifest = getReleaseManifest(env);
  const ids = [];
  if (manifest.releaseExtensionId) ids.push(manifest.releaseExtensionId);
  if (dev && manifest.devExtensionId) ids.push(manifest.devExtensionId);
  return [...new Set(ids)];
}

module.exports = {
  RUNTIME_COMPONENT_NAME,
  RUNTIME_COMPONENT_VERSION,
  PROTOCOL_VERSION,
  CDP_RELAY_PROTOCOL_VERSION,
  COMPATIBLE_EXTENSION_MIN_VERSION,
  COMPATIBLE_EXTENSION_MAX_MAJOR,
  NATIVE_HOST_NAME,
  DEV_NATIVE_HOST_NAME,
  DEV_EXTENSION_ID,
  SUPPORTED_PLATFORMS,
  computeExtensionIdFromPublicKey,
  getRepoExtensionDir,
  getReleaseManifest,
  compareSemver,
  isExtensionCompatible,
  isSupportedPlatform,
  resolveAllowedExtensionIds,
};
