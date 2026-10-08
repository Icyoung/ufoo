"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createTaskExecutionCapability: (host) => createCoordinationCapability({ host, id: "task-execution", toolNames: ["manage_tasks"] }) };
