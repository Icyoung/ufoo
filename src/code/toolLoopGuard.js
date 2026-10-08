"use strict";

const { ToolLoopGuard: RuntimeToolLoopGuard } = require("../agents/runtime/core/toolLoopGuard");
class ToolLoopGuard extends RuntimeToolLoopGuard {
  constructor() {
    super({ tightTools: ["read", "read_image", "artifact_read", "plan_graph"] });
  }
}
module.exports = { ToolLoopGuard };
