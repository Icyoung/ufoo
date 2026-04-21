"use strict";

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return scopes
    .map((scope) => normalizeString(scope))
    .filter(Boolean);
}

function parseTimestamp(value) {
  const normalized = normalizeString(value);
  if (!normalized) return NaN;
  return Date.parse(normalized);
}

function classifyCredentialState(expiresAtMs, nowMs, refreshWindowMs) {
  if (!Number.isFinite(expiresAtMs)) return "unknown";
  if (expiresAtMs <= nowMs) return "expired";
  if ((expiresAtMs - nowMs) <= refreshWindowMs) return "near_expiry";
  return "fresh";
}

function buildCredentialDescriptor(input = {}) {
  const provider = normalizeString(input.provider);
  const credentialKind = normalizeString(input.credentialKind) || "oauth";
  const tokenType = normalizeString(input.tokenType) || "Bearer";
  const expiresAt = normalizeString(input.expiresAt);
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const refreshWindowMs = Number.isFinite(input.refreshWindowMs) ? input.refreshWindowMs : 0;
  const expiresAtMs = Number.isFinite(input.expiresAtMs) ? input.expiresAtMs : parseTimestamp(expiresAt);
  const explicitState = normalizeString(input.state);
  return {
    provider,
    credentialKind,
    source: normalizeString(input.source),
    tokenType,
    apiKey: normalizeString(input.apiKey),
    accessToken: normalizeString(input.accessToken),
    refreshToken: normalizeString(input.refreshToken),
    expiresAt,
    expiresAtMs,
    state: explicitState || classifyCredentialState(expiresAtMs, nowMs, refreshWindowMs),
    refreshable: input.refreshable === true,
    profile: normalizeString(input.profile),
    credentialPath: normalizeString(input.credentialPath),
    accountId: normalizeString(input.accountId),
    accountEmail: normalizeString(input.accountEmail),
    schemaVersion: normalizeString(input.schemaVersion),
    scopes: normalizeScopes(input.scopes),
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? { ...input.metadata }
      : {},
  };
}

function toLegacyResolvedAuth(descriptor = {}) {
  const token = normalizeString(descriptor.accessToken) || normalizeString(descriptor.apiKey);
  return {
    source: descriptor.credentialKind === "api-key" ? "api-key" : "oauth",
    token,
    apiKey: normalizeString(descriptor.apiKey),
    accessToken: normalizeString(descriptor.accessToken),
    refreshToken: normalizeString(descriptor.refreshToken),
    tokenType: normalizeString(descriptor.tokenType) || "Bearer",
    state: normalizeString(descriptor.state),
    expiresAt: normalizeString(descriptor.expiresAt),
    schemaVersion: normalizeString(descriptor.schemaVersion),
    profile: normalizeString(descriptor.profile),
    tokenPath: normalizeString(descriptor.credentialPath),
    provider: normalizeString(descriptor.provider),
    credentialKind: normalizeString(descriptor.credentialKind),
  };
}

function buildUpstreamAuthFromCredential(descriptor = {}) {
  const tokenType = normalizeString(descriptor.tokenType) || "Bearer";
  const apiKey = normalizeString(descriptor.apiKey);
  const accessToken = normalizeString(descriptor.accessToken);
  if (descriptor.credentialKind === "api-key" && apiKey) {
    return { apiKey };
  }
  if (accessToken) {
    return {
      headers: {
        authorization: `${tokenType} ${accessToken}`,
      },
    };
  }
  const err = new Error(`Unsupported upstream credential descriptor for provider ${normalizeString(descriptor.provider) || "unknown"}`);
  err.code = "UPSTREAM_CREDENTIAL_UNSUPPORTED";
  throw err;
}

module.exports = {
  normalizeString,
  normalizeScopes,
  parseTimestamp,
  classifyCredentialState,
  buildCredentialDescriptor,
  toLegacyResolvedAuth,
  buildUpstreamAuthFromCredential,
};
