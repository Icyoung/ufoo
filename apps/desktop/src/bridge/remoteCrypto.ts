/**
 * Browser WebCrypto Zero-Knowledge E2EE cryptographic primitives for ufoo remote access.
 *
 * Mirrors `/src/online/remoteCrypto.js` bit-for-bit using native `window.crypto.subtle`
 * (ECDH P-256 + HKDF-SHA256 + HMAC-SHA256 + AES-256-GCM) with zero npm dependencies.
 */

export const E2EE_VERSION = 1 as const;

const ECDH_PARAMS: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface EcdhPublicKeyJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  ext?: boolean;
}

export interface EcdhPrivateKeyJwk extends EcdhPublicKeyJwk {
  d: string;
}

export interface EcdhKeyPairResult {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyJwk: EcdhPublicKeyJwk;
  privateKeyJwk: EcdhPrivateKeyJwk;
  fingerprint: string;
}

export interface HandshakeInitFrame {
  v: 1;
  t: "hs_init";
  sid: string;
  epk: EcdhPublicKeyJwk;
  n: string;
  tag: string;
}

export interface HandshakeAckFrame {
  v: 1;
  t: "hs_ack";
  sid: string;
  epk: EcdhPublicKeyJwk;
  n: string;
  tag: string;
}

export interface EncryptedMessageFrame {
  v: 1;
  t: "msg";
  sid: string;
  dir: "c2h" | "h2c";
  ctr: number;
  ct: string;
}

export type E2eeWireFrame = HandshakeInitFrame | HandshakeAckFrame | EncryptedMessageFrame;

interface DerivedSessionMaterial {
  c2hKey: CryptoKey;
  h2cKey: CryptoKey;
  c2hIvPrefix: Uint8Array<ArrayBuffer>;
  h2cIvPrefix: Uint8Array<ArrayBuffer>;
  c2hKeyRaw: Uint8Array<ArrayBuffer>;
  h2cKeyRaw: Uint8Array<ArrayBuffer>;
}

function getCrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto API (crypto.subtle) is required for ufoo E2EE. Use HTTPS or localhost.");
  }
  return c;
}

function getSubtle(): SubtleCrypto {
  return getCrypto().subtle;
}

export function toUint8Array(input: Uint8Array | ArrayBufferView | ArrayBuffer | string): Uint8Array<ArrayBuffer> {
  if (typeof input === "string") {
    const encoded = textEncoder.encode(input);
    const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    out.set(encoded);
    return out;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    const out = new Uint8Array(new ArrayBuffer(input.byteLength));
    out.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    return out;
  }
  throw new TypeError("Unsupported binary input");
}

export function concatBytes(...parts: Array<Uint8Array | ArrayBufferView | ArrayBuffer | string>): Uint8Array<ArrayBuffer> {
  const arrays = parts.map(toUint8Array);
  const total = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function base64UrlEncode(input: Uint8Array | ArrayBufferView | ArrayBuffer | string): string {
  const bytes = toUint8Array(input);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  if (typeof str !== "string" || !str) {
    throw new Error("Invalid base64url string");
  }
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const rem = b64.length % 4;
  if (rem === 2) b64 += "==";
  else if (rem === 3) b64 += "=";
  else if (rem === 1) throw new Error("Invalid base64url string");

  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(length));
  getCrypto().getRandomValues(buf);
  return buf;
}

export function randomHex(byteLength = 16): string {
  return bytesToHex(randomBytes(byteLength));
}

export function constantTimeEqual(
  a: Uint8Array | ArrayBufferView | ArrayBuffer | string,
  b: Uint8Array | ArrayBufferView | ArrayBuffer | string
): boolean {
  const ba = toUint8Array(a);
  const bb = toUint8Array(b);
  if (ba.length === 0 || ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i += 1) {
    diff |= ba[i] ^ bb[i];
  }
  return diff === 0;
}

