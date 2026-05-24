"use strict";

const {
  ClaudeUpstreamCredentialResolver,
  DEFAULT_REFRESH_WINDOW_MS,
  resolveClaudeOauthPaths,
  parseClaudeOauthFile,
  serializeClaudeOauthToken,
  classifyTokenState,
  withLockFile,
  atomicWriteJson,
} = require("./credentials/claude");
const { toLegacyResolvedAuth } = require("./credentials");

class ClaudeOauthTokenReader {
  constructor(options = {}) {
    this.resolver = new ClaudeUpstreamCredentialResolver(options);
  }

  resolvePaths() {
    return this.resolver.resolvePaths();
  }

  readTokenFile() {
    return this.resolver.readTokenFile();
  }

  buildResolvedAuth(tokenRecord) {
    return toLegacyResolvedAuth(this.resolver.buildResolvedCredential(tokenRecord));
  }

  async refreshIfNeeded(initialRecord) {
    const descriptor = await this.resolver.refreshIfNeeded(initialRecord);
    return toLegacyResolvedAuth(descriptor);
  }

  async resolveAuth() {
    const descriptor = await this.resolver.resolveCredentials();
    return toLegacyResolvedAuth(descriptor);
  }
}

module.exports = {
  ClaudeOauthTokenReader,
  DEFAULT_REFRESH_WINDOW_MS,
  resolveClaudeOauthPaths,
  parseClaudeOauthFile,
  serializeClaudeOauthToken,
  classifyTokenState,
  withLockFile,
  atomicWriteJson,
};
