"use strict";

/**
 * Zero-Knowledge E2EE cryptographic primitives for ufoo remote access.
 *
 * Uses Node's WebCrypto API (crypto.webcrypto.subtle) exclusively with
 * ECDH P-256 + HKDF-SHA256 + HMAC-SHA256 + AES-256-GCM so the exact same
 * wire protocol runs identically across Node 18+, Safari/iOS, Chrome, and WKWebView.
 */

const nodeCrypto = require("crypto");

const webcrypto = globalThis.crypto && globalThis.crypto.subtle
  ? globalThis.crypto
  : nodeCrypto.webcrypto;

if (!webcrypto || !webcrypto.subtle) {
  throw new Error("WebCrypto API (crypto.subtle) is required for ufoo E2EE");
}

const subtle = webcrypto.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const E2EE_VERSION = 1;
const ECDH_PARAMS = Object.freeze({ name: "ECDH", namedCurve: "P-256" });
const BASE32_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Crockford-like, no 0/O/1/I ambiguity

function toUint8Array(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === "string") return textEncoder.encode(input);
  throw new TypeError("Unsupported binary input");
}

function concatBytes(...parts) {
  const arrays = parts.map(toUint8Array);
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function base64UrlEncode(bytes) {
  return Buffer.from(toUint8Array(bytes)).toString("base64url");
}

function base64UrlDecode(str) {
  if (typeof str !== "string" || !str) {
    throw new Error("Invalid base64url string");
  }
  return new Uint8Array(Buffer.from(str, "base64url"));
}

function randomBytes(length) {
  const buf = new Uint8Array(length);
  webcrypto.getRandomValues(buf);
  return buf;
}

function randomHex(byteLength = 16) {
  return Buffer.from(randomBytes(byteLength)).toString("hex");
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(toUint8Array(a));
  const bb = Buffer.from(toUint8Array(b));
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return nodeCrypto.timingSafeEqual(ba, bb);
}

function validatePublicKeyJwk(jwk) {
  if (!jwk || typeof jwk !== "object") return false;
  return (
    jwk.kty === "EC"
    && jwk.crv === "P-256"
    && typeof jwk.x === "string"
    && jwk.x.length > 0
    && typeof jwk.y === "string"
    && jwk.y.length > 0
  );
}

function canonicalPublicKeyString(jwk) {
  if (!validatePublicKeyJwk(jwk)) {
    throw new Error("Invalid ECDH P-256 public key JWK");
  }
  return JSON.stringify({
    crv: "P-256",
    kty: "EC",
    x: jwk.x,
    y: jwk.y,
  });
}

function sanitizePublicKeyJwk(jwk) {
  if (!validatePublicKeyJwk(jwk)) {
    throw new Error("Invalid ECDH P-256 public key JWK");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    ext: true,
  };
}

async function sha256Bytes(input) {
  const digest = await subtle.digest("SHA-256", toUint8Array(input));
  return new Uint8Array(digest);
}

async function sha256Hex(input) {
  return Buffer.from(await sha256Bytes(input)).toString("hex");
}

async function computeKeyFingerprint(publicKeyJwk) {
  const hex = (await sha256Hex(canonicalPublicKeyString(publicKeyJwk))).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

async function generateEcdhKeyPair() {
  const pair = await subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const publicKeyJwk = sanitizePublicKeyJwk(await subtle.exportKey("jwk", pair.publicKey));
  const privateKeyJwk = await subtle.exportKey("jwk", pair.privateKey);
  const fingerprint = await computeKeyFingerprint(publicKeyJwk);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyJwk,
    privateKeyJwk,
    fingerprint,
  };
}

async function importPublicKeyJwk(jwk) {
  const clean = sanitizePublicKeyJwk(jwk);
  return subtle.importKey("jwk", clean, ECDH_PARAMS, true, []);
}

async function importPrivateKeyJwk(jwk) {
  if (!validatePublicKeyJwk(jwk) || typeof jwk.d !== "string" || !jwk.d) {
    throw new Error("Invalid ECDH P-256 private key JWK");
  }
  const clean = {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
    d: jwk.d,
    ext: true,
  };
  return subtle.importKey("jwk", clean, ECDH_PARAMS, true, ["deriveBits"]);
}

async function deriveSharedSecret(privateKey, peerPublicKey) {
  const priv = privateKey && privateKey.type === "private"
    ? privateKey
    : await importPrivateKeyJwk(privateKey);
  const pub = peerPublicKey && peerPublicKey.type === "public"
    ? peerPublicKey
    : await importPublicKeyJwk(peerPublicKey);
  const bits = await subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  return new Uint8Array(bits);
}

async function hkdfDeriveBytes(ikm, salt, info, byteLength = 32) {
  const baseKey = await subtle.importKey("raw", toUint8Array(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toUint8Array(salt),
      info: toUint8Array(info),
    },
    baseKey,
    byteLength * 8
  );
  return new Uint8Array(bits);
}

async function hmacSha256(keyBytes, message) {
  const key = await subtle.importKey(
    "raw",
    toUint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await subtle.sign("HMAC", key, toUint8Array(message));
  return new Uint8Array(sig);
}

// --- Pairing code helpers (Zero-Knowledge authenticated pairing) ---

function normalizePairCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatPairCode(code) {
  const norm = normalizePairCode(code);
  if (norm.length <= 4) return norm;
  return `${norm.slice(0, 4)}-${norm.slice(4)}`;
}

function generatePairCode(length = 8) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length];
  }
  return formatPairCode(out);
}

