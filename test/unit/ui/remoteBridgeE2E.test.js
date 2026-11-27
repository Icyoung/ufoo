"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const WebSocket = require("ws");
const OnlineServer = require("../../../src/online/server");
const { startDesktopUiHost } = require("../../../src/ui/desktopUiHost");
const { createEnvelope, encodeMessage, decodeMessage } = require("../../../src/runtime/contracts/uiProtocol");
const {
  E2eeSession,
  generateEcdhKeyPair,
  hashPairCode,
  computeClaimProof,
  verifyHostProof,
  randomHex,
} = require("../../../src/online/remoteCrypto");

function makeTempDir(prefix = "ufoo-p5-e2e-") {
  const shortBase = process.platform === "darwin" && fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return fs.mkdtempSync(path.join(shortBase, prefix));
}

function connectLocalUiClient(socketPath, authToken) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const pending = new Map();
    const events = [];
    let buf = "";

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines.filter(Boolean)) {
        const decoded = decodeMessage(line);
        if (!decoded.ok) continue;
        const env = decoded.envelope;
        if (env.kind === "welcome") {
          resolve({
            socket,
            events,
            sendCommand(name, payload = {}) {
              const requestId = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
              return new Promise((res, rej) => {
                const timer = setTimeout(() => {
                  pending.delete(requestId);
                  rej(new Error(`Local command timeout: ${name}`));
                }, 5000);
                pending.set(requestId, { resolve: res, reject: rej, timer });
                socket.write(encodeMessage(createEnvelope({
                  kind: "command",
                  name,
                  requestId,
                  payload,
                })));
              });
            },
            close() {
              try { socket.destroy(); } catch {}
            },
          });
          continue;
        }
        if ((env.kind === "result" || env.kind === "error") && env.request_id && pending.has(env.request_id)) {
          const w = pending.get(env.request_id);
          pending.delete(env.request_id);
          clearTimeout(w.timer);
          if (env.kind === "error") w.reject(new Error(env.payload?.error || "error"));
          else w.resolve(env.payload);
          continue;
        }
        events.push(env);
      }
    });
    socket.on("error", reject);
    socket.once("connect", () => {
      socket.write(encodeMessage(createEnvelope({
        kind: "hello",
        payload: { auth_token: authToken, capabilities: ["chat", "desktop-host-v1"] },
      })));
    });
  });
}

/**
 * Lightweight mock remote E2EE client matching the exact browser RemoteE2eeTransport protocol.
 */
class MockRemoteE2eeClient {
  constructor(relayUrl) {
    this.relayUrl = relayUrl;
    this.ws = null;
    this.keyPair = null;
    this.clientId = `mobile_${randomHex(6)}`;
    this.deviceId = "";
    this.hostPublicKey = null;
    this.remoteToken = "";
    this.session = null;
    this.events = [];
    this.rawErrors = [];
    this.pendingCmds = new Map();
    this.eventWaiters = [];
    this.closed = false;
    this.onCloseWaiters = [];
  }

