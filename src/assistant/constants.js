const DEFAULT_ASSISTANT_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_ASSISTANT_TIMEOUT_GRACE_MS = 5000;

function normalizeAssistantTimeoutMs(value, fallback = DEFAULT_ASSISTANT_TIMEOUT_MS) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isFinite(base)) return DEFAULT_ASSISTANT_TIMEOUT_MS;
  return Math.max(1000, Math.floor(base));
}

module.exports = {
  DEFAULT_ASSISTANT_TIMEOUT_MS,
  DEFAULT_ASSISTANT_TIMEOUT_GRACE_MS,
  normalizeAssistantTimeoutMs,
};
