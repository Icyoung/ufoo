const listAgents = require("./tier0/listAgents");
const readBusSummary = require("./tier0/readBusSummary");
const readOpenDecisions = require("./tier0/readOpenDecisions");
const readProjectRegistry = require("./tier0/readProjectRegistry");
const readPromptHistory = require("./tier0/readPromptHistory");
const ackBus = require("./tier1/ackBus");
const dispatchMessage = require("./tier1/dispatchMessage");
const routeAgent = require("./tier1/routeAgent");
const closeAgent = require("./tier2/closeAgent");
const launchAgent = require("./tier2/launchAgent");
const manageCron = require("./tier2/manageCron");
const renameAgent = require("./tier2/renameAgent");
const {
  CALLER_TIERS,
  assertCallerTierAllowed,
  buildCallerTierError,
  normalizeCallerTier,
} = require("./types");

const SHARED_TOOL_REGISTRY = Object.freeze([
  readBusSummary,
  readPromptHistory,
  readOpenDecisions,
  listAgents,
  readProjectRegistry,
  routeAgent,
  dispatchMessage,
  ackBus,
  launchAgent,
  renameAgent,
  closeAgent,
  manageCron,
]);

function getSharedToolRegistry() {
  return SHARED_TOOL_REGISTRY.slice();
}

function getToolDefinition(name = "") {
  const target = String(name || "").trim();
  return SHARED_TOOL_REGISTRY.find((tool) => tool.name === target) || null;
}

function listToolsForCallerTier(callerTier = CALLER_TIERS.CONTROLLER) {
  const normalizedTier = normalizeCallerTier(callerTier);
  return SHARED_TOOL_REGISTRY.filter((tool) => tool.allowed_tiers.includes(normalizedTier));
}

function assertToolAllowedForCallerTier(toolName, callerTier, auditCtx = {}) {
  const toolDef = getToolDefinition(toolName);
  if (!toolDef) {
    const err = new Error(`unknown tool: ${toolName}`);
    err.code = "unsupported_tool";
    if (auditCtx && auditCtx.turn_id) err.turn_id = String(auditCtx.turn_id);
    if (auditCtx && auditCtx.tool_call_id) err.tool_call_id = String(auditCtx.tool_call_id);
    throw err;
  }
  assertCallerTierAllowed(toolDef, callerTier, auditCtx);
  return toolDef;
}

module.exports = {
  SHARED_TOOL_REGISTRY,
  getSharedToolRegistry,
  getToolDefinition,
  listToolsForCallerTier,
  assertToolAllowedForCallerTier,
  buildCallerTierError,
};
