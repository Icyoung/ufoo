"use strict";

const {
  IPC_REQUEST_TYPES,
  IPC_RESPONSE_TYPES,
} = require("../contracts/eventContract");
const {
  executeProjectRuntimeOperation,
} = require("./projectRuntimeGateway");

function writeResult(socket, payload) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify({
    type: IPC_RESPONSE_TYPES.CONTROL_PLANE_RESULT,
    ...payload,
  })}\n`);
}

function createProjectRuntimeControlPlane(options = {}) {
  const projectRoot = String(options.projectRoot || "").trim();
  const execute = options.execute || executeProjectRuntimeOperation;
  const activeCalls = new Map();

  async function handleRequest(req, socket) {
    if (!req || typeof req !== "object") return false;
    if (req.type === IPC_REQUEST_TYPES.CONTROL_PLANE_CANCEL) {
      const requestId = String(req.request_id || "");
      const active = activeCalls.get(requestId);
      if (active) active.abortController.abort();
      return true;
    }
    if (req.type !== IPC_REQUEST_TYPES.CONTROL_PLANE_CALL) return false;

    const requestId = String(req.request_id || "").trim();
    const operation = String(req.operation || "").trim();
    if (!requestId || !operation) {
      writeResult(socket, {
        request_id: requestId,
        ok: false,
        error: {
          code: "invalid_control_plane_call",
          message: "control_plane_call requires request_id and operation",
        },
      });
      return true;
    }
    if (activeCalls.has(requestId)) {
      writeResult(socket, {
        request_id: requestId,
        ok: false,
        error: {
          code: "duplicate_control_plane_call",
          message: `control plane request is already active: ${requestId}`,
        },
      });
      return true;
    }

    const abortController = new AbortController();
    const cancelOnClose = () => abortController.abort();
    activeCalls.set(requestId, { abortController, socket });
    socket.once("close", cancelOnClose);
    try {
      const result = await execute(
        projectRoot,
        operation,
        req.arguments && typeof req.arguments === "object" ? req.arguments : {},
        {
          requestId,
          toolCallId: req.tool_call_id,
          signal: abortController.signal,
        }
      );
      writeResult(socket, {
        request_id: requestId,
        ok: true,
        result,
      });
    } catch (err) {
      writeResult(socket, {
        request_id: requestId,
        ok: false,
        error: {
          code: err && err.code ? String(err.code) : "control_plane_error",
          message: err && err.message ? err.message : String(err),
        },
      });
    } finally {
      socket.removeListener("close", cancelOnClose);
      activeCalls.delete(requestId);
    }
    return true;
  }

  function stop() {
    for (const active of activeCalls.values()) {
      active.abortController.abort();
    }
    activeCalls.clear();
  }

  function activeCount() {
    return activeCalls.size;
  }

  return {
    handleRequest,
    stop,
    activeCount,
  };
}

module.exports = {
  createProjectRuntimeControlPlane,
};
