"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createGroupsCapability: (host) => createCoordinationCapability({ host, id: "groups", toolNames: ["manage_group"] }) };
