"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  E2eeSession,
  generateEcdhKeyPair,
  deriveSharedSecret,
  deriveSessionMaterial,
  computeKeyFingerprint,
  generatePairCode,
  normalizePairCode,
  hashPairCode,
  hashPairCodeSync,
  computeClaimProof,
  verifyClaimProof,
  computeHostProof,
  verifyHostProof,
  buildDirectionalIv,
  randomBytes,
  base64UrlDecode,
  base64UrlEncode,
} = require("../../../src/online/remoteCrypto");
const {
  loadOrCreateDeviceIdentity,
  loadRemoteConfig,
  saveRemoteConfig,
  upsertPairedClient,
  listPairedClients,
  revokePairedClient,
  identityPath,
  configPath,
  pairedClientsPath,
} = require("../../../src/online/remoteStore");
const { buildQrMatrix, renderQrSvg, renderQrTerminal } = require("../../../src/online/qrSvg");

describe("Phase 5 Zero-Knowledge E2EE Crypto, Store & QR", () => {
  test("ECDH P-256 + HKDF-SHA256 derives identical shared secret and distinct directional keys/IVs", async () => {
    const hostKp = await generateEcdhKeyPair();
    const clientKp = await generateEcdhKeyPair();
    expect(hostKp.publicKeyJwk.kty).toBe("EC");
    expect(hostKp.publicKeyJwk.crv).toBe("P-256");
    expect(hostKp.fingerprint).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(await computeKeyFingerprint(hostKp.publicKeyJwk)).toBe(hostKp.fingerprint);

    const secretHost = await deriveSharedSecret(hostKp.privateKeyJwk, clientKp.publicKeyJwk);
    const secretClient = await deriveSharedSecret(clientKp.privateKeyJwk, hostKp.publicKeyJwk);
    expect(Buffer.from(secretHost).equals(Buffer.from(secretClient))).toBe(true);

    const salt = randomBytes(32);
    const mat = await deriveSessionMaterial({
      staticSharedSecret: secretHost,
      salt,
      deviceId: "dev_1",
      clientId: "cli_1",
      sessionId: "sid_1",
    });

    // Directional keys and IV prefixes MUST be distinct
    expect(Buffer.from(mat.c2hKeyRaw).equals(Buffer.from(mat.h2cKeyRaw))).toBe(false);
    expect(Buffer.from(mat.c2hIvPrefix).equals(Buffer.from(mat.h2cIvPrefix))).toBe(false);

    const iv1 = buildDirectionalIv(mat.c2hIvPrefix, 1);
    const iv2 = buildDirectionalIv(mat.c2hIvPrefix, 2);
    const ivH1 = buildDirectionalIv(mat.h2cIvPrefix, 1);
    expect(iv1.length).toBe(12);
    expect(Buffer.from(iv1).equals(Buffer.from(iv2))).toBe(false);
    expect(Buffer.from(iv1).equals(Buffer.from(ivH1))).toBe(false);
  });

  test("E2eeSession completes authenticated ephemeral handshake and bidirectional AES-256-GCM round-trip", async () => {
    const hostKp = await generateEcdhKeyPair();
    const clientKp = await generateEcdhKeyPair();

    const clientSession = new E2eeSession({
      role: "client",
      deviceId: "dev_alpha",
      clientId: "web_01",
      localPrivateKeyJwk: clientKp.privateKeyJwk,
      peerPublicKeyJwk: hostKp.publicKeyJwk,
    });
    const hostSession = new E2eeSession({
      role: "host",
      deviceId: "dev_alpha",
      clientId: "web_01",
      localPrivateKeyJwk: hostKp.privateKeyJwk,
      peerPublicKeyJwk: clientKp.publicKeyJwk,
    });

    const init = await clientSession.createHandshakeInit();
    const ack = await hostSession.acceptHandshakeInit(init);
    await clientSession.completeHandshakeAck(ack);

    expect(clientSession.ready).toBe(true);
    expect(hostSession.ready).toBe(true);

    const secretCmd = {
      protocol: "ufoo-ui/1",
      kind: "command",
      name: "input.submit",
      request_id: "req-1",
      payload: { text: "SUPER_SECRET_PROMPT_42" },
    };
    const encC2H = await clientSession.encryptJson(secretCmd);
    expect(encC2H.dir).toBe("c2h");
    expect(encC2H.ctr).toBe(1);
    // Zero-Knowledge check: serialized encrypted frame must never leak plaintext
    expect(JSON.stringify(encC2H)).not.toContain("SUPER_SECRET_PROMPT_42");
    expect(JSON.stringify(encC2H)).not.toContain("input.submit");

    const decAtHost = await hostSession.decryptJson(encC2H);
    expect(decAtHost).toEqual(secretCmd);

    const secretEvt = {
      protocol: "ufoo-ui/1",
      kind: "event",
      name: "interaction.request",
      seq: 9,
      payload: { id: "int-9", prompt: "Allow running rm -rf build?" },
    };
    const encH2C = await hostSession.encryptJson(secretEvt);
    expect(encH2C.dir).toBe("h2c");
    expect(encH2C.ctr).toBe(1);
    expect(JSON.stringify(encH2C)).not.toContain("rm -rf build");

    const decAtClient = await clientSession.decryptJson(encH2C);
    expect(decAtClient).toEqual(secretEvt);
  });

  test("E2eeSession strictly rejects tampered ciphertext, AAD manipulation, reflection, replays, and spoofed handshakes", async () => {
    const hostKp = await generateEcdhKeyPair();
    const clientKp = await generateEcdhKeyPair();
    const attackerKp = await generateEcdhKeyPair();

    // 1. Spoofed handshake from wrong key must fail authentication
    const attackerSession = new E2eeSession({
      role: "client",
      deviceId: "dev_alpha",
      clientId: "web_01",
      localPrivateKeyJwk: attackerKp.privateKeyJwk,
      peerPublicKeyJwk: hostKp.publicKeyJwk,
    });
    const hostSession = new E2eeSession({
      role: "host",
      deviceId: "dev_alpha",
      clientId: "web_01",
      localPrivateKeyJwk: hostKp.privateKeyJwk,
      peerPublicKeyJwk: clientKp.publicKeyJwk,
    });
    const forgedInit = await attackerSession.createHandshakeInit();
    await expect(hostSession.acceptHandshakeInit(forgedInit)).rejects.toThrow(/authentication failed/i);

    // 2. Establish legitimate session
    const clientSession = new E2eeSession({
      role: "client",
      deviceId: "dev_alpha",
      clientId: "web_01",
      localPrivateKeyJwk: clientKp.privateKeyJwk,
      peerPublicKeyJwk: hostKp.publicKeyJwk,
    });
    const init = await clientSession.createHandshakeInit();
    const ack = await hostSession.acceptHandshakeInit(init);
    await clientSession.completeHandshakeAck(ack);

    const f1 = await clientSession.encryptJson({ n: 1 });
    const f2 = await clientSession.encryptJson({ n: 2 });

    // Tampered ciphertext (flip 1 bit) must fail and must NOT advance counter
    const rawCt = base64UrlDecode(f1.ct);
    rawCt[0] ^= 0x01;
    const tampered = { ...f1, ct: base64UrlEncode(rawCt) };
    await expect(hostSession.decryptJson(tampered)).rejects.toThrow(/decryption\/authentication failed/i);

    // Tampered counter (AAD mismatch) must fail
    await expect(hostSession.decryptJson({ ...f1, ctr: 99 })).rejects.toThrow(/decryption\/authentication failed/i);

    // Direction reflection (sending c2h frame back to client expecting h2c) must fail
    await expect(clientSession.decryptJson(f1)).rejects.toThrow(/direction/i);

    // Session ID mismatch must fail
    await expect(hostSession.decryptJson({ ...f1, sid: "other_sid" })).rejects.toThrow(/session ID mismatch/i);

    // Valid f1 still succeeds because failed attempts did not advance replay cursor
    expect(await hostSession.decryptJson(f1)).toEqual({ n: 1 });

    // Replaying f1 immediately fails
    await expect(hostSession.decryptJson(f1)).rejects.toThrow(/replay/i);

    // Next valid f2 succeeds, replaying f2 fails
    expect(await hostSession.decryptJson(f2)).toEqual({ n: 2 });
    await expect(hostSession.decryptJson(f2)).rejects.toThrow(/replay/i);
  });

  test("Pairing code normalization, lookup hash, and bidirectional HMAC pairing proofs detect MITM tampering", async () => {
    const code = generatePairCode(8);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(normalizePairCode(code.toLowerCase().replace("-", " "))).toBe(normalizePairCode(code));
    expect(await hashPairCode(code)).toBe(hashPairCodeSync(code));

    const hostKp = await generateEcdhKeyPair();
    const clientKp = await generateEcdhKeyPair();
    const mitmKp = await generateEcdhKeyPair();

    const claimProof = await computeClaimProof({
      pairCode: code,
      clientId: "web_1",
      clientNonce: "cn_123",
      clientPublicKeyJwk: clientKp.publicKeyJwk,
    });
    expect(await verifyClaimProof({
      pairCode: code,
      clientId: "web_1",
      clientNonce: "cn_123",
      clientPublicKeyJwk: clientKp.publicKeyJwk,
      claimProof,
    })).toBe(true);

    // MITM substituting client public key fails proof verification
    expect(await verifyClaimProof({
      pairCode: code,
      clientId: "web_1",
      clientNonce: "cn_123",
      clientPublicKeyJwk: mitmKp.publicKeyJwk,
      claimProof,
    })).toBe(false);

    const hostProof = await computeHostProof({
      pairCode: code,
      deviceId: "dev_1",
      clientId: "web_1",
      clientNonce: "cn_123",
      hostNonce: "hn_456",
      hostPublicKeyJwk: hostKp.publicKeyJwk,
    });
    expect(await verifyHostProof({
      pairCode: code,
      deviceId: "dev_1",
      clientId: "web_1",
      clientNonce: "cn_123",
      hostNonce: "hn_456",
      hostPublicKeyJwk: hostKp.publicKeyJwk,
      hostProof,
    })).toBe(true);

    // MITM substituting host public key fails host proof verification
    expect(await verifyHostProof({
      pairCode: code,
      deviceId: "dev_1",
      clientId: "web_1",
      clientNonce: "cn_123",
      hostNonce: "hn_456",
      hostPublicKeyJwk: mitmKp.publicKeyJwk,
      hostProof,
    })).toBe(false);
  });

  test("remoteStore persists identity, config, and paired clients with 0o600 permissions and revocation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-rstore-"));
    const remoteDir = path.join(tmp, "remote");
    try {
      const id1 = await loadOrCreateDeviceIdentity(remoteDir, { deviceName: "TestMac" });
      const id2 = await loadOrCreateDeviceIdentity(remoteDir);
      expect(id2.device_id).toBe(id1.device_id);
      expect(id2.fingerprint).toBe(id1.fingerprint);

      const cfg = saveRemoteConfig(remoteDir, {
        enabled: true,
        relay_url: "ws://127.0.0.1:8787/ufoo/online",
        allow_insecure_ws: true,
      });
      expect(cfg.enabled).toBe(true);
      expect(loadRemoteConfig(remoteDir).relay_url).toBe("ws://127.0.0.1:8787/ufoo/online");

      const clientKp = await generateEcdhKeyPair();
      await upsertPairedClient(remoteDir, {
        client_id: "phone_1",
        label: "iPhone 16",
        public_key_jwk: clientKp.publicKeyJwk,
        token_hash: "abc123",
      });
      expect(listPairedClients(remoteDir)).toHaveLength(1);

      // Verify POSIX file permissions 0o600 and directory 0o700
      if (process.platform !== "win32") {
        expect(fs.statSync(remoteDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(identityPath(remoteDir)).mode & 0o777).toBe(0o600);
        expect(fs.statSync(configPath(remoteDir)).mode & 0o777).toBe(0o600);
        expect(fs.statSync(pairedClientsPath(remoteDir)).mode & 0o777).toBe(0o600);
      }

      const rev = revokePairedClient(remoteDir, "phone_1");
      expect(rev.ok).toBe(true);
      expect(listPairedClients(remoteDir)).toHaveLength(0);
      expect(listPairedClients(remoteDir, { includeRevoked: true })[0].revoked_at).toBeTruthy();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("qrSvg generates valid ISO QR matrix, SVG markup, data URL, and terminal render", () => {
    const deepUrl = "https://app.ufoo.dev/?relay=wss%3A%2F%2Fonline.ufoo.dev%2Fufoo%2Fonline&device=dev_123456&pair=K7M9-P4Q2&fp=ABCD-1234-EF56-7890";
    const { version, size, matrix } = buildQrMatrix(deepUrl);
    expect(version).toBeGreaterThanOrEqual(4);
    expect(size).toBe(version * 4 + 17);
    expect(matrix.length).toBe(size);
    // Finder top-left 7x7 outer border sanity check
    expect(matrix[0][0]).toBe(1);
    expect(matrix[0][6]).toBe(1);
    expect(matrix[3][3]).toBe(1);

    const { svg, dataUrl } = renderQrSvg(deepUrl);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
    expect(dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);

    const ascii = renderQrTerminal(deepUrl);
    expect(ascii.split("\n").length).toBeGreaterThan(10);
  });
});