function hashPairCodeSync(code) {
  const norm = normalizePairCode(code);
  if (!norm) return "";
  return nodeCrypto
    .createHash("sha256")
    .update(`ufoo-pair-lookup-v1:${norm}`)
    .digest("hex");
}

async function hashPairCode(code) {
  const norm = normalizePairCode(code);
  if (!norm) return "";
  return sha256Hex(`ufoo-pair-lookup-v1:${norm}`);
}

async function computeClaimProof({ pairCode, clientId, clientNonce, clientPublicKeyJwk }) {
  const norm = normalizePairCode(pairCode);
  const msg = `pair-claim-v1|${String(clientId)}|${String(clientNonce)}|${canonicalPublicKeyString(clientPublicKeyJwk)}`;
  return base64UrlEncode(await hmacSha256(norm, msg));
}

async function verifyClaimProof({ pairCode, clientId, clientNonce, clientPublicKeyJwk, claimProof }) {
  if (!claimProof || typeof claimProof !== "string") return false;
  try {
    const expected = await computeClaimProof({ pairCode, clientId, clientNonce, clientPublicKeyJwk });
    return constantTimeEqual(base64UrlDecode(expected), base64UrlDecode(claimProof));
  } catch {
    return false;
  }
}

async function computeHostProof({ pairCode, deviceId, clientId, clientNonce, hostNonce, hostPublicKeyJwk }) {
  const norm = normalizePairCode(pairCode);
  const msg = `pair-approve-v1|${String(deviceId)}|${String(clientId)}|${String(clientNonce)}|${String(hostNonce)}|${canonicalPublicKeyString(hostPublicKeyJwk)}`;
  return base64UrlEncode(await hmacSha256(norm, msg));
}

async function verifyHostProof({ pairCode, deviceId, clientId, clientNonce, hostNonce, hostPublicKeyJwk, hostProof }) {
  if (!hostProof || typeof hostProof !== "string") return false;
  try {
    const expected = await computeHostProof({ pairCode, deviceId, clientId, clientNonce, hostNonce, hostPublicKeyJwk });
    return constantTimeEqual(base64UrlDecode(expected), base64UrlDecode(hostProof));
  } catch {
    return false;
  }
}

// --- Directional Session Keys & AES-256-GCM Framing ---

function buildDirectionalIv(ivPrefix4, counter) {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new Error("Invalid E2EE frame counter");
  }
  const iv = new Uint8Array(12);
  iv.set(ivPrefix4.subarray(0, 4), 0);
  const view = new DataView(iv.buffer);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  view.setUint32(4, hi, false);
  view.setUint32(8, lo, false);
  return iv;
}

