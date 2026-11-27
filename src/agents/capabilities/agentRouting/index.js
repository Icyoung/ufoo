"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createAgentRoutingCapability: (host) => createCoordinationCapability({ host, id: "agent-routing",
  toolNames: ["dispatch_message", "read_agent_history", "read_open_decisions", "update_decision"] }) };
