"use strict";

const protocol = require("../../agents/runtime/protocol/toolCallLedger");
const DEFERABLE_TOOLS = Object.freeze(new Set(["ask_user"]));

module.exports = {
  ...protocol,
  DEFERABLE_TOOLS,
  createToolCallLedger: (options = {}) => protocol.createToolCallLedger({
    ...options, deferableTools: options.deferableTools || DEFERABLE_TOOLS,
  }),
};
