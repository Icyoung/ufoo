"use strict";

const net = require("net");

const {
  IPC_REQUEST_TYPES,
  IPC_RESPONSE_TYPES,
} = require("../contracts/eventContract");
const {
  isRunning,
  socketPath,
} = require("./index");
const {
  resolveGlobalControllerProjectRoot,
} = require("../projects");

function requestMcpControl(operation, options = {}) {
  const projectRoot = options.projectRoot || resolveGlobalControllerProjectRoot();
  const checkRunning = options.isRunning || isRunning;
  const resolveSocketPath = options.socketPath || socketPath;
  const connect = options.connect || ((target) => net.createConnection(target));
  const requestType = operation === "restart"
    ? IPC_REQUEST_TYPES.MCP_RESTART
    : IPC_REQUEST_TYPES.MCP_STATUS;
  if (!checkRunning(projectRoot)) {
    const err = new Error("Global controller daemon is not running");
    err.code = "global_daemon_not_running";
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const client = connect(resolveSocketPath(projectRoot));
    let buffer = "";
    let settled = false;
    const timeoutMs = Number(options.timeoutMs) || 10000;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      client.removeAllListeners();
      try {
        client.end();
      } catch {
        // ignore
      }
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    timer = setTimeout(() => {
      finishReject(Object.assign(new Error("MCP control request timed out"), {
        code: "mcp_control_timeout",
      }));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    client.on("connect", () => {
      client.write(`${JSON.stringify({ type: requestType })}\n`);
    });
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        if (response.type === IPC_RESPONSE_TYPES.ERROR) {
          const err = new Error(response.error || "MCP control failed");
          err.code = response.code || "mcp_control_error";
          finishReject(err);
          return;
        }
        if (response.type === IPC_RESPONSE_TYPES.RESPONSE && response.data?.mcp) {
          finishResolve(response.data);
          return;
        }
      }
    });
    client.once("error", finishReject);
    client.once("close", () => {
      finishReject(Object.assign(new Error("Global controller closed the MCP control request"), {
        code: "mcp_control_closed",
      }));
    });
  });
}

async function runMcpControlCli(operation, options = {}) {
  const result = await requestMcpControl(operation, options);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const status = result.mcp || {};
  process.stdout.write(`MCP ${status.running ? "running" : "stopped"}\n`);
  if (status.endpoint) process.stdout.write(`Endpoint: ${status.endpoint}\n`);
  if (status.pid) process.stdout.write(`PID: ${status.pid}\n`);
  process.stdout.write(`Sessions: ${status.session_count || 0}\n`);
  process.stdout.write(`Active requests: ${status.active_request_count || 0}\n`);
  process.stdout.write(`Active waits: ${status.active_wait_count || 0}\n`);
  return result;
}

module.exports = {
  requestMcpControl,
  runMcpControlCli,
};
