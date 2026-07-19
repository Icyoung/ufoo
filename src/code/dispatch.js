const { runReadTool } = require("./tools/read");
const { runWriteTool } = require("./tools/write");
const { runEditTool } = require("./tools/edit");
const { runBashTool } = require("./tools/bash");

const TOOL_NAMES = ["read", "write", "edit", "bash"];

function normalizeToolName(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "read") return "read";
  if (text === "write") return "write";
  if (text === "edit") return "edit";
  if (text === "bash") return "bash";
  return "";
}

function runToolCall(input = {}, options = {}) {
  const tool = normalizeToolName(input.tool || input.name);
  const args = input.args && typeof input.args === "object" ? input.args : {};
  if (!tool) {
    return {
      ok: false,
      error: "unknown tool",
      supported_tools: TOOL_NAMES.slice(),
    };
  }
  if (tool === "read") return runReadTool(args, options);
  if (tool === "write") return runWriteTool(args, options);
  if (tool === "edit") return runEditTool(args, options);
  return runBashTool(args, options);
}

module.exports = {
  TOOL_NAMES,
  normalizeToolName,
  runToolCall,
};
