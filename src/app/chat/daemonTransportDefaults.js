const DAEMON_TRANSPORT_DEFAULTS = {
  primaryRetries: 25,
  secondaryRetries: 50,
  retryDelayMs: 200,
  restartDelayMs: 1000,
  connectTimeoutMs: 2000,
};

module.exports = {
  DAEMON_TRANSPORT_DEFAULTS,
};
