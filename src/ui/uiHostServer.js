"use strict";

/**
 * Minimal Node host for ufoo-ui/1 handshake / event fanout.
 *
 * Security:
 * - Unix socket chmod 0o600 after listen
 * - Shared auth_token required in hello payload (timing-safe compare)
 * - Commands rejected until the client authenticates
 * - Soft frame-size cap to avoid unbounded buffering
 */

const net = require("net");
const fs = require("fs");
const crypto = require("crypto");
const {
  PROTOCOL,
  createEnvelope,
  encodeMessage,
  decodeMessage,
  createSeqCounter,
} = require("../runtime/contracts/uiProtocol");

function extractClientCapabilities(env) {
  const payload = env && env.payload && typeof env.payload === "object" ? env.payload : {};
  const raw = payload.capabilities;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string" && item) out.push(item);
  }
  return out;
}

const MAX_BUFFER_BYTES = 1024 * 1024;
const SOCKET_MODE = 0o600;

function createAuthToken() {
  return crypto.randomBytes(32).toString("hex");
}

function tokensEqual(expected, actual) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(actual || ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function createUiHostServer({
  socketPath,
  authToken = createAuthToken(),
  packageVersion = require("../../package.json").version,
  capabilities = ["chat"],
  onCommand = null,
  onClientReady = null,
  maxBufferBytes = MAX_BUFFER_BYTES,
} = {}) {
  if (!socketPath) throw new Error("socketPath required");
  if (!authToken) throw new Error("authToken required");
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore
  }

  const seq = createSeqCounter();
  const clients = new Set();
  // Latest authenticated client's advertised capabilities. Multi-window
  // gating reads this to decide whether the Rust TUI can render frames.
  let clientCapabilities = [];
  // Lossy backpressure: when a client socket is saturated (write returns
  // false), keep only the latest envelope per key until drain.
  const lossyPendingByClient = new WeakMap();

  function isLossyEnvelope(envelope) {
    if (!envelope || envelope.kind !== "event") return false;
    // createLossyEvent omits seq; ordered events always have a number seq.
    return envelope.seq == null;
  }

  function lossyKey(envelope) {
    if (envelope && envelope.name === "multi.pane.frame") {
      const id = envelope.payload && envelope.payload.agent_id;
      return `frame:${id || ""}`;
    }
    return `event:${(envelope && envelope.name) || ""}`;
  }

  function flushLossyPending(client) {
    const pending = lossyPendingByClient.get(client);
    if (!pending || pending.size === 0) {
      client.__ufooBackpressure = false;
      return;
    }
    const entries = [...pending.entries()];
    pending.clear();
    for (let i = 0; i < entries.length; i += 1) {
      const [key, env] = entries[i];
      try {
        const ok = client.write(encodeMessage(env));
        if (ok === false) {
          pending.set(key, env);
          for (let j = i + 1; j < entries.length; j += 1) {
            pending.set(entries[j][0], entries[j][1]);
          }
          client.__ufooBackpressure = true;
          return;
        }
      } catch {
        clients.delete(client);
        return;
      }
    }
    client.__ufooBackpressure = false;
  }

  function ensureDrainHook(client) {
    if (client.__ufooDrainHooked) return;
    client.__ufooDrainHooked = true;
    client.on("drain", () => {
      client.__ufooBackpressure = false;
      flushLossyPending(client);
    });
  }

  function broadcast(envelope) {
    const line = encodeMessage(envelope);
    const lossy = isLossyEnvelope(envelope);
    for (const client of clients) {
      try {
        if (lossy && client.__ufooBackpressure) {
          let pending = lossyPendingByClient.get(client);
          if (!pending) {
            pending = new Map();
            lossyPendingByClient.set(client, pending);
          }
          pending.set(lossyKey(envelope), envelope);
          continue;
        }
        const ok = client.write(line);
        if (ok === false && lossy) {
          client.__ufooBackpressure = true;
          ensureDrainHook(client);
          let pending = lossyPendingByClient.get(client);
          if (!pending) {
            pending = new Map();
            lossyPendingByClient.set(client, pending);
          }
          pending.set(lossyKey(envelope), envelope);
        }
      } catch {
        clients.delete(client);
      }
    }
  }

  function send(client, envelope) {
    try {
      client.write(encodeMessage(envelope));
    } catch {
      // ignore write failures on closing sockets
    }
  }

  function rejectAndClose(socket, message) {
    send(socket, createEnvelope({
      kind: "error",
      name: "protocol",
      seq: seq.next(),
      payload: { ok: false, error: message },
    }));
    try {
      socket.destroy();
    } catch {
      // ignore
    }
  }

  const server = net.createServer((socket) => {
    clients.add(socket);
    let authenticated = false;
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBufferBytes) {
        rejectAndClose(socket, "frame buffer exceeded");
        clients.delete(socket);
        return;
      }

      let newline;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const lineBuf = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        const line = lineBuf.toString("utf8");
        if (!line.trim()) continue;

        const decoded = decodeMessage(line);
        if (!decoded.ok) {
          send(socket, createEnvelope({
            kind: "error",
            name: "protocol",
            seq: seq.next(),
            payload: { ok: false, errors: decoded.errors },
          }));
          continue;
        }
        const env = decoded.envelope;

        if (env.kind === "hello") {
          const token = env.payload && env.payload.auth_token;
          if (!tokensEqual(authToken, token)) {
            rejectAndClose(socket, "unauthorized");
            clients.delete(socket);
            return;
          }
          authenticated = true;
          clientCapabilities = extractClientCapabilities(env);
          send(socket, createEnvelope({
            kind: "welcome",
            seq: seq.next(),
            payload: {
              selected_protocol: PROTOCOL,
              package_version: packageVersion,
              capabilities,
            },
          }));
          if (typeof onClientReady === "function") {
            Promise.resolve(onClientReady(socket, env)).catch(() => {});
          }
          continue;
        }

        if (!authenticated) {
          rejectAndClose(socket, "hello required");
          clients.delete(socket);
          return;
        }

        if (env.kind === "command" && typeof onCommand === "function") {
          Promise.resolve(onCommand(env))
            .then((result) => {
              send(socket, createEnvelope({
                kind: "result",
                name: env.name,
                requestId: env.request_id,
                seq: seq.next(),
                payload: result && typeof result === "object" ? result : { ok: true },
              }));
            })
            .catch((err) => {
              send(socket, createEnvelope({
                kind: "error",
                name: env.name,
                requestId: env.request_id,
                seq: seq.next(),
                payload: { ok: false, error: err && err.message ? err.message : String(err) },
              }));
            });
        }
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  return {
    PROTOCOL,
    socketPath,
    authToken,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, SOCKET_MODE);
          } catch (err) {
            server.close();
            reject(err);
            return;
          }
          resolve(socketPath);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const client of clients) {
          try {
            client.destroy();
          } catch {
            // ignore
          }
        }
        clients.clear();
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // ignore
          }
          resolve();
        });
      });
    },
    broadcast,
    nextSeq: () => seq.next(),
    createEvent(name, payload, scope = null) {
      return createEnvelope({
        kind: "event",
        name,
        seq: seq.next(),
        scope,
        payload,
      });
    },
    // Lossy events (e.g. multi.pane.frame) omit the ordered `seq` so they
    // cannot trigger the seq-gap resync path when frames are coalesced.
    createLossyEvent(name, payload, scope = null) {
      return createEnvelope({
        kind: "event",
        name,
        scope,
        payload,
      });
    },
    getClientCapabilities() {
      return clientCapabilities.slice();
    },
  };
}

module.exports = {
  createUiHostServer,
  createAuthToken,
  SOCKET_MODE,
  MAX_BUFFER_BYTES,
};
