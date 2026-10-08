"use strict";
module.exports = Object.freeze({ id: "main", budgets: Object.freeze({ maxRounds: 64, maxToolCalls: 128, maxToolErrors: 20 }), capabilities: Object.freeze([
  "coding", "planning", "skills", "agent-management", "agent-routing", "project-discovery", "shared-memory",
  "task-reports", "task-execution", "groups", "scheduling",
]) });
