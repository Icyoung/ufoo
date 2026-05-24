const fs = require("fs");
const net = require("net");
const { PTY_SOCKET_MESSAGE_TYPES, PTY_SOCKET_SUBSCRIBE_MODES } = require("../../runtime/contracts/ptySocketContract");

function createAgentSockets(options = {}) {
  const {
    onTermWrite = () => {},
    onPlaceCursor = () => {},
    isAgentView = () => false,
    isBusMode = () => false,
    getViewingAgent = () => "",
    sendBusRaw = () => {},
  } = options;

  let outputClient = null;
  let outputBuffer = "";
  let inputClient = null;
  let pendingResize = null;

  function requestSnapshot(mode = PTY_SOCKET_SUBSCRIBE_MODES.SCREEN) {
    if (!outputClient || outputClient.destroyed) return false;
    const safeMode = mode === PTY_SOCKET_SUBSCRIBE_MODES.FULL
      ? PTY_SOCKET_SUBSCRIBE_MODES.FULL
      : PTY_SOCKET_SUBSCRIBE_MODES.SCREEN;
    try {
      outputClient.write(JSON.stringify({
        type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE,
        mode: safeMode,
      }) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  function requestScreenSnapshot() {
    return requestSnapshot(PTY_SOCKET_SUBSCRIBE_MODES.SCREEN);
  }

  function connectOutput(sockPath) {
    if (outputClient) {
      disconnectOutput();
    }
    outputBuffer = "";

    if (!fs.existsSync(sockPath)) {
      onTermWrite("\x1b[1;31m[Error]\x1b[0m inject.sock not found\r\n");
      onTermWrite("\x1b[33m[Hint]\x1b[0m Agent may not be running in terminal mode\r\n");
      onTermWrite("Press Esc to return\r\n");
      return;
    }

    try {
      outputClient = net.createConnection(sockPath, () => {
        outputClient.write(JSON.stringify({
          type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE,
          mode: PTY_SOCKET_SUBSCRIBE_MODES.FULL,
        }) + "\n");
      });

      const connectTimeout = setTimeout(() => {
        if (outputClient && !outputClient.connecting) return;
        onTermWrite("\x1b[1;31m[Timeout]\x1b[0m Could not connect\r\nPress Esc to return\r\n");
        disconnectOutput();
      }, 5000);

      outputClient.on("connect", () => {
        clearTimeout(connectTimeout);
      });

      outputClient.on("data", (data) => {
        outputBuffer += data.toString("utf8");
        const lines = outputBuffer.split("\n");
        outputBuffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === PTY_SOCKET_MESSAGE_TYPES.OUTPUT) {
              if (msg.data) onTermWrite(msg.data);
            } else if (msg.type === PTY_SOCKET_MESSAGE_TYPES.REPLAY ||
              msg.type === PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT) {
              if (msg.data) onTermWrite(msg.data);
              if (msg.type === PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT && msg.cursor) {
                onPlaceCursor(msg.cursor);
              }
            }
          } catch {
            // ignore malformed messages
          }
        }
      });

      outputClient.on("error", (err) => {
        if (isAgentView()) {
          onTermWrite(`\r\n\x1b[1;31m[Connection error]\x1b[0m ${err.message}\r\nPress Esc to return\r\n`);
        }
      });

      outputClient.on("close", () => {
        outputClient = null;
        if (isAgentView()) {
          onTermWrite("\r\n\x1b[1;33m[Agent disconnected]\x1b[0m\r\nPress Esc to return\r\n");
        }
      });
    } catch (err) {
      onTermWrite(`\x1b[1;31m[Error]\x1b[0m ${err.message}\r\nPress Esc to return\r\n`);
    }
  }

  function disconnectOutput() {
    if (outputClient) {
      try {
        outputClient.removeAllListeners();
        outputClient.destroy();
      } catch {
        // ignore
      }
      outputClient = null;
    }
    outputBuffer = "";
  }

  function connectInput(sockPath) {
    if (inputClient) {
      disconnectInput();
    }
    try {
      inputClient = net.createConnection(sockPath);
      inputClient.on("connect", () => {
        if (pendingResize) {
          const { cols, rows } = pendingResize;
          pendingResize = null;
          try {
            inputClient.write(JSON.stringify({
              type: PTY_SOCKET_MESSAGE_TYPES.RESIZE,
              cols,
              rows,
            }) + "\n");
          } catch {
            // ignore write errors
          }
        }
      });
      inputClient.on("error", () => {
        inputClient = null;
      });
      inputClient.on("close", () => {
        inputClient = null;
      });
    } catch {
      inputClient = null;
    }
  }

  function disconnectInput() {
    if (inputClient) {
      try {
        inputClient.removeAllListeners();
        inputClient.destroy();
      } catch {
        // ignore
      }
      inputClient = null;
    }
  }

  function sendRaw(data) {
    if (inputClient && !inputClient.destroyed) {
      try {
        inputClient.write(JSON.stringify({
          type: PTY_SOCKET_MESSAGE_TYPES.RAW,
          data,
        }) + "\n");
        return;
      } catch {
        // ignore write errors
      }
    }
    if (isBusMode()) {
      const viewingAgent = getViewingAgent();
      if (viewingAgent) {
        sendBusRaw(viewingAgent, data);
      }
    }
  }

  function sendResize(cols, rows) {
    if (!inputClient || inputClient.destroyed) {
      pendingResize = { cols, rows };
      return;
    }
    try {
      inputClient.write(JSON.stringify({
        type: PTY_SOCKET_MESSAGE_TYPES.RESIZE,
        cols,
        rows,
      }) + "\n");
    } catch {
      // ignore write errors
    }
  }

  function disconnectAll() {
    disconnectOutput();
    disconnectInput();
  }

  return {
    connectOutput,
    disconnectOutput,
    connectInput,
    disconnectInput,
    disconnectAll,
    sendRaw,
    sendResize,
    requestSnapshot,
    requestScreenSnapshot,
  };
}

module.exports = {
  createAgentSockets,
};