function buildFrameAad({ deviceId, clientId, sessionId, dir, ctr }) {
  return textEncoder.encode(
    `ufoo-e2ee-v${E2EE_VERSION}|${deviceId}|${clientId}|${sessionId}|${dir}|${ctr}`
  );
}

async function deriveHandshakeMacKey({ staticSharedSecret, deviceId, clientId }) {
  return hkdfDeriveBytes(
    staticSharedSecret,
    "ufoo-e2ee-v1-handshake",
    `auth|${deviceId}|${clientId}`,
    32
  );
}

async function deriveSessionMaterial({
  staticSharedSecret,
  ephemeralSharedSecret = null,
  salt,
  deviceId,
  clientId,
  sessionId,
}) {
  const ikm = ephemeralSharedSecret
    ? concatBytes(staticSharedSecret, ephemeralSharedSecret)
    : toUint8Array(staticSharedSecret);
  const contextBase = `ufoo-e2ee-v${E2EE_VERSION}|${deviceId}|${clientId}|${sessionId}`;

  const [c2hKeyRaw, h2cKeyRaw, c2hIvPrefix, h2cIvPrefix] = await Promise.all([
    hkdfDeriveBytes(ikm, salt, `${contextBase}|key|c2h`, 32),
    hkdfDeriveBytes(ikm, salt, `${contextBase}|key|h2c`, 32),
    hkdfDeriveBytes(ikm, salt, `${contextBase}|iv|c2h`, 4),
    hkdfDeriveBytes(ikm, salt, `${contextBase}|iv|h2c`, 4),
  ]);

  const [c2hKey, h2cKey] = await Promise.all([
    subtle.importKey("raw", c2hKeyRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    subtle.importKey("raw", h2cKeyRaw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
  ]);

  return {
    c2hKey,
    h2cKey,
    c2hIvPrefix,
    h2cIvPrefix,
    c2hKeyRaw,
    h2cKeyRaw,
  };
}

/**
 * Stateful authenticated E2EE session for either role ("host" | "client").
 *
 * Handshake:
 *   client -> host: hs_init { v:1, t:"hs_init", sid, epk, n, tag }
 *   host -> client: hs_ack  { v:1, t:"hs_ack",  sid, epk, n, tag }
 *
 * Encrypted data frames:
 *   { v:1, t:"msg", sid, dir:"c2h"|"h2c", ctr, ct }
 */
class E2eeSession {
  constructor({ role, deviceId, clientId, localPrivateKeyJwk, peerPublicKeyJwk }) {
    if (role !== "host" && role !== "client") {
      throw new Error("role must be 'host' or 'client'");
    }
    if (!deviceId || !clientId) {
      throw new Error("deviceId and clientId are required");
    }
    this.role = role;
    this.deviceId = String(deviceId);
    this.clientId = String(clientId);
    this.localPrivateKeyJwk = localPrivateKeyJwk;
    this.peerPublicKeyJwk = sanitizePublicKeyJwk(peerPublicKeyJwk);

    this.outboundDir = role === "client" ? "c2h" : "h2c";
    this.inboundDir = role === "client" ? "h2c" : "c2h";

    this.sessionId = "";
    this.ready = false;
    this._staticSecret = null;
    this._macKey = null;
    this._ephemKeyPair = null;
    this._clientNonce = null;
    this._keys = null;
    this._sendCtr = 0;
    this._lastRecvCtr = 0;
  }

  async _ensureStatic() {
    if (!this._staticSecret) {
      this._staticSecret = await deriveSharedSecret(this.localPrivateKeyJwk, this.peerPublicKeyJwk);
      this._macKey = await deriveHandshakeMacKey({
        staticSharedSecret: this._staticSecret,
        deviceId: this.deviceId,
        clientId: this.clientId,
      });
    }
  }

  async createHandshakeInit() {
    if (this.role !== "client") {
      throw new Error("Only client role can create hs_init");
    }
    await this._ensureStatic();
    this.sessionId = randomHex(16);
    this._ephemKeyPair = await generateEcdhKeyPair();
    this._clientNonce = randomBytes(16);
    const nB64 = base64UrlEncode(this._clientNonce);
    const macInput = `c2h|${this.sessionId}|${nB64}|${canonicalPublicKeyString(this._ephemKeyPair.publicKeyJwk)}`;
    const tag = base64UrlEncode(await hmacSha256(this._macKey, macInput));
    this.ready = false;
    this._sendCtr = 0;
    this._lastRecvCtr = 0;
    return {
      v: E2EE_VERSION,
      t: "hs_init",
      sid: this.sessionId,
      epk: this._ephemKeyPair.publicKeyJwk,
      n: nB64,
      tag,
    };
  }

  async acceptHandshakeInit(initFrame) {
    if (this.role !== "host") {
      throw new Error("Only host role can accept hs_init");
    }
    if (!initFrame || initFrame.v !== E2EE_VERSION || initFrame.t !== "hs_init") {
      throw new Error("Invalid handshake init frame");
    }
    if (typeof initFrame.sid !== "string" || !initFrame.sid || typeof initFrame.n !== "string" || typeof initFrame.tag !== "string") {
      throw new Error("Malformed handshake init frame");
    }
    if (!validatePublicKeyJwk(initFrame.epk)) {
      throw new Error("Invalid client ephemeral public key");
    }
    await this._ensureStatic();
    const expectedInput = `c2h|${initFrame.sid}|${initFrame.n}|${canonicalPublicKeyString(initFrame.epk)}`;
    const expectedTag = await hmacSha256(this._macKey, expectedInput);
    const actualTag = base64UrlDecode(initFrame.tag);
    if (!constantTimeEqual(expectedTag, actualTag)) {
      throw new Error("Handshake authentication failed");
    }

    const clientNonce = base64UrlDecode(initFrame.n);
    const hostNonce = randomBytes(16);
    const hostNonceB64 = base64UrlEncode(hostNonce);
    this._ephemKeyPair = await generateEcdhKeyPair();
    this.sessionId = initFrame.sid;

    const ephemSecret = await deriveSharedSecret(this._ephemKeyPair.privateKey, initFrame.epk);
    const salt = concatBytes(clientNonce, hostNonce);
    this._keys = await deriveSessionMaterial({
      staticSharedSecret: this._staticSecret,
      ephemeralSharedSecret: ephemSecret,
      salt,
      deviceId: this.deviceId,
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this._sendCtr = 0;
    this._lastRecvCtr = 0;
    this.ready = true;

    const ackInput = `h2c|${this.sessionId}|${initFrame.n}|${hostNonceB64}|${canonicalPublicKeyString(this._ephemKeyPair.publicKeyJwk)}`;
    const tag = base64UrlEncode(await hmacSha256(this._macKey, ackInput));
    return {
      v: E2EE_VERSION,
      t: "hs_ack",
      sid: this.sessionId,
      epk: this._ephemKeyPair.publicKeyJwk,
      n: hostNonceB64,
      tag,
    };
  }

  async completeHandshakeAck(ackFrame) {
    if (this.role !== "client") {
      throw new Error("Only client role can complete hs_ack");
    }
    if (!this._ephemKeyPair || !this._clientNonce || !this.sessionId) {
      throw new Error("No handshake init in progress");
    }
    if (!ackFrame || ackFrame.v !== E2EE_VERSION || ackFrame.t !== "hs_ack") {
      throw new Error("Invalid handshake ack frame");
    }
    if (ackFrame.sid !== this.sessionId || typeof ackFrame.n !== "string" || typeof ackFrame.tag !== "string") {
      throw new Error("Handshake session mismatch");
    }
    if (!validatePublicKeyJwk(ackFrame.epk)) {
      throw new Error("Invalid host ephemeral public key");
    }
    await this._ensureStatic();
    const clientNonceB64 = base64UrlEncode(this._clientNonce);
    const expectedInput = `h2c|${this.sessionId}|${clientNonceB64}|${ackFrame.n}|${canonicalPublicKeyString(ackFrame.epk)}`;
    const expectedTag = await hmacSha256(this._macKey, expectedInput);
    const actualTag = base64UrlDecode(ackFrame.tag);
    if (!constantTimeEqual(expectedTag, actualTag)) {
      throw new Error("Host handshake authentication failed");
    }

    const hostNonce = base64UrlDecode(ackFrame.n);
    const ephemSecret = await deriveSharedSecret(this._ephemKeyPair.privateKey, ackFrame.epk);
    const salt = concatBytes(this._clientNonce, hostNonce);
    this._keys = await deriveSessionMaterial({
      staticSharedSecret: this._staticSecret,
      ephemeralSharedSecret: ephemSecret,
      salt,
      deviceId: this.deviceId,
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this._sendCtr = 0;
    this._lastRecvCtr = 0;
    this.ready = true;
    return true;
  }

  async encryptJson(obj) {
    if (!this.ready || !this._keys) {
      throw new Error("E2EE session not established");
    }
    const ctr = ++this._sendCtr;
    const dir = this.outboundDir;
    const key = dir === "c2h" ? this._keys.c2hKey : this._keys.h2cKey;
    const ivPrefix = dir === "c2h" ? this._keys.c2hIvPrefix : this._keys.h2cIvPrefix;
    const iv = buildDirectionalIv(ivPrefix, ctr);
    const aad = buildFrameAad({
      deviceId: this.deviceId,
      clientId: this.clientId,
      sessionId: this.sessionId,
      dir,
      ctr,
    });
    const plaintext = textEncoder.encode(JSON.stringify(obj));
    const ctBuf = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      key,
      plaintext
    );
    return {
      v: E2EE_VERSION,
      t: "msg",
      sid: this.sessionId,
      dir,
      ctr,
      ct: base64UrlEncode(new Uint8Array(ctBuf)),
    };
  }

  async decryptJson(frame) {
    if (!this.ready || !this._keys) {
      throw new Error("E2EE session not established");
    }
    if (!frame || frame.v !== E2EE_VERSION || frame.t !== "msg") {
      throw new Error("Invalid E2EE message frame");
    }
    if (frame.sid !== this.sessionId) {
      throw new Error("E2EE session ID mismatch");
    }
    if (frame.dir !== this.inboundDir) {
      throw new Error(`Invalid E2EE frame direction "${frame.dir}"`);
    }
    const ctr = frame.ctr;
    if (!Number.isSafeInteger(ctr) || ctr <= this._lastRecvCtr) {
      throw new Error("E2EE replay or out-of-order counter detected");
    }
    if (typeof frame.ct !== "string" || !frame.ct) {
      throw new Error("Missing ciphertext");
    }

    const key = frame.dir === "c2h" ? this._keys.c2hKey : this._keys.h2cKey;
    const ivPrefix = frame.dir === "c2h" ? this._keys.c2hIvPrefix : this._keys.h2cIvPrefix;
    const iv = buildDirectionalIv(ivPrefix, ctr);
    const aad = buildFrameAad({
      deviceId: this.deviceId,
      clientId: this.clientId,
      sessionId: this.sessionId,
      dir: frame.dir,
      ctr,
    });

    const ctBytes = base64UrlDecode(frame.ct);
    let plainBuf;
    try {
      plainBuf = await subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        ctBytes
      );
    } catch {
      throw new Error("E2EE decryption/authentication failed");
    }

    // Advance replay cursor ONLY after AES-GCM tag verification succeeds!
    this._lastRecvCtr = ctr;
    return JSON.parse(textDecoder.decode(new Uint8Array(plainBuf)));
  }
}

module.exports = {
  E2EE_VERSION,
  E2eeSession,
  base64UrlEncode,
  base64UrlDecode,
  randomBytes,
  randomHex,
  constantTimeEqual,
  validatePublicKeyJwk,
  sanitizePublicKeyJwk,
  canonicalPublicKeyString,
  sha256Hex,
  computeKeyFingerprint,
  generateEcdhKeyPair,
  importPublicKeyJwk,
  importPrivateKeyJwk,
  deriveSharedSecret,
  hkdfDeriveBytes,
  hmacSha256,
  normalizePairCode,
  formatPairCode,
  generatePairCode,
  hashPairCode,
  hashPairCodeSync,
  computeClaimProof,
  verifyClaimProof,
  computeHostProof,
  verifyHostProof,
  buildDirectionalIv,
  buildFrameAad,
  deriveSessionMaterial,
};
