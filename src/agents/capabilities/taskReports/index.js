"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createTaskReportsCapability: (host) => ({
  ...createCoordinationCapability({ host, id: "task-reports", toolNames: ["read_task_reports", "read_agent_trace", "read_agent_metrics", "accept_task"] }),
  requires: { ports: ["coordination"], capabilities: ["agent-management"] },
}) };
