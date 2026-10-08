"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createSharedMemoryCapability: (host) => createCoordinationCapability({ host, id: "shared-memory",
  toolNames: ["remember", "recall", "search_memory", "search_history", "edit_memory", "forget"] }) };
