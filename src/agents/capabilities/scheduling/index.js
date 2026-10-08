"use strict";
const { createCoordinationCapability } = require("../coordination");
module.exports = { createSchedulingCapability: (host) => createCoordinationCapability({ host, id: "scheduling", toolNames: ["manage_cron"] }) };
