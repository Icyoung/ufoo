"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createTaskReportsCapability: (host) => ({
  ...createCoordinationCapability({ host, id: "task-reports", toolNames: ["read_task_reports", "accept_task"] }),
  requires: { ports: ["coordination"], capabilities: ["agent-management"] },
}) };
