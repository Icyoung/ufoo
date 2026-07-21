"use strict";

const { runAskUserTool } = require("../context/userInteraction");

function runAskUserToolDispatch(args = {}, options = {}) {
  return runAskUserTool(args, options);
}

module.exports = {
  runAskUserTool: runAskUserToolDispatch,
};
