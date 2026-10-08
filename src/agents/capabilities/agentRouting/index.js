"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createAgentRoutingCapability: (host) => createCoordinationCapability({ host, id: "agent-routing",
  toolNames: ["route_agent", "dispatch_message", "read_bus_summary", "read_prompt_history", "read_open_decisions"] }) };
