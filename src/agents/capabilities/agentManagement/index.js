"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createAgentManagementCapability: (host) => createCoordinationCapability({ host, id: "agent-management",
  toolNames: ["list_agents", "launch_agent", "rename_agent", "close_agent", "delegate_task", "resume_agents"] }) };
