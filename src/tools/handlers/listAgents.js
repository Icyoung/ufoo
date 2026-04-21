const { buildStatus } = require("../../daemon/status");

function listAgentsHandler(ctx = {}) {
  const status = buildStatus(ctx.projectRoot);
  const agents = Array.isArray(status.active_meta) ? status.active_meta : [];
  return {
    count: agents.length,
    agents,
  };
}

module.exports = {
  listAgentsHandler,
};
