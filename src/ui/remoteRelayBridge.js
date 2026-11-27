"use strict";

/**
 * Host-side Remote Relay Bridge (UiTransportAdapter for Phase 5).
 *
 * Connects outbound from local `desktopUiHost` to a `ufoo-online` relay server,
 * registers this machine's persistent ECDH P-256 identity, authenticates one-time
 * pairing claims, handles P2P signaling probes / optional WebRTC DataChannels,
 * and bridges `ufoo-ui/1` commands & live event envelopes over Zero-Knowledge E2EE
 * (ECDH P-256 + HKDF-SHA256 + AES-256-GCM).
 */

const os = require("os");
const WebSocket = require("ws");
const { PROTOCOL, createEnvelope } = require("../runtime/contracts/uiProtocol");
const {
  E2eeSession,
  generatePairCode,
  hashPairCode,
  verifyClaimProof,
  computeHostProof,
  randomHex,
  validatePublicKeyJwk,
  sanitizePublicKeyJwk,
} = require("../online/remoteCrypto");
const {
  DEFAULT_RELAY_URL,
  defaultRemoteDir,
  loadOrCreateDeviceIdentity,
  loadRemoteConfig,
  saveRemoteConfig,
  upsertPairedClient,
  getPairedClient,
  touchPairedClient,
  revokePairedClient,
  listPairedClients,
  listActiveRelayPairDescriptors,
} = require("../online/remoteStore");
const { renderQrSvg } = require("../online/qrSvg");

const DEFAULT_WEB_BASE_URL = "https://online.ufoo.dev";

// Host-local management commands that remote clients should not invoke directly.
const BLOCKED_REMOTE_COMMANDS = new Set([
  "app.exit",
  "daemon.service.install",
  "daemon.service.uninstall",
  "cli.install_shims",
  "remote.enable",
  "remote.disable",
  "remote.pair.create",
  "remote.devices.revoke",
]);

function getLanCandidates() {
  const out = [];
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces() || {};
  } catch {
    return out;
  }
  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || entry.internal) continue;
      if (entry.family === "IPv4" || entry.family === 4) {
        out.push({ kind: "lan", address: entry.address });
      }
    }
  }
  return out.slice(0, 8);
}

function validateRelayUrl(relayUrl, allowInsecureWs = false) {
  const raw = String(relayUrl || "").trim();
  if (!raw) throw new Error("Relay URL is required");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Relay URL: ${raw}`);
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error(`Relay URL must use wss:// or ws:// (got ${parsed.protocol})`);
  }
  if (parsed.protocol === "ws:") {
    const host = parsed.hostname;
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!isLocal && !allowInsecureWs) {
      throw new Error(
        `Refusing unencrypted ws:// connection to "${host}". Use wss:// or enable allow_insecure_ws.`
      );
    }
  }
  return raw;
}

function normalizeWebBaseUrl(webBaseUrl) {
  const raw = String(webBaseUrl || DEFAULT_WEB_BASE_URL).trim().replace(/\/+$/, "");
  return raw.replace(/\/remote$/i, "");
}

function buildRemoteWebUrl(webBaseUrl, deviceId) {
  const base = normalizeWebBaseUrl(webBaseUrl);
  const id = String(deviceId || "").trim();
  if (!id) return `${base}/remote/`;
  return `${base}/remote/${encodeURIComponent(id)}`;
}

function isSameOriginDefaultRelay(webBaseUrl, relayUrl) {
  try {
    const web = new URL(normalizeWebBaseUrl(webBaseUrl));
    const relay = new URL(String(relayUrl || "").trim());
    const expectedWsProto = web.protocol === "http:" ? "ws:" : "wss:";
    if (relay.protocol !== expectedWsProto) return false;
    if (web.host.toLowerCase() !== relay.host.toLowerCase()) return false;
    const normalizedPath = relay.pathname.replace(/\/+$/, "");
    return normalizedPath === "/ufoo/online";
  } catch {
    return false;
  }
}

