"use strict";

const {
  runPlanGraphCommand,
  normalizePlanGraphCommand,
} = require("../context/planGraphService");

function runPlanGraphTool(args = {}, options = {}) {
  const command = normalizePlanGraphCommand(args) || args;
  const result = runPlanGraphCommand(command, {
    executionState: options.executionState,
    runTool: options.runTool,
    autoAdvance: options.autoAdvance !== false,
    parallel: options.parallel !== false,
    knownTools: options.knownTools,
    maxNodeRuns: options.maxNodeRuns,
  });

  const payload = result.modelPayload || result;
  return {
    ok: payload.status === "accepted",
    ...payload,
    executionState: result.executionState,
  };
}

module.exports = {
  runPlanGraphTool,
};
