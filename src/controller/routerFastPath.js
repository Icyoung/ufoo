"use strict";

const {
  classifyPromptIntent,
  normalizeExecutionPath,
  normalizeGateRouterResult,
  resolveExecutionPath,
  resolveGateRouterConfig,
  shouldUseGateRouter,
} = require("./gateRouter");

module.exports = {
  classifyPromptIntent,
  normalizeExecutionPath,
  normalizeRouteAgentResult: normalizeGateRouterResult,
  resolveExecutionPath,
  resolveRouterFastPathConfig: resolveGateRouterConfig,
  shouldUseRouterFastPath: shouldUseGateRouter,
  normalizeGateRouterResult,
  resolveGateRouterConfig,
  shouldUseGateRouter,
};
