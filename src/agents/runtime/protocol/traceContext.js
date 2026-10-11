"use strict";

// Correlation metadata is observational. It never grants authority or identity.
const TRACE_FIELDS = Object.freeze(["traceId", "taskId", "taskRunId", "parentTaskRunId", "parentSessionId", "parentRequestId", "requestId", "attemptId"]);
function normalizeTraceContext(input = {}) {
  return Object.fromEntries(TRACE_FIELDS.filter(key => typeof input?.[key] === "string" && input[key].length <= 256 && input[key].trim())
    .map(key => [key, input[key].trim()]));
}
module.exports = { normalizeTraceContext };
