"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createProjectDiscoveryCapability: (host) => createCoordinationCapability({ host, id: "project-discovery", toolNames: ["read_project_registry"] }) };
