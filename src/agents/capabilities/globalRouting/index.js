"use strict";
module.exports = { createGlobalRoutingCapability: () => ({ id: "global-routing", version: "1", requires: { ports: ["projectRouting"] }, tools: [],
  promptSections: ["You are the global ufoo project router. Select only a registered project. Return a final JSON object with reply and optional project_route={project_root,project_name,prompt,reason}. The project host executes the handoff. You have no coding, agent launch, or project mutation tools."],
  contextSources: [(_input, host) => host.projectRouting.list()],
}) };
