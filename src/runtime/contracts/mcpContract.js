"use strict";

const MCP_PROTOCOL_VERSION = "2024-11-05";
// Zero keeps the receive tool pending until a message arrives or the caller
// cancels. This preserves the model-token boundary: idle time never produces a
// timeout result that would wake the Agent. Positive values retain the bounded
// wait mode for diagnostics and non-Codex MCP clients.
const MCP_WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS = 0;
const MCP_WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS = 270;

const MCP_ERROR_CODES = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

function createJsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function createJsonRpcError(id, code, message, data = undefined) {
  const error = {
    code,
    message: String(message || "MCP request failed"),
  };
  if (data !== undefined) error.data = data;
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error,
  };
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  MCP_WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS,
  MCP_WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS,
  MCP_ERROR_CODES,
  createJsonRpcResult,
  createJsonRpcError,
};