export function validatePublicKeyJwk(jwk: unknown): jwk is EcdhPublicKeyJwk {
  if (!jwk || typeof jwk !== "object") return false;
  const candidate = jwk as Record<string, unknown>;
  return (
    candidate.kty === "EC"
    && candidate.crv === "P-256"
    && typeof candidate.x === "string"
    && candidate.x.length > 0
    && typeof candidate.y === "string"
    && candidate.y.length > 0
  );
}

export function canonicalPublicKeyString(jwk: unknown): string {
  if (!validatePublicKeyJwk(jwk)) {
    throw new Error("Invalid ECDH P-256 public key JWK");
  }
  // Exact field order matches src/online/remoteCrypto.js
  return JSON.stringify({
    crv: "P-256",
    kty: "EC",
    x: jwk.x,
    y: jwk.y,
  });
}

export function sanitizePublicKeyJwk(jwk: unknown): EcdhPublicKeyJwk {
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

export async function sha256Bytes(
  input: Uint8Array | ArrayBufferView | ArrayBuffer | string
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await getSubtle().digest("SHA-256", toUint8Array(input));
  return new Uint8Array(digest);
}

export async function sha256Hex(
  input: Uint8Array | ArrayBufferView | ArrayBuffer | string
): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

export async function computeKeyFingerprint(publicKeyJwk: unknown): Promise<string> {
  const hex = (await sha256Hex(canonicalPublicKeyString(publicKeyJwk))).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
}

export async function generateEcdhKeyPair(): Promise<EcdhKeyPairResult> {
  const subtle = getSubtle();
  const pair = await subtle.generateKey(ECDH_PARAMS, true, ["deriveBits"]);
  const publicKeyJwk = sanitizePublicKeyJwk(await subtle.exportKey("jwk", pair.publicKey));
  const rawPrivate = await subtle.exportKey("jwk", pair.privateKey);
  const privateD = typeof rawPrivate.d === "string" ? rawPrivate.d : "";
  if (!validatePublicKeyJwk(rawPrivate) || !privateD) {
    throw new Error("Failed to export ECDH P-256 private key");
  }
  const privateKeyJwk: EcdhPrivateKeyJwk = {
    kty: "EC",
    crv: "P-256",
    x: rawPrivate.x,
    y: rawPrivate.y,
    d: privateD,
    ext: true,
  };
  const fingerprint = await computeKeyFingerprint(publicKeyJwk);
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicKeyJwk,
    privateKeyJwk,
    fingerprint,
  };
}

export async function importPublicKeyJwk(jwk: unknown): Promise<CryptoKey> {
  const clean = sanitizePublicKeyJwk(jwk);
  return getSubtle().importKey("jwk", clean, ECDH_PARAMS, true, []);
}

export async function importPrivateKeyJwk(jwk: unknown): Promise<CryptoKey> {
  if (!validatePublicKeyJwk(jwk) || typeof (jwk as EcdhPrivateKeyJwk).d !== "string" || !(jwk as EcdhPrivateKeyJwk).d) {
    throw new Error("Invalid ECDH P-256 private key JWK");
  }
  const priv = jwk as EcdhPrivateKeyJwk;
  const clean: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: priv.x,
    y: priv.y,
    d: priv.d,
    ext: true,
  };
  return getSubtle().importKey("jwk", clean, ECDH_PARAMS, true, ["deriveBits"]);
}

export async function deriveSharedSecret(
  privateKey: CryptoKey | EcdhPrivateKeyJwk,
  peerPublicKey: CryptoKey | EcdhPublicKeyJwk
): Promise<Uint8Array<ArrayBuffer>> {
  const priv = privateKey instanceof CryptoKey
    ? privateKey
    : await importPrivateKeyJwk(privateKey);
  const pub = peerPublicKey instanceof CryptoKey
    ? peerPublicKey
    : await importPublicKeyJwk(peerPublicKey);
  const bits = await getSubtle().deriveBits({ name: "ECDH", public: pub }, priv, 256);
  return new Uint8Array(bits);
}

