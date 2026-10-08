"use strict";

const { createCodingCapability } = require("./coding");
const { createMainPlanningCapability } = require("./planning/main");
const { createSkillsCapability } = require("./skills");
const { createAgentManagementCapability } = require("./agentManagement");
const { createAgentRoutingCapability } = require("./agentRouting");
const { createProjectDiscoveryCapability } = require("./projectDiscovery");
const { createSharedMemoryCapability } = require("./sharedMemory");
const { createTaskReportsCapability } = require("./taskReports");
const { createTaskExecutionCapability } = require("./taskExecution");
const { createGroupsCapability } = require("./groups");
const { createSchedulingCapability } = require("./scheduling");
const { createGlobalRoutingCapability } = require("./globalRouting");

function createMainCapabilities(host) {
  return [createCodingCapability({ workspaceAccess: host.workspaceAccess }), createMainPlanningCapability(), createSkillsCapability(),
    createAgentManagementCapability(host), createAgentRoutingCapability(host), createProjectDiscoveryCapability(host),
    createSharedMemoryCapability(host), createTaskReportsCapability(host), createTaskExecutionCapability(host), createGroupsCapability(host), createSchedulingCapability(host)];
}
function createGlobalCapabilities(host) {
  return [createProjectDiscoveryCapability(host), createGlobalRoutingCapability()];
}

module.exports = { createMainCapabilities, createGlobalCapabilities };
