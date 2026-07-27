"use strict";

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  createUiHostServer,
  createAuthToken,
  SOCKET_MODE,
} = require("../../../src/ui/uiHostServer");
const {
  createEnvelope,
  encodeMessage,
  decodeMessage,
} = require("../../../src/runtime/contracts/uiProtocol");

function resolveProbeBinary() {
  const root = path.resolve(__dirname, "../../..");
  const plat = `${process.platform}-${process.arch}`;
  const candidates = [
    path.join(root, "target", "debug", "ufoo-tui"),
    path.join(root, "target", "release", "ufoo-tui"),
    path.join(root, "dist", "tui", plat, "ufoo-tui"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

const BINARY = resolveProbeBinary();

function readLine(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for line"));
    }, timeoutMs);
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf(0x0a);
      if (idx < 0) return;
      cleanup();
      resolve(buffer.subarray(0, idx).toString("utf8"));
    }
    function onError(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

describe("uiHostServer", () => {
  test("chmod socket to 0o600 and reject hello without auth token", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `ufoo-ui-auth-${process.pid}-${Date.now()}.sock`
    );
    const authToken = createAuthToken();
    const host = createUiHostServer({ socketPath, authToken });
    await host.listen();
    try {
      const st = fs.statSync(socketPath);
      expect(st.mode & 0o777).toBe(SOCKET_MODE);

      const socket = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(encodeMessage(createEnvelope({
        kind: "hello",
        payload: { supported_protocols: ["ufoo-ui/1"] },
      })));
      const line = await readLine(socket);
      const decoded = decodeMessage(line);
      expect(decoded.ok).toBe(true);
      expect(decoded.envelope.kind).toBe("error");
      expect(String(decoded.envelope.payload.error || "")).toMatch(/unauthorized/i);
      socket.destroy();
    } finally {
      await host.close();
    }
  });

  test("accepts hello with matching auth token", async () => {
    const socketPath = path.join(
      os.tmpdir(),
      `ufoo-ui-ok-${process.pid}-${Date.now()}.sock`
    );
    const authToken = createAuthToken();
    const host = createUiHostServer({ socketPath, authToken });
    await host.listen();
    try {
      const socket = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(encodeMessage(createEnvelope({
        kind: "hello",
        payload: {
          supported_protocols: ["ufoo-ui/1"],
          auth_token: authToken,
        },
      })));
      const line = await readLine(socket);
      const decoded = decodeMessage(line);
      expect(decoded.ok).toBe(true);
      expect(decoded.envelope.kind).toBe("welcome");
      socket.destroy();
    } finally {
      await host.close();
    }
  });

  test("protocol-probe completes hello/welcome against Node host", async () => {
    if (!BINARY) {
      // eslint-disable-next-line no-console
      console.warn("skip protocol-probe: ufoo-tui binary not built");
      return;
    }

    const socketPath = path.join(
      os.tmpdir(),
      `ufoo-ui-host-${process.pid}-${Date.now()}.sock`
    );
    const authToken = createAuthToken();
    const host = createUiHostServer({ socketPath, authToken });
    await host.listen();

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          BINARY,
          ["--protocol-probe", "--ui-socket", socketPath],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              UFOO_UI_TOKEN: authToken,
            },
          }
        );
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`protocol-probe timed out\nstdout=${stdout}\nstderr=${stderr}`));
        }, 5000);
        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr });
        });
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("protocol-probe ok");
      expect(result.stdout).toMatch(/version=\d+\.\d+\.\d+/);
    } finally {
      await host.close();
    }
  });
});