  async _openWs() {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.relayUrl);
      this.ws = ws;
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      ws.on("close", () => {
        this.closed = true;
        while (this.onCloseWaiters.length > 0) {
          this.onCloseWaiters.shift()();
        }
      });
    });
  }

  waitForClose(timeoutMs = 4000) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Timeout waiting for remote client close")), timeoutMs);
      this.onCloseWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async pair({ pairCode, deviceId = "", label = "iPhone E2E" }) {
    this.keyPair = await generateEcdhKeyPair();
    const ws = await this._openWs();
    const codeHash = await hashPairCode(pairCode);
    const clientNonce = randomHex(12);
    const claimProof = await computeClaimProof({
      pairCode,
      clientId: this.clientId,
      clientNonce,
      clientPublicKeyJwk: this.keyPair.publicKeyJwk,
    });

    const claimed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("pair.claim timeout")), 5000);
      const onMsg = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pair.claimed" && msg.ok) {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(msg);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          ws.off("message", onMsg);
          reject(new Error(`${msg.code}: ${msg.error}`));
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({
        type: "pair.claim",
        code_hash: codeHash,
        ...(deviceId ? { device_id: deviceId } : {}),
        client_id: this.clientId,
        label,
        client_public_key: this.keyPair.publicKeyJwk,
        client_nonce: clientNonce,
        claim_proof: claimProof,
      }));
    });

    const hostValid = await verifyHostProof({
      pairCode,
      deviceId: claimed.device_id,
      clientId: this.clientId,
      clientNonce,
      hostNonce: claimed.host_nonce,
      hostPublicKeyJwk: claimed.host_public_key,
      hostProof: claimed.host_proof,
    });
    if (!hostValid) throw new Error("Host proof verification failed");

    this.deviceId = claimed.device_id;
    this.hostPublicKey = claimed.host_public_key;
    this.remoteToken = claimed.remote_token;

    await this._startE2eeOverRelay();
    return claimed;
  }

  async reconnect() {
    const ws = await this._openWs();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("remote.auth timeout")), 5000);
      const onMsg = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "remote.auth_ok" && msg.ok) {
          clearTimeout(timer);
          ws.off("message", onMsg);
          resolve(msg);
        } else if (msg.type === "error") {
          clearTimeout(timer);
          ws.off("message", onMsg);
          reject(new Error(`${msg.code}: ${msg.error}`));
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify({
        type: "remote.auth",
        device_id: this.deviceId,
        client_id: this.clientId,
        remote_token: this.remoteToken,
      }));
    });
    await this._startE2eeOverRelay();
  }

  async _startE2eeOverRelay() {
    this.session = new E2eeSession({
      role: "client",
      deviceId: this.deviceId,
      clientId: this.clientId,
      localPrivateKeyJwk: this.keyPair.privateKeyJwk,
      peerPublicKeyJwk: this.hostPublicKey,
    });
    const initFrame = await this.session.createHandshakeInit();
    let recvChain = Promise.resolve();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("E2EE hs_ack timeout")), 5000);
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          this.rawErrors.push(msg);
          return;
        }
        if (msg.type !== "relay.frame") return;
        const frame = msg.frame;
        if (frame && frame.t === "hs_ack") {
          recvChain = recvChain.then(async () => {
            await this.session.completeHandshakeAck(frame);
            clearTimeout(timer);
            resolve();
          }).catch(reject);
          return;
        }
        if (frame && frame.t === "msg") {
          recvChain = recvChain.then(async () => {
            const env = await this.session.decryptJson(frame);
            if ((env.kind === "result" || env.kind === "error") && env.request_id && this.pendingCmds.has(env.request_id)) {
              const w = this.pendingCmds.get(env.request_id);
              this.pendingCmds.delete(env.request_id);
              clearTimeout(w.timer);
              if (env.kind === "error") w.reject(new Error(env.payload?.error || "remote command error"));
              else w.resolve(env.payload);
              return;
            }
            this.events.push(env);
            for (let i = this.eventWaiters.length - 1; i >= 0; i -= 1) {
              const w = this.eventWaiters[i];
              if (w.predicate(env)) {
                this.eventWaiters.splice(i, 1);
                clearTimeout(w.timer);
                w.resolve(env);
              }
            }
          }).catch(() => {});
        }
      });

      this.ws.send(JSON.stringify({
        type: "relay.frame",
        device_id: this.deviceId,
        frame: initFrame,
      }));
    });
  }

  waitForEvent(predicate, timeoutMs = 5000) {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for remote E2EE event")), timeoutMs);
      this.eventWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  async sendCommand(name, payload = {}) {
    const requestId = `rem-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const frame = await this.session.encryptJson(createEnvelope({
      kind: "command",
      name,
      requestId,
      payload,
    }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(requestId);
        reject(new Error(`Remote command timeout: ${name}`));
      }, 5000);
      this.pendingCmds.set(requestId, { resolve, reject, timer });
      this.ws.send(JSON.stringify({
        type: "relay.frame",
        device_id: this.deviceId,
        frame,
      }));
    });
  }

  close() {
    if (this.ws) {
      try { this.ws.terminate(); } catch {}
      this.ws = null;
    }
  }
}

describe("Phase 5 End-to-End Integration: Remote E2EE Client <-> ufoo-online <-> desktopUiHost", () => {
  test("pairs over Zero-Knowledge relay, syncs app.snapshot + ui.events.since, submits prompt, approves interaction, and disconnects on revocation", async () => {
    const tmp = makeTempDir();
    const projectDir = path.join(tmp, "demo-proj");
    const controllerDir = path.join(tmp, "controller");
    const remoteDir = path.join(tmp, "remote");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "README.md"), "# Phase 5 E2E Repo\n", "utf8");
    fs.mkdirSync(path.join(controllerDir, ".ufoo", "run"), { recursive: true });

    // Capture daemon requests + keep the persistent daemonConnection socket handle to push interaction requests
    const daemonRequests = [];
    let promptDaemonSocket = null;
    const daemonSock = path.join(tmp, "ufoo.sock");
    const fakeDaemon = net.createServer((socket) => {
      socket.on("error", (err) => {
        if (!["EPIPE", "ECONNRESET"].includes(err.code)) throw err;
      });
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          const req = JSON.parse(line);
          daemonRequests.push(req);
          if (req.type === "status") {
            socket.write(`${JSON.stringify({
              type: "status",
              data: {
                projectRoot: req.project_root || projectDir,
                active: ["ucode:11223344"],
                active_meta: [
                  {
                    id: "ucode:11223344",
                    nickname: "ucode-1",
                    agent_type: "ucode",
                    launch_mode: "internal",
                    activity_state: "idle",
                  },
                ],
              },
            })}\n`);
          } else if (req.type === "list_recoverable_agents") {
            socket.write(`${JSON.stringify({
              type: "response",
              data: { recoverable: { recoverable: [], groups: [] } },
            })}\n`);
          } else if (req.type === "prompt") {
            promptDaemonSocket = socket;
            socket.write(`${JSON.stringify({
              type: "runtime_event",
              data: {
                type: "task.started",
                agentId: "ufoo-agent",
                sessionId: "main-default",
                taskRunId: "run-e2e-1",
                sequence: 1,
              },
            })}\n`);
          }
        }
      });
    });
    await new Promise((resolve) => fakeDaemon.listen(daemonSock, resolve));
    fs.symlinkSync(daemonSock, path.join(controllerDir, ".ufoo", "run", "ufoo.sock"));

    // Start real ufoo-online server and spy on all forwarded relay.frame payloads for Zero-Knowledge verification
    const onlineServer = new OnlineServer({
      host: "127.0.0.1",
      port: 0,
      tokens: ["e2e-relay-token"],
    });
    const observedRelayPayloads = [];
    const origHandleRelay = onlineServer.handleRelayFrame.bind(onlineServer);
    onlineServer.handleRelayFrame = (client, message) => {
      observedRelayPayloads.push(JSON.stringify(message));
      return origHandleRelay(client, message);
    };
    await onlineServer.start();
    const relayUrl = `ws://127.0.0.1:${onlineServer.port}/ufoo/online`;

    const prevControllerEnv = process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
    process.env.UFOO_GLOBAL_CONTROLLER_ROOT = controllerDir;

    let hostHandle = null;
    let localUi = null;
    let remoteClient = null;
    try {
      hostHandle = await startDesktopUiHost({
        controllerRoot: controllerDir,
        initialProjectRoot: projectDir,
        socketPath: path.join(tmp, "ui.sock"),
        authToken: "local-ui-secret",
        enableHandoffServer: false,
        remoteDir,
        remoteRelayUrl: relayUrl,
        remoteAuthToken: "e2e-relay-token",
        remoteAllowInsecureWs: true,
        isRunning: () => true,
        startDaemon: () => {},
        stopDaemon: () => {},
      });

      localUi = await connectLocalUiClient(hostHandle.socketPath, hostHandle.authToken);

      // 1. Check remote.status & generate pairing code + QR over desktopUiHost RPC
      const status = await localUi.sendCommand("remote.status");
      expect(status.ok).toBe(true);
      expect(status.enabled).toBe(true);
      expect(status.connected).toBe(true);
      expect(status.device_id).toMatch(/^dev_/);

      const ticket = await localUi.sendCommand("remote.pair.create", {
        web_base_url: "https://remote.ufoo.test",
      });
      expect(ticket.ok).toBe(true);
      expect(ticket.pair_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(ticket.remote_url).toBe(`https://remote.ufoo.test/remote/${ticket.device_id}`);
      expect(ticket.deep_url).toContain(`https://remote.ufoo.test/remote/${ticket.device_id}?`);
      expect(ticket.deep_url).toContain("relay=");
      expect(ticket.deep_url).not.toContain("device=");
      expect(ticket.qr_svg).toContain("<svg");
      expect(ticket.qr_data_url).toMatch(/^data:image\/svg\+xml;base64,/);

      // Same-origin relay matches web_base_url host -> omit redundant relay= query param
      const { buildDeepPairUrl } = require("../../../src/ui/remoteRelayBridge");
      const sameOriginDeepUrl = buildDeepPairUrl({
        webBaseUrl: "https://online.ufoo.dev",
        relayUrl: "wss://online.ufoo.dev/ufoo/online",
        deviceId: ticket.device_id,
        pairCode: ticket.pair_code,
        fingerprint: ticket.fingerprint,
      });
      expect(sameOriginDeepUrl).toBe(
        `https://online.ufoo.dev/remote/${ticket.device_id}?pair=${ticket.pair_code}&fp=${ticket.fingerprint}`
      );
      expect(sameOriginDeepUrl).not.toContain("relay=");
      expect(sameOriginDeepUrl).not.toContain("device=");

      // 2. Pair mock remote client via real ufoo-online server
      remoteClient = new MockRemoteE2eeClient(relayUrl);
      await remoteClient.pair({ pairCode: ticket.pair_code, deviceId: ticket.device_id });

      // 3. Request resync over E2EE -> verify decrypted app.snapshot & projects.tree
      const resyncRes = await remoteClient.sendCommand("ui.resync.request", {});
      expect(resyncRes.ok).toBe(true);
      const snapshotEnv = await remoteClient.waitForEvent((e) => e.name === "app.snapshot");
      expect(snapshotEnv.payload.active_root).toBe(fs.realpathSync(projectDir));
      expect(Array.isArray(snapshotEnv.payload.projects)).toBe(true);
      const seqAfterSync = Number(snapshotEnv.seq || 0);
      expect(seqAfterSync).toBeGreaterThan(0);

      // 4. Submit remote prompt over E2EE -> verify GlobalDaemon receives exact prompt text
      const secretPrompt = "REMOTE_E2EE_CONFIDENTIAL_PROMPT_9981";
      const submitRes = await remoteClient.sendCommand("input.submit", {
        text: secretPrompt,
        input_target: "main",
      });
      expect(submitRes.ok).toBe(true);
      const promptReq = daemonRequests.find((r) => r.type === "prompt" && String(r.text || "").includes(secretPrompt));
      expect(promptReq).toBeDefined();

      // 5. Push a pending approval interaction from daemon -> verify remote client receives it and approves it!
      expect(promptDaemonSocket).toBeTruthy();
      promptDaemonSocket.write(`${JSON.stringify({
        type: "runtime_event",
        data: {
          type: "task.paused",
          agentId: "ufoo-agent",
          projectRoot: fs.realpathSync(projectDir),
          sessionId: "main-default",
          taskRunId: "run-e2e-1",
          sequence: 2,
          result: {
            executionState: {
              pendingUserInteraction: {
                id: "int-approve-77",
                kind: "approval",
                prompt: "Run shell command: `npm test`?",
                options: [
                  { key: "1", label: "Allow once" },
                  { key: "2", label: "Always allow" },
                ],
                allowFreeChat: true,
              },
            },
          },
        },
      })}\n`);

      const interactionEvt = await remoteClient.waitForEvent(
        (e) => e.name === "interaction.request" && e.payload?.id === "int-approve-77"
      );
      expect(interactionEvt.payload.prompt).toContain("npm test");
      expect(Array.isArray(interactionEvt.payload.queue)).toBe(true);
      expect(interactionEvt.payload.queue.length).toBeGreaterThanOrEqual(1);

      const approveRes = await remoteClient.sendCommand("interaction.respond", {
        id: "int-approve-77",
        text: "1",
      });
      expect(approveRes.ok).toBe(true);

      const resumeReq = daemonRequests.find(
        (r) => r.type === "agent_runtime" && r.operation === "resume" && r.interaction_id === "int-approve-77"
      );
      expect(resumeReq).toBeDefined();
      expect(resumeReq.answer).toBe("1");

      // 6. Disconnect & reconnect remote client -> verify ui.events.since catches up missed seqs!
      const lastSeqBeforeDrop = Math.max(...remoteClient.events.map((e) => Number(e.seq || 0)));
      remoteClient.close();
      await remoteClient.waitForClose();

      // Emit a local event while remote is disconnected
      await localUi.sendCommand("status.noop_check").catch(() => {});
      // Trigger a real published event (e.g. window.set) while remote is offline
      await localUi.sendCommand("window.set", { mode: "main" });

      await remoteClient.reconnect();
      const catchup = await remoteClient.sendCommand("ui.events.since", { seq: Math.max(0, lastSeqBeforeDrop - 2) });
      expect(catchup.ok).toBe(true);
      expect(Array.isArray(catchup.events)).toBe(true);
      expect(catchup.events.length).toBeGreaterThan(0);
      expect(catchup.latest_seq).toBeGreaterThanOrEqual(lastSeqBeforeDrop);

      // 7. Zero-Knowledge relay verification: relay NEVER saw plaintext prompts, approvals, or project paths!
      const allObservedWire = observedRelayPayloads.join("\n");
      expect(observedRelayPayloads.length).toBeGreaterThan(4);
      expect(allObservedWire).not.toContain(secretPrompt);
      expect(allObservedWire).not.toContain("npm test");
      expect(allObservedWire).not.toContain("int-approve-77");
      expect(allObservedWire).not.toContain("app.snapshot");
      expect(allObservedWire).not.toContain("input.submit");

      // 8. Revoke device from desktopUiHost -> active remote client immediately disconnected & reconnect denied!
      const listed = await localUi.sendCommand("remote.devices.list");
      expect(listed.ok).toBe(true);
      expect(listed.devices.some((d) => d.client_id === remoteClient.clientId && d.connected)).toBe(true);

      const revoked = await localUi.sendCommand("remote.devices.revoke", { client_id: remoteClient.clientId });
      expect(revoked.ok).toBe(true);
      await remoteClient.waitForClose();
      expect(remoteClient.rawErrors.some((e) => e.code === "CLIENT_REVOKED")).toBe(true);

      await expect(remoteClient.reconnect()).rejects.toThrow(/CLIENT_REVOKED/);
    } finally {
      if (prevControllerEnv === undefined) delete process.env.UFOO_GLOBAL_CONTROLLER_ROOT;
      else process.env.UFOO_GLOBAL_CONTROLLER_ROOT = prevControllerEnv;
      if (remoteClient) remoteClient.close();
      if (localUi) localUi.close();
      if (hostHandle) await hostHandle.close();
      await onlineServer.stop();
      await new Promise((resolve) => fakeDaemon.close(resolve));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20000);

  test("supports P2P WebRTC DataChannel E2EE upgrade via ufoo-online signaling when host & client expose RTCPeerConnection", async () => {
    const tmp = makeTempDir("ufoo-p5-p2p-");
    const onlineServer = new OnlineServer({ host: "127.0.0.1", port: 0, insecure: true });
    await onlineServer.start();
    const relayUrl = `ws://127.0.0.1:${onlineServer.port}/ufoo/online`;

    const { createRemoteRelayBridge } = require("../../../src/ui/remoteRelayBridge");

    // Minimal linked in-memory MockRTCPeerConnection pair to verify full signaling + DataChannel E2EE flow
    const peers = [];
    class MockDataChannel {
      constructor(label) {
        this.label = label;
        this.readyState = "connecting";
        this.peer = null;
        this.onopen = null;
        this.onclose = null;
        this.onmessage = null;
      }
      send(data) {
        if (this.readyState !== "open" || !this.peer) throw new Error("Channel not open");
        setImmediate(() => this.peer.onmessage?.({ data }));
      }
      close() {
        this.readyState = "closed";
        this.onclose?.();
      }
    }
    class MockRTCPeerConnection {
      constructor() {
        this.localDescription = null;
        this.remoteDescription = null;
        this.onicecandidate = null;
        this.ondatachannel = null;
        this._dc = null;
        peers.push(this);
      }
      createDataChannel(label) {
        this._dc = new MockDataChannel(label);
        return this._dc;
      }
      async createOffer() { return { type: "offer", sdp: "mock-offer-sdp" }; }
      async createAnswer() { return { type: "answer", sdp: "mock-answer-sdp" }; }
      async setLocalDescription(desc) {
        this.localDescription = desc;
        setImmediate(() => this.onicecandidate?.({ candidate: { candidate: "candidate:mock-lan" } }));
      }
      async setRemoteDescription(desc) {
        this.remoteDescription = desc;
        if (desc.type === "answer" && peers.length === 2) {
          const [clientPc, hostPc] = peers;
          const hostDc = new MockDataChannel("ufoo-e2ee");
          const clientDc = clientPc._dc;
          clientDc.peer = hostDc;
          hostDc.peer = clientDc;
          clientDc.readyState = "open";
          hostDc.readyState = "open";
          hostPc.ondatachannel?.({ channel: hostDc });
          clientDc.onopen?.();
        }
      }
      async addIceCandidate() {}
      close() {
        if (this._dc) this._dc.close();
      }
    }

    const bridge = createRemoteRelayBridge({
      remoteDir: tmp,
      dispatchCommand: async (env) => ({ ok: true, echoed: env.payload?.msg || "" }),
      rtcPeerConnectionFactory: () => new MockRTCPeerConnection(),
    });

    let ws = null;
    try {
      await bridge.enable({ relay_url: relayUrl, allow_insecure_ws: true });
      const ticket = await bridge.createPairing();

      // Pair via WS, probe signaling, negotiate WebRTC DataChannel, then run E2EE purely over P2P DataChannel!
      const clientKp = await generateEcdhKeyPair();
      const clientId = "p2p_web_1";
      const clientNonce = randomHex(12);
      const codeHash = await hashPairCode(ticket.pair_code);
      const claimProof = await computeClaimProof({
        pairCode: ticket.pair_code,
        clientId,
        clientNonce,
        clientPublicKeyJwk: clientKp.publicKeyJwk,
      });

      ws = new WebSocket(relayUrl);
      await new Promise((res) => ws.once("open", res));
      const inbox = [];
      const waiters = [];
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (waiters.length) waiters.shift()(m);
        else inbox.push(m);
      });
      const nextMsg = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r));

      ws.send(JSON.stringify({
        type: "pair.claim",
        code_hash: codeHash,
        client_id: clientId,
        label: "P2P Browser",
        client_public_key: clientKp.publicKeyJwk,
        client_nonce: clientNonce,
        claim_proof: claimProof,
      }));
      const claimed = await nextMsg();
      expect(claimed.type).toBe("pair.claimed");

      // Signal probe -> host advertises webrtc_supported: true
      ws.send(JSON.stringify({ type: "signal.probe", device_id: claimed.device_id, signal_id: "p1", probe: { webrtc: true } }));
      const probeRes = await nextMsg();
      expect(probeRes.type).toBe("signal.probe");
      expect(probeRes.probe.webrtc_supported).toBe(true);

      // Negotiate MockRTCPeerConnection via signal.offer / signal.answer
      const clientPc = new MockRTCPeerConnection();
      const dc = clientPc.createDataChannel("ufoo-e2ee");
      const offer = await clientPc.createOffer();
      await clientPc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: "signal.offer", device_id: claimed.device_id, signal_id: "p1", sdp: offer }));

      let answerMsg = null;
      for (let i = 0; i < 4; i += 1) {
        const m = await nextMsg();
        if (m.type === "signal.answer") { answerMsg = m; break; }
      }
      expect(answerMsg?.sdp?.type).toBe("answer");
      await clientPc.setRemoteDescription(answerMsg.sdp);
      expect(dc.readyState).toBe("open");

      // Run E2EE handshake + encrypted command directly over P2P DataChannel (bypassing relay.frame!)
      const session = new E2eeSession({
        role: "client",
        deviceId: claimed.device_id,
        clientId,
        localPrivateKeyJwk: clientKp.privateKeyJwk,
        peerPublicKeyJwk: claimed.host_public_key,
      });

      const dcMessages = [];
      const dcWaiters = [];
      dc.onmessage = (evt) => {
        const parsed = JSON.parse(evt.data);
        if (dcWaiters.length) dcWaiters.shift()(parsed);
        else dcMessages.push(parsed);
      };
      const nextDc = () => dcMessages.length ? Promise.resolve(dcMessages.shift()) : new Promise((r) => dcWaiters.push(r));

      dc.send(JSON.stringify(await session.createHandshakeInit()));
      const ack = await nextDc();
      expect(ack.t).toBe("hs_ack");
      await session.completeHandshakeAck(ack);

      const encCmd = await session.encryptJson(createEnvelope({
        kind: "command",
        name: "ping.p2p",
        requestId: "r-p2p-1",
        payload: { msg: "hello-over-p2p-e2ee" },
      }));
      dc.send(JSON.stringify(encCmd));
      const encResp = await nextDc();
      const resp = await session.decryptJson(encResp);
      expect(resp.kind).toBe("result");
      expect(resp.payload).toEqual({ ok: true, echoed: "hello-over-p2p-e2ee" });

      // Confirm host reports transport: "p2p"
      const devs = await bridge.listDevices();
      expect(devs.devices[0].connected).toBe(true);
      expect(devs.devices[0].transport).toBe("p2p");
    } finally {
      if (ws) try { ws.terminate(); } catch {}
      await bridge.close();
      await onlineServer.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 15000);
});