export async function hkdfDeriveBytes(
  ikm: Uint8Array | ArrayBufferView | ArrayBuffer | string,
  salt: Uint8Array | ArrayBufferView | ArrayBuffer | string,
  info: Uint8Array | ArrayBufferView | ArrayBuffer | string,
  byteLength = 32
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtle();
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

export async function hmacSha256(
  keyBytes: Uint8Array | ArrayBufferView | ArrayBuffer | string,
  message: Uint8Array | ArrayBufferView | ArrayBuffer | string
): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = getSubtle();
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

export function normalizePairCode(code: string): string {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function formatPairCode(code: string): string {
  const norm = normalizePairCode(code);
  if (norm.length <= 4) return norm;
  return `${norm.slice(0, 4)}-${norm.slice(4)}`;
}

export async function hashPairCode(code: string): Promise<string> {
  const norm = normalizePairCode(code);
  if (!norm) return "";
  return sha256Hex(`ufoo-pair-lookup-v1:${norm}`);
}

export async function computeClaimProof(params: {
  pairCode: string;
  clientId: string;
  clientNonce: string;
  clientPublicKeyJwk: EcdhPublicKeyJwk;
}): Promise<string> {
  const norm = normalizePairCode(params.pairCode);
  const msg = `pair-claim-v1|${String(params.clientId)}|${String(params.clientNonce)}|${canonicalPublicKeyString(params.clientPublicKeyJwk)}`;
  return base64UrlEncode(await hmacSha256(norm, msg));
}

export async function computeHostProof(params: {
  pairCode: string;
  deviceId: string;
  clientId: string;
  clientNonce: string;
  hostNonce: string;
  hostPublicKeyJwk: EcdhPublicKeyJwk;
}): Promise<string> {
  const norm = normalizePairCode(params.pairCode);
  const msg = `pair-approve-v1|${String(params.deviceId)}|${String(params.clientId)}|${String(params.clientNonce)}|${String(params.hostNonce)}|${canonicalPublicKeyString(params.hostPublicKeyJwk)}`;
  return base64UrlEncode(await hmacSha256(norm, msg));
}

export async function verifyHostProof(params: {
  pairCode: string;
  deviceId: string;
  clientId: string;
  clientNonce: string;
  hostNonce: string;
  hostPublicKeyJwk: EcdhPublicKeyJwk;
  hostProof: string;
}): Promise<boolean> {
  if (!params.hostProof || typeof params.hostProof !== "string") return false;
  try {
    const expected = await computeHostProof(params);
    return constantTimeEqual(base64UrlDecode(expected), base64UrlDecode(params.hostProof));
  } catch {
    return false;
  }
}

// --- Directional Session Keys & AES-256-GCM Framing ---

export function buildDirectionalIv(
  ivPrefix4: Uint8Array,
  counter: number
): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new Error("Invalid E2EE frame counter");
  }
  const iv = new Uint8Array(new ArrayBuffer(12));
  iv.set(ivPrefix4.subarray(0, 4), 0);
  const view = new DataView(iv.buffer);
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  view.setUint32(4, hi, false);
  view.setUint32(8, lo, false);
  return iv;
}

export function buildFrameAad(params: {
  deviceId: string;
  clientId: string;
  sessionId: string;
  dir: "c2h" | "h2c";
  ctr: number;
}): Uint8Array<ArrayBuffer> {
  return toUint8Array(
    `ufoo-e2ee-v${E2EE_VERSION}|${params.deviceId}|${params.clientId}|${params.sessionId}|${params.dir}|${params.ctr}`
  );
}

