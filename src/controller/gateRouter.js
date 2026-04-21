"use strict";

const { loadConfig } = require("../config");

const DEFAULT_EXECUTION_PATH = "main";
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_TIMEOUT_MS = 5000;

const ROUTING_PATTERNS = [
  /\bwho should\b/i,
  /\bwhich agent\b/i,
  /\broute (?:this|it|that|the request)\b/i,
  /\bcontinue with\b/i,
  /\bhand\s+off\b/i,
  /\bsend (?:this|it|that)\b/i,
  /\bassign (?:this|it|that)\b/i,
  /\bforward (?:this|it|that)\b/i,
  /\bshould (?:i|we) ask\b/i,
  /\bnew (?:codex|claude|ucode)\b/i,
  /交给谁/,
  /继续给/,
  /发送(?:这个|它|这条|这个任务)?给/,
  /让.*(?:接这个任务|接手|处理这个|来处理)/,
  /发给/,
  /转给/,
  /应该找谁/,
  /需要新开.*(?:codex|claude|ucode)/i,
];

const NON_ROUTING_PATTERNS = [
  /\bfix\b/i,
  /\bimplement\b/i,
  /\bwrite\b/i,
  /\bedit\b/i,
  /\brefactor\b/i,
  /\btest\b/i,
  /\binvestigate\b/i,
  /\bdebug\b/i,
  /\bbuild\b/i,
  /\bcreate\b/i,
  /\bsearch\b/i,
  /\bopen\b/i,
  /\bread\b/i,
  /修复/,
  /修正/,
  /实现/,
  /重构/,
  /测试/,
  /排查/,
  /调试/,
  /构建/,
  /搜索/,
  /查看/,
];

function normalizeExecutionPath(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "router-api") return "main";
  if (text === "main") return "main";
  if (text === "shadow") return "shadow";
  if (text === "loop") return "loop";
  return DEFAULT_EXECUTION_PATH;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveExecutionPath({
  projectRoot,
  requestMeta = {},
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  const config = loadConfigImpl(projectRoot || process.cwd());
  return normalizeExecutionPath(
    requestMeta.agent_execution_path
      || env.UFOO_AGENT_EXECUTION_PATH
      || config.agentExecutionPath
      || config.controllerMode
      || DEFAULT_EXECUTION_PATH
  );
}

function classifyPromptIntent(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return { kind: "general", reason: "empty_prompt" };
  const hasRoutingSignal = ROUTING_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasRoutingSignal) return { kind: "general", reason: "no_routing_signal" };
  const hasNonRoutingSignal = NON_ROUTING_PATTERNS.some((pattern) => pattern.test(text));
  if (hasNonRoutingSignal) return { kind: "general", reason: "contains_execution_language" };
  return { kind: "routing", reason: "routing_signal" };
}

function shouldUseGateRouter({
  projectRoot,
  prompt,
  requestMeta = {},
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  const executionPath = resolveExecutionPath({
    projectRoot,
    requestMeta,
    env,
    loadConfigImpl,
  });
  const intent = classifyPromptIntent(prompt);
  return {
    executionPath,
    intent,
    enabled: executionPath === "main" || executionPath === "loop",
  };
}

function resolveGateRouterConfig({
  projectRoot,
  requestMeta = {},
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  const config = loadConfigImpl(projectRoot || process.cwd());
  return {
    provider: String(
      requestMeta.router_provider
        || env.UFOO_AGENT_ROUTER_PROVIDER
        || config.routerProvider
        || "ucode"
    ).trim(),
    model: String(
      requestMeta.router_model
        || env.UFOO_AGENT_ROUTER_MODEL
        || config.routerModel
        || ""
    ).trim(),
    timeoutMs: toPositiveNumber(
      requestMeta.router_timeout_ms
        || env.UFOO_AGENT_ROUTER_TIMEOUT_MS
        || config.routerTimeoutMs,
      DEFAULT_TIMEOUT_MS
    ),
    confidenceThreshold: Math.min(
      1,
      toPositiveNumber(
        requestMeta.router_confidence_threshold
          || env.UFOO_AGENT_ROUTER_CONFIDENCE_THRESHOLD
          || config.routerConfidenceThreshold,
        DEFAULT_CONFIDENCE_THRESHOLD
      )
    ),
  };
}

function normalizeInjectionMode(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return text === "queued" ? "queued" : "immediate";
}

function normalizeGateRouterResult(payload = {}, fallbackMessage = "") {
  if (!payload || typeof payload !== "object") {
    return {
      decision: "upgrade_to_main_router",
      target: "unknown",
      confidence: 0,
      reason: "",
      message: String(fallbackMessage || ""),
      injection_mode: "immediate",
    };
  }

  const rawConfidence = Number(payload.confidence);
  const normalizedConfidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0;
  const rawDecision = String(payload.decision || "").trim().toLowerCase();
  const normalizedDecision = rawDecision === "direct_dispatch"
    || rawDecision === "upgrade_to_main_router"
    ? rawDecision
    : (String(payload.target || "").trim() && String(payload.target || "").trim() !== "unknown"
        ? "direct_dispatch"
        : "upgrade_to_main_router");

  return {
    decision: normalizedDecision,
    target: String(payload.target || "unknown").trim() || "unknown",
    confidence: normalizedConfidence,
    reason: String(payload.reason || "").trim(),
    message: String(payload.message || fallbackMessage || "").trim(),
    injection_mode: normalizeInjectionMode(payload.injection_mode),
  };
}

module.exports = {
  classifyPromptIntent,
  normalizeExecutionPath,
  normalizeGateRouterResult,
  resolveExecutionPath,
  resolveGateRouterConfig,
  shouldUseGateRouter,
};
