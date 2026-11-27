"use strict";

const WebSocket = require("ws");
const OnlineServer = require("../../../src/online/server");
const {
  generateEcdhKeyPair,
  generatePairCode,
  hashPairCode,
  computeClaimProof,
  computeHostProof,
  verifyHostProof,
} = require("../../../src/online/remoteCrypto");

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = [];
    const waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiters.length > 0) {
        const w = waiters.shift();
        clearTimeout(w.timer);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.nextMessage = (timeoutMs = 3000) => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((x) => x.resolve === res);
          if (idx >= 0) waiters.splice(idx, 1);
          rej(new Error("Timeout waiting for WS message"));
        }, timeoutMs);
        waiters.push({ resolve: res, reject: rej, timer });
      });
    };
    ws.sendJson = (obj) => ws.send(JSON.stringify(obj));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws, timeoutMs = 3000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for WS close")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("ufoo-online Phase 5 Server: Devices, Pairing, Signaling & Zero-Knowledge Relay", () => {
  let server;
  let wsUrl;
  let openSockets = [];

  beforeEach(async () => {
    openSockets = [];
    server = new OnlineServer({
      host: "127.0.0.1",
      port: 0,
      tokens: ["host-secret-token"],
      maxRelayFrameBytes: 4096,
    });
    await server.start();
    wsUrl = `ws://127.0.0.1:${server.port}/ufoo/online`;
  });

  afterEach(async () => {
    for (const s of openSockets) {
      try { s.terminate(); } catch {}
    }
    openSockets = [];
    if (server) {
      await server.stop();
      server = null;
    }
  });

  async function connectSocket() {
    const ws = await openWs(wsUrl);
    openSockets.push(ws);
    return ws;
  }

  test("device.register enforces auth token, updates heartbeat & exposes candidates only to authorized peers", async () => {
    const hostKp = await generateEcdhKeyPair();

    // Reject invalid token
    const badHost = await connectSocket();
    badHost.sendJson({
      type: "device.register",
      device_id: "dev_mac_1",
      device_name: "MacBook",
      public_key: hostKp.publicKeyJwk,
      token: "wrong-token",
    });
    const badRes = await badHost.nextMessage();
    expect(badRes.type).toBe("error");
    expect(badRes.code).toBe("AUTH_TOKEN_INVALID");
    await waitForClose(badHost);

    // Valid registration
    const host = await connectSocket();
    host.sendJson({
      type: "device.register",
      device_id: "dev_mac_1",
      device_name: "MacBook",
      public_key: hostKp.publicKeyJwk,
      candidates: [{ kind: "lan", address: "192.168.1.50" }],
      token: "host-secret-token",
    });
    const regAck = await host.nextMessage();
    expect(regAck.type).toBe("device.registered");
    expect(regAck.ok).toBe(true);
    expect(regAck.device_id).toBe("dev_mac_1");

    // Heartbeat updates candidates
    host.sendJson({
      type: "device.heartbeat",
      device_id: "dev_mac_1",
      candidates: [{ kind: "lan", address: "192.168.1.51" }],
    });
    const hbAck = await host.nextMessage();
    expect(hbAck.type).toBe("device.heartbeat_ack");
    expect(hbAck.ok).toBe(true);

    // Owner querying device.status sees candidates
    host.sendJson({ type: "device.status", device_id: "dev_mac_1" });
    const ownerStatus = await host.nextMessage();
    expect(ownerStatus.online).toBe(true);
    expect(ownerStatus.candidates).toEqual([{ kind: "lan", address: "192.168.1.51" }]);

    // Unrelated authenticated agent sees online status but NOT private LAN candidates
    const agent = await connectSocket();
    agent.sendJson({ type: "hello", client: { subscriber_id: "ag:1", nickname: "bob" } });
    await agent.nextMessage(); // hello_ack
    await agent.nextMessage(); // auth_required
    agent.sendJson({ type: "auth", method: "token", token: "host-secret-token" });
    await agent.nextMessage(); // auth_ok

    agent.sendJson({ type: "device.status", device_id: "dev_mac_1" });
    const otherStatus = await agent.nextMessage();
    expect(otherStatus.online).toBe(true);
    expect(otherStatus.candidates).toBeUndefined();
  });

  test("one-time pairing create/claim/approve/expiry/replay & host rejection work securely", async () => {
    const hostKp = await generateEcdhKeyPair();
    const clientKp = await generateEcdhKeyPair();
    const host = await connectSocket();

    host.sendJson({
      type: "device.register",
      device_id: "dev_mac_2",
      device_name: "Studio",
      public_key: hostKp.publicKeyJwk,
      token: "host-secret-token",
    });
    await host.nextMessage();

    // 1. Short-lived pairing expiry test
    const expCode = generatePairCode(8);
    const expHash = await hashPairCode(expCode);
    host.sendJson({ type: "pair.create", code_hash: expHash, ttl_ms: 60 });
    const expCreated = await host.nextMessage();
    expect(expCreated.type).toBe("pair.created");

    await new Promise((r) => setTimeout(r, 90));
    const lateClient = await connectSocket();
    lateClient.sendJson({
      type: "pair.claim",
      code_hash: expHash,
      client_id: "web_late",
      client_public_key: clientKp.publicKeyJwk,
    });
    const expErr = await lateClient.nextMessage();
    expect(expErr.code).toBe("PAIR_CODE_EXPIRED");

    // 2. Host rejection test
    const rejCode = generatePairCode(8);
    const rejHash = await hashPairCode(rejCode);
    host.sendJson({ type: "pair.create", code_hash: rejHash, ttl_ms: 10000 });
    await host.nextMessage();

    const badClient = await connectSocket();
    badClient.sendJson({
      type: "pair.claim",
      code_hash: rejHash,
      client_id: "web_bad",
      client_public_key: clientKp.publicKeyJwk,
      claim_proof: "bad-proof",
    });
    const rejReq = await host.nextMessage();
    expect(rejReq.type).toBe("pair.claim.request");
    host.sendJson({ type: "pair.reject", claim_id: rejReq.claim_id, reason: "Proof mismatch" });
    expect((await host.nextMessage()).type).toBe("pair.rejected_ack");
    const badClientErr = await badClient.nextMessage();
    expect(badClientErr.code).toBe("PAIR_REJECTED");

    // 3. Valid one-time pairing + proof exchange + second claim blocked (PAIR_CODE_USED)
    const code = generatePairCode(8);
    const codeHash = await hashPairCode(code);
    host.sendJson({ type: "pair.create", code_hash: codeHash, ttl_ms: 60000 });
    const created = await host.nextMessage();
    expect(created.ok).toBe(true);

    const client = await connectSocket();
    const claimProof = await computeClaimProof({
      pairCode: code,
      clientId: "iphone_1",
      clientNonce: "cn1",
      clientPublicKeyJwk: clientKp.publicKeyJwk,
    });
    client.sendJson({
      type: "pair.claim",
      code_hash: codeHash,
      client_id: "iphone_1",
      label: "My iPhone",
      client_public_key: clientKp.publicKeyJwk,
      client_nonce: "cn1",
      claim_proof: claimProof,
    });

    const claimReq = await host.nextMessage();
    expect(claimReq.type).toBe("pair.claim.request");
    expect(claimReq.client_id).toBe("iphone_1");

    // Reusing the exact same code while/after claimed must fail immediately
    const secondClient = await connectSocket();
    secondClient.sendJson({
      type: "pair.claim",
      code_hash: codeHash,
      client_id: "iphone_2",
      client_public_key: clientKp.publicKeyJwk,
    });
    const usedErr = await secondClient.nextMessage();
    expect(usedErr.code).toBe("PAIR_CODE_USED");

    const hostProof = await computeHostProof({
      pairCode: code,
      deviceId: "dev_mac_2",
      clientId: "iphone_1",
      clientNonce: "cn1",
      hostNonce: "hn1",
      hostPublicKeyJwk: hostKp.publicKeyJwk,
    });
    host.sendJson({
      type: "pair.approve",
      claim_id: claimReq.claim_id,
      host_public_key: hostKp.publicKeyJwk,
      host_nonce: "hn1",
      host_proof: hostProof,
    });

    const approvedAck = await host.nextMessage();
    expect(approvedAck.type).toBe("pair.approved_ack");
    expect(approvedAck.token_hash).toBeTruthy();

    const claimed = await client.nextMessage();
    expect(claimed.type).toBe("pair.claimed");
    expect(claimed.ok).toBe(true);
    expect(claimed.remote_token).toBeTruthy();
    expect(await verifyHostProof({
      pairCode: code,
      deviceId: "dev_mac_2",
      clientId: "iphone_1",
      clientNonce: "cn1",
      hostNonce: claimed.host_nonce,
      hostPublicKeyJwk: claimed.host_public_key,
      hostProof: claimed.host_proof,
    })).toBe(true);
  });

  test("forwards P2P signaling & opaque E2EE relay frames, enforces size/auth limits, and disconnects revoked clients", async () => {
    const hostKp = await generateEcdhKeyPair();
    const clientKp = await generateEcdhKeyPair();

    const host = await connectSocket();
    host.sendJson({
      type: "device.register",
      device_id: "dev_mac_3",
      device_name: "MacMini",
      public_key: hostKp.publicKeyJwk,
      token: "host-secret-token",
    });
    await host.nextMessage();

    // Pair client
    host.sendJson({ type: "pair.create", ttl_ms: 60000 });
    const created = await host.nextMessage();
    expect(created.pair_code).toBeTruthy();

    const client = await connectSocket();
    client.sendJson({
      type: "pair.claim",
      code: created.pair_code,
      client_id: "web_client_1",
      label: "Safari Mobile",
      client_public_key: clientKp.publicKeyJwk,
    });
    const claimReq = await host.nextMessage();
    host.sendJson({ type: "pair.approve", claim_id: claimReq.claim_id });
    await host.nextMessage(); // pair.approved_ack
    const claimed = await client.nextMessage();
    const remoteToken = claimed.remote_token;

    // 1. P2P signaling forwarding: probe, offer, answer, ice
    client.sendJson({ type: "signal.probe", device_id: "dev_mac_3", signal_id: "s1", probe: { webrtc: true } });
    const probeAtHost = await host.nextMessage();
    expect(probeAtHost).toMatchObject({ type: "signal.probe", from_client_id: "web_client_1", signal_id: "s1" });

    host.sendJson({ type: "signal.answer", target_client_id: "web_client_1", signal_id: "s1", sdp: { type: "answer", sdp: "v=0" } });
    const ansAtClient = await client.nextMessage();
    expect(ansAtClient).toMatchObject({ type: "signal.answer", device_id: "dev_mac_3", sdp: { type: "answer", sdp: "v=0" } });

    client.sendJson({ type: "signal.ice", device_id: "dev_mac_3", signal_id: "s1", candidate: { candidate: "candidate:1" } });
    const iceAtHost = await host.nextMessage();
    expect(iceAtHost).toMatchObject({ type: "signal.ice", from_client_id: "web_client_1" });

    // 2. Zero-Knowledge opaque relay.frame forwarding both ways
    const opaqueFrame = { v: 1, t: "msg", sid: "s", dir: "c2h", ctr: 1, ct: "OPAQUE_CIPHERTEXT_BYTES" };
    client.sendJson({ type: "relay.frame", device_id: "dev_mac_3", frame: opaqueFrame });
    const relAtHost = await host.nextMessage();
    expect(relAtHost.type).toBe("relay.frame");
    expect(relAtHost.from_client_id).toBe("web_client_1");
    expect(relAtHost.frame).toEqual(opaqueFrame);

    // Oversized relay frame rejected
    client.sendJson({ type: "relay.frame", device_id: "dev_mac_3", frame: { ct: "A".repeat(5000) } });
    const sizeErr = await client.nextMessage();
    expect(sizeErr.code).toBe("RELAY_FRAME_TOO_LARGE");

    // 3. Unpaired/unauthenticated socket cannot send relay.frame or signal.offer
    const stranger = await connectSocket();
    stranger.sendJson({ type: "relay.frame", device_id: "dev_mac_3", frame: { ct: "x" } });
    expect((await stranger.nextMessage()).code).toBe("UNAUTHORIZED");

    // 4. Reconnect with remote.auth works with valid token, rejects wrong token
    const badReconnect = await connectSocket();
    badReconnect.sendJson({
      type: "remote.auth",
      device_id: "dev_mac_3",
      client_id: "web_client_1",
      remote_token: "forged-token",
    });
    expect((await badReconnect.nextMessage()).code).toBe("REMOTE_AUTH_INVALID");
    await waitForClose(badReconnect);

    const goodReconnect = await connectSocket();
    goodReconnect.sendJson({
      type: "remote.auth",
      device_id: "dev_mac_3",
      client_id: "web_client_1",
      remote_token: remoteToken,
    });
    const authOk = await goodReconnect.nextMessage();
    expect(authOk.type).toBe("remote.auth_ok");
    expect(authOk.ok).toBe(true);
    const onlineNotice = await host.nextMessage();
    expect(onlineNotice.type).toBe("remote.peer_online");

    // 5. Revocation disconnects all active sessions and blocks future remote.auth
    host.sendJson({ type: "pair.revoke", client_id: "web_client_1" });
    expect((await host.nextMessage()).type).toBe("pair.revoked");
    expect((await client.nextMessage()).code).toBe("CLIENT_REVOKED");
    expect((await goodReconnect.nextMessage()).code).toBe("CLIENT_REVOKED");
    await Promise.all([waitForClose(client), waitForClose(goodReconnect)]);

    const postRevoke = await connectSocket();
    postRevoke.sendJson({
      type: "remote.auth",
      device_id: "dev_mac_3",
      client_id: "web_client_1",
      remote_token: remoteToken,
    });
    expect((await postRevoke.nextMessage()).code).toBe("CLIENT_REVOKED");
    await waitForClose(postRevoke);
  });

  test("CLI runOnlineRemote supports status, enable, pair (--no-wait), devices, revoke, and disable", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { runOnlineRemote } = require("../../../src/app/cli/onlineCoreCommands");
    const { upsertPairedClient } = require("../../../src/online/remoteStore");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cli-rem-"));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      const status = await runOnlineRemote("status", "", { remoteDir: tmp, json: true });
      expect(status.ok).toBe(true);
      expect(status.enabled).toBe(false);
      expect(status.device_id).toMatch(/^dev_/);

      const enabled = await runOnlineRemote("enable", "", {
        remoteDir: tmp,
        relay: wsUrl,
        token: "host-secret-token",
        allowInsecureWs: true,
        json: true,
      });
      expect(enabled.ok).toBe(true);
      expect(enabled.enabled).toBe(true);

      const ticket = await runOnlineRemote("pair", "", {
        remoteDir: tmp,
        relay: wsUrl,
        token: "host-secret-token",
        allowInsecureWs: true,
        noWait: true,
        json: true,
      });
      expect(ticket.ok).toBe(true);
      expect(ticket.pair_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(ticket.qr_svg).toContain("<svg");

      const kp = await generateEcdhKeyPair();
      await upsertPairedClient(tmp, {
        client_id: "cli_dev_1",
        label: "iPad",
        public_key_jwk: kp.publicKeyJwk,
        token_hash: "hash1",
      });

      const list = await runOnlineRemote("devices", "", { remoteDir: tmp, json: true });
      expect(list.devices).toHaveLength(1);

      const rev = await runOnlineRemote("revoke", "cli_dev_1", { remoteDir: tmp, json: true });
      expect(rev.ok).toBe(true);
      expect(rev.revoked).toBe("cli_dev_1");

      const listAfter = await runOnlineRemote("devices", "", { remoteDir: tmp, json: true });
      expect(listAfter.devices).toHaveLength(0);

      const disabled = await runOnlineRemote("disable", "", { remoteDir: tmp, json: true });
      expect(disabled.enabled).toBe(false);
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("optional webAppDir serves static PWA assets, SPA fallback, /ufoo/online/health, and rejects traversal", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const tmpWeb = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-web-dist-"));
    fs.mkdirSync(path.join(tmpWeb, "assets"), { recursive: true });
    fs.writeFileSync(path.join(tmpWeb, "index.html"), "<!doctype html><title>Ufoo Remote</title>");
    fs.writeFileSync(path.join(tmpWeb, "manifest.webmanifest"), '{"name":"Ufoo"}');
    fs.writeFileSync(path.join(tmpWeb, "assets", "app.js"), "console.log('ok');");

    const webServer = new OnlineServer({
      host: "127.0.0.1",
      port: 0,
      insecure: true,
      webAppDir: tmpWeb,
    });
    await webServer.start();
    const base = `http://127.0.0.1:${webServer.port}`;
    try {
      const rootRes = await fetch(`${base}/`, { redirect: "manual" });
      expect(rootRes.status).toBe(302);
      expect(rootRes.headers.get("location")).toBe("/remote/");

      const rootWithQuery = await fetch(`${base}/?pair=ABCD-1234`, { redirect: "manual" });
      expect(rootWithQuery.status).toBe(302);
      expect(rootWithQuery.headers.get("location")).toBe("/remote/?pair=ABCD-1234");

      const remoteRootRes = await fetch(`${base}/remote/`);
      expect(remoteRootRes.status).toBe(200);
      expect(remoteRootRes.headers.get("content-type")).toContain("text/html");
      expect(await remoteRootRes.text()).toContain("Ufoo Remote");

      const manifestRes = await fetch(`${base}/manifest.webmanifest`);
      expect(manifestRes.status).toBe(200);
      expect(manifestRes.headers.get("content-type")).toContain("application/manifest+json");

      const assetRes = await fetch(`${base}/assets/app.js`);
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get("cache-control")).toContain("immutable");

      const spaRes = await fetch(`${base}/remote/dev_abc123?pair=ABCD-1234`);
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toContain("Ufoo Remote");

      const missingAsset = await fetch(`${base}/assets/missing.js`);
      expect(missingAsset.status).toBe(404);

      fs.symlinkSync(path.resolve(__dirname, "../../../package.json"), path.join(tmpWeb, "escape.json"));
      const symlinkEscape = await fetch(`${base}/escape.json`);
      expect(symlinkEscape.status).toBe(403);

      const http = require("http");
      const traversalStatus = await new Promise((resolve, reject) => {
        const req = http.get(
          { host: "127.0.0.1", port: webServer.port, path: "/%2e%2e%2fpackage.json" },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          }
        );
        req.on("error", reject);
      });
      expect(traversalStatus).toBe(403);

      const healthRes = await fetch(`${base}/ufoo/online/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.text()).toBe("ufoo-online: running\n");
    } finally {
      await webServer.stop();
      fs.rmSync(tmpWeb, { recursive: true, force: true });
    }
  });
});