export async function deriveHandshakeMacKey(params: {
  staticSharedSecret: Uint8Array<ArrayBuffer>;
  deviceId: string;
  clientId: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  return hkdfDeriveBytes(
    params.staticSharedSecret,
    "ufoo-e2ee-v1-handshake",
    `auth|${params.deviceId}|${params.clientId}`,
    32
  );
}

export async function deriveSessionMaterial(params: {
  staticSharedSecret: Uint8Array<ArrayBuffer>;
  ephemeralSharedSecret?: Uint8Array<ArrayBuffer> | null;
  salt: Uint8Array<ArrayBuffer>;
  deviceId: string;
  clientId: string;
  sessionId: string;
}): Promise<DerivedSessionMaterial> {
  const ikm = params.ephemeralSharedSecret
    ? concatBytes(params.staticSharedSecret, params.ephemeralSharedSecret)
    : toUint8Array(params.staticSharedSecret);
  const contextBase = `ufoo-e2ee-v${E2EE_VERSION}|${params.deviceId}|${params.clientId}|${params.sessionId}`;

  const [c2hKeyRaw, h2cKeyRaw, c2hIvPrefix, h2cIvPrefix] = await Promise.all([
    hkdfDeriveBytes(ikm, params.salt, `${contextBase}|key|c2h`, 32),
    hkdfDeriveBytes(ikm, params.salt, `${contextBase}|key|h2c`, 32),
    hkdfDeriveBytes(ikm, params.salt, `${contextBase}|iv|c2h`, 4),
    hkdfDeriveBytes(ikm, params.salt, `${contextBase}|iv|h2c`, 4),
  ]);

  const subtle = getSubtle();
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
 * Stateful authenticated E2EE session (browser client role).
 *
 * Handshake:
 *   client -> host: hs_init { v:1, t:"hs_init", sid, epk, n, tag }
 *   host -> client: hs_ack  { v:1, t:"hs_ack",  sid, epk, n, tag }
 *
 * Encrypted frames:
 *   { v:1, t:"msg", sid, dir:"c2h"|"h2c", ctr, ct }
 */
export class E2eeSession {
  readonly role: "client" | "host";
  readonly deviceId: string;
  readonly clientId: string;
  readonly localPrivateKeyJwk: EcdhPrivateKeyJwk;
  readonly peerPublicKeyJwk: EcdhPublicKeyJwk;
  readonly outboundDir: "c2h" | "h2c";
  readonly inboundDir: "c2h" | "h2c";

  sessionId = "";
  ready = false;

  private _staticSecret: Uint8Array<ArrayBuffer> | null = null;
  private _macKey: Uint8Array<ArrayBuffer> | null = null;
  private _ephemKeyPair: EcdhKeyPairResult | null = null;
  private _clientNonce: Uint8Array<ArrayBuffer> | null = null;
  private _keys: DerivedSessionMaterial | null = null;
  private _sendCtr = 0;
  private _lastRecvCtr = 0;

  constructor(options: {
    role?: "client" | "host";
    deviceId: string;
    clientId: string;
    localPrivateKeyJwk: EcdhPrivateKeyJwk;
    peerPublicKeyJwk: EcdhPublicKeyJwk;
  }) {
    const role = options.role ?? "client";
    if (role !== "client" && role !== "host") {
      throw new Error("role must be 'client' or 'host'");
    }
    if (!options.deviceId || !options.clientId) {
      throw new Error("deviceId and clientId are required");
    }
    this.role = role;
    this.deviceId = String(options.deviceId);
    this.clientId = String(options.clientId);
    this.localPrivateKeyJwk = options.localPrivateKeyJwk;
    this.peerPublicKeyJwk = sanitizePublicKeyJwk(options.peerPublicKeyJwk);
    this.outboundDir = role === "client" ? "c2h" : "h2c";
    this.inboundDir = role === "client" ? "h2c" : "c2h";
  }

  private async _ensureStatic(): Promise<void> {
    if (!this._staticSecret) {
      this._staticSecret = await deriveSharedSecret(this.localPrivateKeyJwk, this.peerPublicKeyJwk);
      this._macKey = await deriveHandshakeMacKey({
        staticSharedSecret: this._staticSecret,
        deviceId: this.deviceId,
        clientId: this.clientId,
      });
    }
  }

  async createHandshakeInit(): Promise<HandshakeInitFrame> {
    if (this.role !== "client") {
      throw new Error("Only client role can create hs_init");
    }
    await this._ensureStatic();
    this.sessionId = randomHex(16);
    this._ephemKeyPair = await generateEcdhKeyPair();
    this._clientNonce = randomBytes(16);
    const nB64 = base64UrlEncode(this._clientNonce);
    const macInput = `c2h|${this.sessionId}|${nB64}|${canonicalPublicKeyString(this._ephemKeyPair.publicKeyJwk)}`;
    const tag = base64UrlEncode(await hmacSha256(this._macKey!, macInput));
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

  async completeHandshakeAck(ackFrame: unknown): Promise<boolean> {
    if (this.role !== "client") {
      throw new Error("Only client role can complete hs_ack");
    }
    if (!this._ephemKeyPair || !this._clientNonce || !this.sessionId) {
      throw new Error("No handshake init in progress");
    }
    const ack = ackFrame as Partial<HandshakeAckFrame> | null;
    if (!ack || ack.v !== E2EE_VERSION || ack.t !== "hs_ack") {
      throw new Error("Invalid handshake ack frame");
    }
    if (ack.sid !== this.sessionId || typeof ack.n !== "string" || typeof ack.tag !== "string") {
      throw new Error("Handshake session mismatch");
    }
    if (!validatePublicKeyJwk(ack.epk)) {
      throw new Error("Invalid host ephemeral public key");
    }

    await this._ensureStatic();
    const clientNonceB64 = base64UrlEncode(this._clientNonce);
    const expectedInput = `h2c|${this.sessionId}|${clientNonceB64}|${ack.n}|${canonicalPublicKeyString(ack.epk)}`;
    const expectedTag = await hmacSha256(this._macKey!, expectedInput);
    const actualTag = base64UrlDecode(ack.tag);
    if (!constantTimeEqual(expectedTag, actualTag)) {
      throw new Error("Host handshake authentication failed");
    }

    const hostNonce = base64UrlDecode(ack.n);
    const ephemSecret = await deriveSharedSecret(this._ephemKeyPair.privateKey, ack.epk);
    const salt = concatBytes(this._clientNonce, hostNonce);
    this._keys = await deriveSessionMaterial({
      staticSharedSecret: this._staticSecret!,
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

  async encryptJson(obj: unknown): Promise<EncryptedMessageFrame> {
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
    const plaintext = toUint8Array(JSON.stringify(obj));
    const ctBuf = await getSubtle().encrypt(
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

  async decryptJson<T = Record<string, any>>(rawFrame: unknown): Promise<T> {
    if (!this.ready || !this._keys) {
      throw new Error("E2EE session not established");
    }
    const frame = rawFrame as Partial<EncryptedMessageFrame> | null;
    if (!frame || frame.v !== E2EE_VERSION || frame.t !== "msg") {
      throw new Error("Invalid E2EE message frame");
    }
    if (frame.sid !== this.sessionId) {
      throw new Error("E2EE session ID mismatch");
    }
    if (frame.dir !== this.inboundDir) {
      throw new Error(`Invalid E2EE frame direction "${String(frame.dir)}"`);
    }
    const ctr = frame.ctr;
    if (typeof ctr !== "number" || !Number.isSafeInteger(ctr) || ctr <= this._lastRecvCtr) {
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
    let plainBuf: ArrayBuffer;
    try {
      plainBuf = await getSubtle().decrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        key,
        ctBytes
      );
    } catch {
      throw new Error("E2EE decryption/authentication failed");
    }

    // Advance replay cursor ONLY after AES-GCM tag verification succeeds!
    this._lastRecvCtr = ctr;
    return JSON.parse(textDecoder.decode(new Uint8Array(plainBuf))) as T;
  }
}
