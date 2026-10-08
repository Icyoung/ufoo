const { buildStatus } = require("../../runtime/daemon/status");
const { isInternalAgentMeta } = require("../../runtime/contracts/agentMode");

function listAgentsHandler(ctx = {}) {
  const status = buildStatus(ctx.projectRoot);
  const agents = (Array.isArray(status.active_meta) ? status.active_meta : [])
    .filter((agent) => !ctx.internalAgentsOnly || isInternalAgentMeta(agent));
  return {
    count: agents.length,
    agents,
  };
}

module.exports = {
  listAgentsHandler,
};
