"use strict";

const INJECTION_MODES = {
  IMMEDIATE: "immediate",
  QUEUED: "queued",
};

function normalizeInjectionMode(value, fallback = INJECTION_MODES.IMMEDIATE) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === INJECTION_MODES.QUEUED) return INJECTION_MODES.QUEUED;
  if (raw === INJECTION_MODES.IMMEDIATE) return INJECTION_MODES.IMMEDIATE;
  return fallback;
}

function normalizeMessageSource(value) {
  const raw = String(value || "").trim();
  return raw || "";
}

function buildMessageData(message, options = {}) {
  const base = options && typeof options.data === "object" && options.data
    ? { ...options.data }
    : {};
  const data = { ...base, message };
  data.injection_mode = normalizeInjectionMode(
    options.injectionMode || data.injection_mode,
    INJECTION_MODES.IMMEDIATE,
  );
  const source = normalizeMessageSource(options.source || data.source);
  if (source) {
    data.source = source;
  } else {
    delete data.source;
  }
  return data;
}

function getInjectionModeFromEvent(evt, fallback = INJECTION_MODES.IMMEDIATE) {
  const data = evt && typeof evt.data === "object" && evt.data ? evt.data : {};
  return normalizeInjectionMode(
    data.injection_mode || evt?.injection_mode,
    fallback,
  );
}

module.exports = {
  INJECTION_MODES,
  normalizeInjectionMode,
  normalizeMessageSource,
  buildMessageData,
  getInjectionModeFromEvent,
};