function buildDeepPairUrl({ webBaseUrl, relayUrl, deviceId, pairCode, fingerprint }) {
  const base = normalizeWebBaseUrl(webBaseUrl);
  const remoteUrl = buildRemoteWebUrl(base, deviceId);
  const params = new URLSearchParams();
  if (relayUrl && !isSameOriginDefaultRelay(base, relayUrl)) {
    params.set("relay", relayUrl);
  }
  params.set("pair", pairCode);
  if (fingerprint) params.set("fp", fingerprint);
  return `${remoteUrl}?${params.toString()}`;
}

function createRemoteRelayBridge({
  remoteDir = defaultRemoteDir(),
  deviceName = "",
  dispatchCommand = null,
  buildInitialEnvelopes = null,
  nextSeq = null,
  onStatusChange = null,
  rtcPeerConnectionFactory = null,
  reconnectBaseMs = 1000,
  reconnectMaxMs = 30000,
  heartbeatIntervalMs = 15000,
  connectTimeoutMs = 8000,
} = {}) {
  let identity = null;
  let config = loadRemoteConfig(remoteDir);
  let ws = null;
  let state = config.enabled ? "connecting" : "disabled";
  let lastError = "";
  let closed = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let reconnectAttempt = 0;

  // Pending host-generated pairing codes awaiting claim
  const activePairCodes = new Map(); // pair_id -> { pair_id, pair_code, code_hash, expires_at, used }
  // Claims approved by host, awaiting server pair.approved_ack containing token_hash
  const pendingApprovals = new Map(); // claim_id -> { client_id, label, public_key_jwk }
  // Pending waiters for pair.created / device.registered / pair.revoked
  const pendingPairCreates = [];
  let connectWaiters = [];

  // Active authenticated remote client E2EE sessions
  const clientSessions = new Map(); // client_id -> ClientSessionEntry

  const getRtcFactory = () => {
    if (typeof rtcPeerConnectionFactory === "function") return rtcPeerConnectionFactory;
    if (typeof globalThis.RTCPeerConnection === "function") {
      return (cfg) => new globalThis.RTCPeerConnection(cfg);
    }
    return null;
  };

  async function ensureIdentity() {
    if (!identity) {
      identity = await loadOrCreateDeviceIdentity(remoteDir, { deviceName });
    }
    return identity;
  }

  function emitStatusChange() {
    if (typeof onStatusChange === "function") {
      try {
        onStatusChange(getStatusSync());
      } catch {
        // ignore listener errors
      }
    }
  }

  function getStatusSync() {
    const paired = listPairedClients(remoteDir, { includeRevoked: false });
    const activeClients = [];
    for (const entry of clientSessions.values()) {
      if (entry.session && entry.session.ready) {
        activeClients.push({
          client_id: entry.client_id,
          label: entry.label,
          transport: entry.transport,
          connected_at: entry.connected_at,
        });
      }
    }
    const deviceId = identity ? identity.device_id : "";
    const resolvedWebBase = normalizeWebBaseUrl(config.web_base_url || DEFAULT_WEB_BASE_URL);
    return {
      ok: true,
      enabled: Boolean(config.enabled),
      connected: state === "connected",
      state,
      relay_url: config.relay_url || DEFAULT_RELAY_URL,
      web_base_url: config.web_base_url || "",
      remote_url: deviceId ? buildRemoteWebUrl(resolvedWebBase, deviceId) : "",
      has_auth_token: Boolean(config.auth_token),
      allow_insecure_ws: Boolean(config.allow_insecure_ws),
      device_id: deviceId,
      device_name: identity ? identity.device_name : (deviceName || os.hostname()),
      fingerprint: identity ? identity.fingerprint : "",
      paired_count: paired.length,
      active_clients: activeClients,
      last_error: lastError,
    };
  }

  async function getStatus() {
    await ensureIdentity();
    return getStatusSync();
  }

  function sendWs(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function closePeerConnection(entry) {
    if (!entry) return;
    if (entry.dataChannel) {
      try { entry.dataChannel.close(); } catch {}
      entry.dataChannel = null;
    }
    if (entry.peerConnection) {
      try { entry.peerConnection.close(); } catch {}
      entry.peerConnection = null;
    }
    entry.transport = "relay";
  }

  function dropClientSession(clientId) {
    const entry = clientSessions.get(clientId);
    if (!entry) return;
    closePeerConnection(entry);
    clientSessions.delete(clientId);
  }

  function dropAllClientSessions() {
    for (const cid of [...clientSessions.keys()]) {
      dropClientSession(cid);
    }
  }

  function resolveConnectWaiters(ok, err = null) {
    const waiters = connectWaiters;
    connectWaiters = [];
    for (const w of waiters) {
      if (w.timer) clearTimeout(w.timer);
      if (ok) w.resolve(true);
      else w.reject(err || new Error("Failed to connect to relay"));
    }
  }

  function rejectPendingPairCreates(err) {
    while (pendingPairCreates.length > 0) {
      const item = pendingPairCreates.shift();
      if (item.timer) clearTimeout(item.timer);
      item.reject(err);
    }
  }

  function sendRawFrameToClient(entry, frame) {
    if (
      entry.transport === "p2p"
      && entry.dataChannel
      && entry.dataChannel.readyState === "open"
    ) {
      try {
        entry.dataChannel.send(JSON.stringify(frame));
        return true;
      } catch {
        // Fall through to relay if DataChannel send fails
        entry.transport = "relay";
      }
    }
    return sendWs({
      type: "relay.frame",
      target_client_id: entry.client_id,
      frame,
    });
  }

  function enqueueEncryptedSend(entry, envelope) {
    if (!entry || !entry.session || !entry.session.ready) return Promise.resolve(false);
    if (typeof envelope.seq === "number" && envelope.seq > entry.lastSentSeq) {
      entry.lastSentSeq = envelope.seq;
    }
    entry.sendChain = entry.sendChain
      .then(async () => {
        if (!entry.session || !entry.session.ready) return false;
        const encrypted = await entry.session.encryptJson(envelope);
        return sendRawFrameToClient(entry, encrypted);
      })
      .catch(() => false);
    return entry.sendChain;
  }

  function getOrCreateClientEntry(clientId, pairedRecord) {
    let entry = clientSessions.get(clientId);
    if (!entry) {
      entry = {
        client_id: clientId,
        label: pairedRecord.label || "Remote Client",
        transport: "relay",
        connected_at: new Date().toISOString(),
        session: null,
        lastSentSeq: 0,
        peerConnection: null,
        dataChannel: null,
        sendChain: Promise.resolve(),
        recvChain: Promise.resolve(),
      };
      clientSessions.set(clientId, entry);
    }
    return entry;
  }

  async function processClientFrame(clientId, frame, sourceTransport = "relay") {
    const paired = getPairedClient(remoteDir, clientId);
    if (!paired || paired.revoked_at) {
      dropClientSession(clientId);
      sendWs({ type: "pair.revoke", client_id: clientId });
      return;
    }

    const id = await ensureIdentity();
    const entry = getOrCreateClientEntry(clientId, paired);
    if (sourceTransport === "p2p") {
      entry.transport = "p2p";
    }

    if (!frame || typeof frame !== "object") return;

    // 1. E2EE Handshake initiation
    if (frame.t === "hs_init") {
      const session = new E2eeSession({
        role: "host",
        deviceId: id.device_id,
        clientId,
        localPrivateKeyJwk: id.private_key_jwk,
        peerPublicKeyJwk: paired.public_key_jwk,
      });
      try {
        const ack = await session.acceptHandshakeInit(frame);
        entry.session = session;
        entry.connected_at = new Date().toISOString();
        entry.sendChain = Promise.resolve();
        touchPairedClient(remoteDir, clientId);
        sendRawFrameToClient(entry, ack);
        emitStatusChange();
      } catch {
        // Reject spoofed/invalid handshake silently without establishing session
        entry.session = null;
      }
      return;
    }

    // 2. Encrypted ufoo-ui/1 command message
    if (frame.t === "msg") {
      if (!entry.session || !entry.session.ready) return;
      let env;
      try {
        env = await entry.session.decryptJson(frame);
      } catch {
        // Tampered or replayed ciphertext — drop strictly
        return;
      }
      touchPairedClient(remoteDir, clientId);
      if (!env || typeof env !== "object" || env.kind !== "command") return;

      const cmdName = String(env.name || "").trim();
      const requestId = env.request_id || null;

      if (BLOCKED_REMOTE_COMMANDS.has(cmdName)) {
        await enqueueEncryptedSend(
          entry,
          createEnvelope({
            kind: "error",
            name: cmdName,
            requestId,
            seq: typeof nextSeq === "function" ? nextSeq() : undefined,
            payload: { ok: false, error: `Command "${cmdName}" is not permitted over remote access` },
          })
        );
        return;
      }

      if (cmdName === "ui.resync.request") {
        try {
          const initial = typeof buildInitialEnvelopes === "function"
            ? await Promise.resolve(buildInitialEnvelopes())
            : [];
          for (const item of Array.isArray(initial) ? initial : []) {
            await enqueueEncryptedSend(entry, item);
          }
          await enqueueEncryptedSend(
            entry,
            createEnvelope({
              kind: "result",
              name: cmdName,
              requestId,
              seq: typeof nextSeq === "function" ? nextSeq() : undefined,
              payload: { ok: true },
            })
          );
        } catch (err) {
          await enqueueEncryptedSend(
            entry,
            createEnvelope({
              kind: "error",
              name: cmdName,
              requestId,
              seq: typeof nextSeq === "function" ? nextSeq() : undefined,
              payload: { ok: false, error: err?.message || String(err) },
            })
          );
        }
        return;
      }

      if (typeof dispatchCommand !== "function") {
        await enqueueEncryptedSend(
          entry,
          createEnvelope({
            kind: "error",
            name: cmdName,
            requestId,
            payload: { ok: false, error: "Command dispatcher unavailable" },
          })
        );
        return;
      }

      try {
        const result = await Promise.resolve(dispatchCommand(env, { remote: true, clientId }));
        await enqueueEncryptedSend(
          entry,
          createEnvelope({
            kind: "result",
            name: cmdName,
            requestId,
            seq: typeof nextSeq === "function" ? nextSeq() : undefined,
            payload: result && typeof result === "object" ? result : { ok: true },
          })
        );
      } catch (err) {
        await enqueueEncryptedSend(
          entry,
          createEnvelope({
            kind: "error",
            name: cmdName,
            requestId,
            seq: typeof nextSeq === "function" ? nextSeq() : undefined,
            payload: { ok: false, error: err?.message || String(err) },
          })
        );
      }
    }
  }

  async function handlePairClaimRequest(msg) {
    const claimId = String(msg.claim_id || "").trim();
    const pairId = String(msg.pair_id || "").trim();
    const clientId = String(msg.client_id || "").trim();
    const label = String(msg.label || "Remote Client").trim().slice(0, 64);
    const clientPub = msg.client_public_key;
    const clientNonce = String(msg.client_nonce || "");
    const claimProof = String(msg.claim_proof || "");

    const reject = (reason) => {
      sendWs({ type: "pair.reject", claim_id: claimId, reason });
    };

    const slot = activePairCodes.get(pairId);
    if (!slot || slot.used || Date.now() > slot.expires_at) {
      activePairCodes.delete(pairId);
      reject("Pairing code expired or already used");
      return;
    }
    if (!clientId || !validatePublicKeyJwk(clientPub)) {
      reject("Invalid client public key");
      return;
    }

    const proofValid = await verifyClaimProof({
      pairCode: slot.pair_code,
      clientId,
      clientNonce,
      clientPublicKeyJwk: clientPub,
      claimProof,
    });
    if (!proofValid) {
      reject("Invalid pairing authentication proof");
      return;
    }

    slot.used = true;
    activePairCodes.delete(pairId);

    const id = await ensureIdentity();
    const hostNonce = randomHex(16);
    const hostProof = await computeHostProof({
      pairCode: slot.pair_code,
      deviceId: id.device_id,
      clientId,
      clientNonce,
      hostNonce,
      hostPublicKeyJwk: id.public_key_jwk,
    });

    pendingApprovals.set(claimId, {
      client_id: clientId,
      label,
      public_key_jwk: sanitizePublicKeyJwk(clientPub),
    });

    sendWs({
      type: "pair.approve",
      claim_id: claimId,
      host_public_key: id.public_key_jwk,
      host_nonce: hostNonce,
      host_proof: hostProof,
      device_name: id.device_name,
    });
  }

  async function handlePairApprovedAck(msg) {
    const claimId = String(msg.claim_id || "").trim();
    const pending = pendingApprovals.get(claimId);
    if (!pending) return;
    pendingApprovals.delete(claimId);
    await upsertPairedClient(remoteDir, {
      client_id: pending.client_id,
      label: pending.label,
      public_key_jwk: pending.public_key_jwk,
      token_hash: String(msg.token_hash || ""),
      paired_at: msg.paired_at || new Date().toISOString(),
    });
    emitStatusChange();
  }

  async function handleSignalMessage(msg) {
    const fromClientId = String(msg.from_client_id || "").trim();
    if (!fromClientId) return;
    const paired = getPairedClient(remoteDir, fromClientId);
    if (!paired || paired.revoked_at) return;

    const rtcFactory = getRtcFactory();

    if (msg.type === "signal.probe") {
      sendWs({
        type: "signal.probe",
        target_client_id: fromClientId,
        signal_id: msg.signal_id || "",
        probe: {
          webrtc_supported: Boolean(rtcFactory),
          lan_candidates: getLanCandidates(),
          relay_fallback: true,
        },
      });
      return;
    }

    if (!rtcFactory) return;

    const entry = getOrCreateClientEntry(fromClientId, paired);

    if (msg.type === "signal.offer" && msg.sdp) {
      closePeerConnection(entry);
      try {
        const pc = rtcFactory({
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        entry.peerConnection = pc;
        pc.onicecandidate = (evt) => {
          if (evt && evt.candidate) {
            sendWs({
              type: "signal.ice",
              target_client_id: fromClientId,
              signal_id: msg.signal_id || "",
              candidate: evt.candidate,
            });
          }
        };
        pc.ondatachannel = (evt) => {
          const ch = evt && evt.channel ? evt.channel : evt;
          if (!ch) return;
          entry.dataChannel = ch;
          const onOpen = () => {
            entry.transport = "p2p";
            emitStatusChange();
          };
          const onClose = () => {
            if (entry.dataChannel === ch) entry.dataChannel = null;
            entry.transport = "relay";
            emitStatusChange();
          };
          const onMsg = (mEvt) => {
            try {
              const raw = typeof mEvt === "string" ? mEvt : String(mEvt.data || "");
              const parsed = JSON.parse(raw);
              entry.recvChain = entry.recvChain
                .then(() => processClientFrame(fromClientId, parsed, "p2p"))
                .catch(() => {});
            } catch {
              // ignore malformed frame
            }
          };
          if (ch.readyState === "open") onOpen();
          ch.onopen = onOpen;
          ch.onclose = onClose;
          ch.onerror = onClose;
          ch.onmessage = onMsg;
        };
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWs({
          type: "signal.answer",
          target_client_id: fromClientId,
          signal_id: msg.signal_id || "",
          sdp: pc.localDescription || answer,
        });
      } catch {
        closePeerConnection(entry);
      }
      return;
    }

    if (msg.type === "signal.ice" && msg.candidate && entry.peerConnection) {
      try {
        await entry.peerConnection.addIceCandidate(msg.candidate);
      } catch {
        // ignore stale ICE candidate
      }
    }
  }

  function handleRelayMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "device.registered" && msg.ok) {
      state = "connected";
      lastError = "";
      reconnectAttempt = 0;
      const hbMs = Math.max(
        5000,
        Math.min(Number(msg.heartbeat_interval_ms) || heartbeatIntervalMs, 30000)
      );
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (identity && ws && ws.readyState === WebSocket.OPEN) {
          sendWs({
            type: "device.heartbeat",
            device_id: identity.device_id,
            candidates: getLanCandidates(),
          });
        }
      }, hbMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
      resolveConnectWaiters(true);
      emitStatusChange();
      return;
    }

    if (msg.type === "pair.created" && msg.ok) {
      const waiter = pendingPairCreates.shift();
      if (waiter) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      return;
    }

    if (msg.type === "pair.claim.request") {
      void handlePairClaimRequest(msg);
      return;
    }

    if (msg.type === "pair.approved_ack" && msg.ok) {
      void handlePairApprovedAck(msg);
      return;
    }

    if (msg.type === "remote.peer_offline") {
      const cid = String(msg.client_id || "");
      if (cid) {
        dropClientSession(cid);
        emitStatusChange();
      }
      return;
    }

    if (
      msg.type === "signal.probe"
      || msg.type === "signal.offer"
      || msg.type === "signal.answer"
      || msg.type === "signal.ice"
    ) {
      void handleSignalMessage(msg);
      return;
    }

    if (msg.type === "relay.frame") {
      const fromClientId = String(msg.from_client_id || "").trim();
      if (!fromClientId) return;
      const paired = getPairedClient(remoteDir, fromClientId);
      if (!paired || paired.revoked_at) {
        dropClientSession(fromClientId);
        sendWs({ type: "pair.revoke", client_id: fromClientId });
        return;
      }
      const entry = getOrCreateClientEntry(fromClientId, paired);
      entry.recvChain = entry.recvChain
        .then(() => processClientFrame(fromClientId, msg.frame, "relay"))
        .catch(() => {});
      return;
    }

    if (msg.type === "error") {
      const errText = String(msg.error || msg.code || "Relay error");
      lastError = errText;
      if (msg.code === "AUTH_TOKEN_INVALID" || msg.code === "DEVICE_REPLACED") {
        state = "error";
        resolveConnectWaiters(false, new Error(errText));
        emitStatusChange();
      } else if (pendingPairCreates.length > 0) {
        const waiter = pendingPairCreates.shift();
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error(errText));
      }
    }
  }

  function scheduleReconnect() {
    if (closed || !config.enabled) return;
    if (reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * Math.pow(2, Math.min(reconnectAttempt, 5)));
    reconnectAttempt += 1;
    state = "reconnecting";
    emitStatusChange();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed && config.enabled) {
        void connect().catch(() => {});
      }
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function disconnectSocket() {
    clearTimers();
    const prev = ws;
    ws = null;
    if (prev) {
      try {
        prev.removeAllListeners();
        prev.on("error", () => {});
        prev.terminate();
      } catch {
        // ignore
      }
    }
    dropAllClientSessions();
    rejectPendingPairCreates(new Error("Relay disconnected"));
    resolveConnectWaiters(false, new Error("Relay disconnected"));
  }

  async function connect() {
    if (closed) throw new Error("Remote bridge is closed");
    const id = await ensureIdentity();
    const relayUrl = validateRelayUrl(config.relay_url || DEFAULT_RELAY_URL, config.allow_insecure_ws);

    if (ws && ws.readyState === WebSocket.OPEN && state === "connected") {
      return true;
    }

    disconnectSocket();
    state = "connecting";
    lastError = "";
    emitStatusChange();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`Timed out connecting to relay ${relayUrl}`);
        lastError = err.message;
        state = "error";
        emitStatusChange();
        disconnectSocket();
        scheduleReconnect();
        reject(err);
      }, connectTimeoutMs);
      if (timer.unref) timer.unref();
      connectWaiters.push({ resolve, reject, timer });

      let socket;
      try {
        socket = new WebSocket(relayUrl);
      } catch (err) {
        lastError = err.message || String(err);
        state = "error";
        resolveConnectWaiters(false, err);
        emitStatusChange();
        return;
      }
      ws = socket;

      socket.on("open", () => {
        if (ws !== socket) return;
        sendWs({
          type: "device.register",
          device_id: id.device_id,
          device_name: id.device_name,
          public_key: id.public_key_jwk,
          candidates: getLanCandidates(),
          paired_clients: listActiveRelayPairDescriptors(remoteDir),
          ...(config.auth_token ? { token: config.auth_token } : {}),
        });
      });

      socket.on("message", (data) => {
        if (ws !== socket) return;
        handleRelayMessage(data);
      });

      socket.on("error", (err) => {
        if (ws !== socket) return;
        lastError = err?.message || String(err);
      });

      socket.on("close", () => {
        if (ws !== socket) return;
        ws = null;
        clearTimers();
        dropAllClientSessions();
        rejectPendingPairCreates(new Error("Relay connection closed"));
        if (connectWaiters.length > 0) {
          resolveConnectWaiters(false, new Error(lastError || "Relay connection closed"));
        }
        if (!closed && config.enabled) {
          scheduleReconnect();
        } else {
          state = "disabled";
          emitStatusChange();
        }
      });
    });
  }

  async function enable(patch = {}) {
    await ensureIdentity();
    const nextRelayUrl = patch.relay_url !== undefined ? patch.relay_url : config.relay_url;
    const nextAllowInsecure = patch.allow_insecure_ws !== undefined
      ? Boolean(patch.allow_insecure_ws)
      : config.allow_insecure_ws;
    validateRelayUrl(nextRelayUrl || DEFAULT_RELAY_URL, nextAllowInsecure);

    config = saveRemoteConfig(remoteDir, {
      ...patch,
      enabled: true,
    });
    reconnectAttempt = 0;
    try {
      await connect();
      return await getStatus();
    } catch (err) {
      lastError = err?.message || String(err);
      state = "error";
      emitStatusChange();
      return {
        ...(await getStatus()),
        ok: false,
        error: lastError,
      };
    }
  }

  async function disable() {
    config = saveRemoteConfig(remoteDir, { enabled: false });
    disconnectSocket();
    state = "disabled";
    lastError = "";
    emitStatusChange();
    return getStatus();
  }

  async function createPairing({ ttlMs = 300000, webBaseUrl = "" } = {}) {
    const id = await ensureIdentity();
    if (!config.enabled) {
      config = saveRemoteConfig(remoteDir, { enabled: true });
    }
    if (!ws || ws.readyState !== WebSocket.OPEN || state !== "connected") {
      await connect();
    }

    const pairCode = generatePairCode(8);
    const codeHash = await hashPairCode(pairCode);
    const pairId = `pair_${randomHex(8)}`;
    const clampedTtl = Math.max(5000, Math.min(Number(ttlMs) || 300000, 15 * 60 * 1000));

    const ack = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = pendingPairCreates.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) pendingPairCreates.splice(idx, 1);
        reject(new Error("Timed out creating pairing code on relay"));
      }, 6000);
      if (timer.unref) timer.unref();
      pendingPairCreates.push({ resolve, reject, timer });
      const sent = sendWs({
        type: "pair.create",
        pair_id: pairId,
        code_hash: codeHash,
        ttl_ms: clampedTtl,
      });
      if (!sent) {
        clearTimeout(timer);
        pendingPairCreates.pop();
        reject(new Error("Relay socket is not open"));
      }
    });

    const expiresAtMs = Date.parse(ack.expires_at) || (Date.now() + clampedTtl);
    activePairCodes.set(ack.pair_id || pairId, {
      pair_id: ack.pair_id || pairId,
      pair_code: pairCode,
      code_hash: codeHash,
      expires_at: expiresAtMs,
      used: false,
    });

    const resolvedWebBase = normalizeWebBaseUrl(webBaseUrl || config.web_base_url || DEFAULT_WEB_BASE_URL);
    const remoteUrl = buildRemoteWebUrl(resolvedWebBase, id.device_id);
    const deepUrl = buildDeepPairUrl({
      webBaseUrl: resolvedWebBase,
      relayUrl: config.relay_url || DEFAULT_RELAY_URL,
      deviceId: id.device_id,
      pairCode,
      fingerprint: id.fingerprint,
    });
    const qr = renderQrSvg(deepUrl);

    return {
      ok: true,
      pair_id: ack.pair_id || pairId,
      pair_code: pairCode,
      device_id: id.device_id,
      device_name: id.device_name,
      relay_url: config.relay_url || DEFAULT_RELAY_URL,
      remote_url: remoteUrl,
      deep_url: deepUrl,
      qr_svg: qr.svg,
      qr_data_url: qr.dataUrl,
      expires_at: ack.expires_at || new Date(expiresAtMs).toISOString(),
      fingerprint: id.fingerprint,
    };
  }

  async function listDevices({ includeRevoked = false } = {}) {
    const id = await ensureIdentity();
    const stored = listPairedClients(remoteDir, { includeRevoked });
    return {
      ok: true,
      device_id: id.device_id,
      devices: stored.map((item) => {
        const active = clientSessions.get(item.client_id);
        const isConnected = Boolean(active && active.session && active.session.ready);
        return {
          client_id: item.client_id,
          label: item.label,
          fingerprint: item.fingerprint,
          paired_at: item.paired_at,
          last_seen: item.last_seen,
          revoked_at: item.revoked_at || null,
          connected: isConnected,
          transport: isConnected ? active.transport : null,
        };
      }),
    };
  }

  async function revokeDevice(clientId) {
    const id = String(clientId || "").trim();
    if (!id) return { ok: false, error: "client_id is required" };
    const result = revokePairedClient(remoteDir, id);
    dropClientSession(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs({ type: "pair.revoke", client_id: id });
    }
    emitStatusChange();
    if (!result.ok) {
      return result;
    }
    const updated = await listDevices();
    return {
      ok: true,
      client_id: id,
      devices: updated.devices,
    };
  }

  function broadcast(envelope) {
    if (!envelope || typeof envelope !== "object" || clientSessions.size === 0) return;
    for (const entry of clientSessions.values()) {
      if (entry.session && entry.session.ready) {
        void enqueueEncryptedSend(entry, envelope);
      }
    }
  }

  async function startIfEnabled() {
    await ensureIdentity();
    config = loadRemoteConfig(remoteDir);
    if (!config.enabled) {
      state = "disabled";
      return false;
    }
    try {
      await connect();
      return true;
    } catch {
      scheduleReconnect();
      return false;
    }
  }

  async function close() {
    closed = true;
    disconnectSocket();
    activePairCodes.clear();
    pendingApprovals.clear();
  }

  return {
    PROTOCOL,
    ensureIdentity,
    getStatus,
    getStatusSync,
    enable,
    disable,
    createPairing,
    listDevices,
    revokeDevice,
    broadcast,
    startIfEnabled,
    close,
  };
}

module.exports = {
  DEFAULT_WEB_BASE_URL,
  BLOCKED_REMOTE_COMMANDS,
  getLanCandidates,
  validateRelayUrl,
  normalizeWebBaseUrl,
  buildRemoteWebUrl,
  isSameOriginDefaultRelay,
  buildDeepPairUrl,
  createRemoteRelayBridge,
};
