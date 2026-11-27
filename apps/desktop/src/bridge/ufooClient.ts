import type {
  BridgeTransportMode,
  RemotePairedDevice,
  RemotePairingState,
  RemotePairTicket,
  RemoteSessionInfo,
  RemoteStatusSnapshot,
  UiEnvelope,
} from "../types";
import {
  E2eeSession,
  base64UrlEncode,
  canonicalPublicKeyString,
  computeClaimProof,
  computeKeyFingerprint,
  formatPairCode,
  generateEcdhKeyPair,
  hashPairCode,
  normalizePairCode,
  randomBytes,
  randomHex,
  sanitizePublicKeyJwk,
  validatePublicKeyJwk,
  verifyHostProof,
  type EcdhPrivateKeyJwk,
  type EcdhPublicKeyJwk,
} from "./remoteCrypto";

export type { BridgeTransportMode };

const previewProjectRoot = "/workspace/ufoo";
const REMOTE_SESSION_STORAGE_KEY = "ufoo.remote.session.v1";
const KEEPALIVE_INTERVAL_MS = 15_000;
const P2P_PROBE_TIMEOUT_MS = 1_000;
const P2P_CONNECT_TIMEOUT_MS = 3_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const COMMAND_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 15_000;

type EventListener = (envelope: UiEnvelope) => void;
type TransportListener = (snapshot: RemoteTransportSnapshot) => void;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriEnvironment(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export interface RemoteSessionCredentials {
  version: 1;
  relayUrl: string;
  deviceId: string;
  deviceName: string;
  hostPublicKeyJwk: EcdhPublicKeyJwk;
  hostFingerprint: string;
  clientId: string;
  clientLabel: string;
  clientPublicKeyJwk: EcdhPublicKeyJwk;
  clientPrivateKeyJwk: EcdhPrivateKeyJwk;
  clientFingerprint: string;
  remoteToken: string;
  pairedAt: string;
}

export interface RemoteDeepLinkParams {
  relayUrl: string;
  pairCode: string;
  deviceId: string;
  fingerprint: string;
}

export interface RemoteTransportSnapshot {
  mode: BridgeTransportMode;
  pairingState: RemotePairingState;
  deviceId: string;
  deviceName: string;
  hostFingerprint: string;
  clientId: string;
  clientLabel: string;
  relayUrl: string;
  error: string;
  hasSavedSession: boolean;
  routeDeviceId: string;
  deepLinkParams: RemoteDeepLinkParams | null;
}

export interface PairRemoteOptions {
  relayUrl: string;
  pairCode: string;
  label?: string;
  deviceId?: string;
  expectedFingerprint?: string;
}

export interface UiTransportAdapter {
  mode: BridgeTransportMode;
  connect(onEnvelope: EventListener): Promise<void>;
  sendCommand<T = Record<string, any>>(
    name: string,
    requestId: string,
    payload: Record<string, any>
  ): Promise<T>;
}

export function normalizeRelayUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    throw new Error("Relay URL is required");
  }
  let candidate = trimmed;
  if (/^https:\/\//i.test(candidate)) {
    candidate = "wss://" + candidate.slice("https://".length);
  } else if (/^http:\/\//i.test(candidate)) {
    candidate = "ws://" + candidate.slice("http://".length);
  } else if (!/^wss?:\/\//i.test(candidate)) {
    const isLocalHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(candidate);
    candidate = `${isLocalHost ? "ws" : "wss"}://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid relay URL: ${trimmed}`);
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error("Relay URL must use wss:// or ws://");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/ufoo/online";
  }
  return parsed.toString();
}

export function defaultDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Web Client";
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone Safari";
  if (/iPad/i.test(ua)) return "iPad Safari";
  if (/Android/i.test(ua)) return "Android Browser";
  if (/Macintosh/i.test(ua)) return "Mac Browser";
  if (/Windows/i.test(ua)) return "Windows Browser";
  if (/Linux/i.test(ua)) return "Linux Browser";
  return "Web Client";
}

function loadSavedCredentials(): RemoteSessionCredentials | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REMOTE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RemoteSessionCredentials>;
    if (
      parsed
      && parsed.version === 1
      && typeof parsed.relayUrl === "string"
      && parsed.relayUrl
      && typeof parsed.deviceId === "string"
      && parsed.deviceId
      && typeof parsed.clientId === "string"
      && parsed.clientId
      && typeof parsed.remoteToken === "string"
      && parsed.remoteToken
      && validatePublicKeyJwk(parsed.hostPublicKeyJwk)
      && validatePublicKeyJwk(parsed.clientPublicKeyJwk)
      && validatePublicKeyJwk(parsed.clientPrivateKeyJwk)
      && typeof parsed.clientPrivateKeyJwk?.d === "string"
    ) {
      return parsed as RemoteSessionCredentials;
    }
  } catch {
    // ignore corrupted storage
  }
  return null;
}

function saveCredentials(creds: RemoteSessionCredentials): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMOTE_SESSION_STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // ignore quota errors
  }
}

function clearSavedCredentials(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(REMOTE_SESSION_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

const DEFAULT_HOSTED_RELAY_URL = "wss://online.ufoo.dev/ufoo/online";

export function inferDefaultRelayUrl(): string {
  if (typeof window === "undefined") return DEFAULT_HOSTED_RELAY_URL;
  try {
    const { protocol, host, hostname, port } = window.location;
    if ((protocol === "https:" || protocol === "http:") && host) {
      // Local Vite dev server does not host the /ufoo/online WebSocket relay
      const isViteDev =
        (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") &&
        (port === "1420" || port === "5173");
      if (!isViteDev) {
        const wsProto = protocol === "http:" ? "ws:" : "wss:";
        return `${wsProto}//${host}/ufoo/online`;
      }
    }
  } catch {
    // ignore invalid window.location
  }
  return DEFAULT_HOSTED_RELAY_URL;
}

export function isSameOriginDefaultRelay(relayUrl: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const inferred = inferDefaultRelayUrl();
    return relayUrl.trim().replace(/\/+$/, "").toLowerCase() === inferred.replace(/\/+$/, "").toLowerCase();
  } catch {
    return false;
  }
}

export function extractRemoteRouteDeviceId(pathname?: string): string {
  const rawPath =
    typeof pathname === "string"
      ? pathname
      : typeof window !== "undefined"
      ? window.location.pathname
      : "";
  const match = rawPath.match(/^\/remote\/([^/?#]+)\/?$/i);
  if (!match || !match[1]) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

function parseUrlBootstrap(): {
  preview: boolean;
  routeDeviceId: string;
  deepLink: RemoteDeepLinkParams | null;
} {
  if (typeof window === "undefined") {
    return { preview: false, routeDeviceId: "", deepLink: null };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const preview = params.get("preview") === "1" || params.get("preview") === "true";
    const routeDeviceId = extractRemoteRouteDeviceId(window.location.pathname);
    const explicitRelay = (params.get("relay") || "").trim();
    const relay = explicitRelay || inferDefaultRelayUrl();
    const pair = (params.get("pair") || "").trim();
    const device = routeDeviceId || (params.get("device") || "").trim();
    const fp = (params.get("fp") || "").trim().toUpperCase();
    if (pair && relay) {
      return {
        preview,
        routeDeviceId,
        deepLink: {
          relayUrl: relay,
          pairCode: formatPairCode(pair),
          deviceId: device,
          fingerprint: fp,
        },
      };
    }
    return { preview, routeDeviceId, deepLink: null };
  } catch {
    return { preview: false, routeDeviceId: "", deepLink: null };
  }
}

function syncRemoteUrlPath(deviceId?: string): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    const cleanId = String(deviceId || "").trim();
    const desiredPath = cleanId ? `/remote/${encodeURIComponent(cleanId)}` : url.pathname;
    let mutated = url.pathname !== desiredPath;
    if (cleanId) {
      url.pathname = desiredPath;
    }
    for (const key of ["pair", "device", "fp", "relay"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        mutated = true;
      }
    }
    if (mutated) {
      const next = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(null, "", next);
    }
  } catch {
    // ignore history errors
  }
}

function credentialsToSessionInfo(creds: RemoteSessionCredentials | null): RemoteSessionInfo | null {
  if (!creds) return null;
  return {
    relayUrl: creds.relayUrl,
    deviceId: creds.deviceId,
    deviceName: creds.deviceName,
    hostFingerprint: creds.hostFingerprint,
    clientId: creds.clientId,
    clientLabel: creds.clientLabel,
    clientFingerprint: creds.clientFingerprint,
    pairedAt: creds.pairedAt,
  };
}

interface PendingCommand {
  resolve: (val: any) => void;
  reject: (err: Error) => void;
  timer: number;
}

interface RemoteE2eeCallbacks {
  onEnvelope: EventListener;
  onStateChange: (update: {
    mode: BridgeTransportMode;
    pairingState: RemotePairingState;
    error?: string;
    credentials?: RemoteSessionCredentials | null;
    connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  }) => void;
  onRevoked: (message: string) => void;
}

class RemoteE2eeTransport implements UiTransportAdapter {
  mode: BridgeTransportMode = "unpaired";

  private credentials: RemoteSessionCredentials | null = null;
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private e2ee: E2eeSession | null = null;
  private activeChannel: "p2p" | "relay" = "relay";

  private lastSeq = 0;
  private hasInitialSync = false;
  private closed = false;
  private intentionalDisconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private keepaliveTimer: number | null = null;
  private syncSeq = 0;
  private failingOverToRelay = false;

  private pendingCommands = new Map<string, PendingCommand>();
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();

  // Ephemeral handshake/probe waiters
  private handshakeWaiter: {
    resolve: (frame: any) => void;
    reject: (err: Error) => void;
    timer: number;
  } | null = null;
  private probeWaiter: {
    signalId: string;
    resolve: (probe: any) => void;
    timer: number;
  } | null = null;
  private p2pSignalId = "";

  constructor(private callbacks: RemoteE2eeCallbacks) {}

  getCredentials(): RemoteSessionCredentials | null {
    return this.credentials;
  }

  async connect(onEnvelope: EventListener): Promise<void> {
    this.callbacks.onEnvelope = onEnvelope;
    const saved = loadSavedCredentials();
    if (!saved) return;
    await this.connectWithCredentials(saved);
  }

  async pair(opts: PairRemoteOptions): Promise<RemoteSessionCredentials> {
    this.stopReconnectTimer();
    this.teardownConnection(false);
    this.closed = false;
    this.intentionalDisconnect = false;

    const relayUrl = normalizeRelayUrl(opts.relayUrl);
    const normCode = normalizePairCode(opts.pairCode);
    if (!normCode || normCode.length < 4) {
      throw new Error("Enter a valid pairing code");
    }

    const clientLabel = String(opts.label || defaultDeviceLabel()).trim().slice(0, 64) || "Web Client";
    this.callbacks.onStateChange({
      mode: "unpaired",
      pairingState: "pairing",
      error: "",
      connectionState: "connecting",
    });

    const kp = await generateEcdhKeyPair();
    const clientId = `cli_${randomHex(12)}`;
    const clientNonce = base64UrlEncode(randomBytes(16));
    const codeHash = await hashPairCode(normCode);
    const claimProof = await computeClaimProof({
      pairCode: normCode,
      clientId,
      clientNonce,
      clientPublicKeyJwk: kp.publicKeyJwk,
    });

    const socket = await this.openSocket(relayUrl, 10_000);
    this.ws = socket;
    this.startKeepalive();

    const claimed = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for host to approve pairing"));
      }, 18_000);

      const onMsg = (evt: MessageEvent) => {
        let msg: any;
        try {
          msg = JSON.parse(String(evt.data || ""));
        } catch {
          return;
        }
        if (msg.type === "pair.claimed" && msg.ok) {
          cleanup();
          resolve(msg);
          return;
        }
        if (msg.type === "error") {
          cleanup();
          reject(new Error(String(msg.error || msg.code || "Pairing rejected")));
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Relay connection closed during pairing"));
      };

      const cleanup = () => {
        window.clearTimeout(timer);
        socket.removeEventListener("message", onMsg);
        socket.removeEventListener("close", onClose);
      };

      socket.addEventListener("message", onMsg);
      socket.addEventListener("close", onClose);

      socket.send(
        JSON.stringify({
          type: "pair.claim",
          code_hash: codeHash,
          ...(opts.deviceId ? { device_id: opts.deviceId } : {}),
          client_id: clientId,
          label: clientLabel,
          client_public_key: kp.publicKeyJwk,
          client_nonce: clientNonce,
          claim_proof: claimProof,
        })
      );
    }).catch((err) => {
      this.teardownConnection(false);
      this.callbacks.onStateChange({
        mode: "unpaired",
        pairingState: "error",
        error: err instanceof Error ? err.message : String(err),
        connectionState: "offline",
      });
      throw err;
    });

    if (!validatePublicKeyJwk(claimed.host_public_key)) {
      this.teardownConnection(false);
      const err = new Error("Host returned an invalid public key");
      this.callbacks.onStateChange({
        mode: "unpaired",
        pairingState: "error",
        error: err.message,
        connectionState: "offline",
      });
      throw err;
    }

    const hostPublicKeyJwk = sanitizePublicKeyJwk(claimed.host_public_key);
    const hostProofValid = await verifyHostProof({
      pairCode: normCode,
      deviceId: String(claimed.device_id || ""),
      clientId,
      clientNonce,
      hostNonce: String(claimed.host_nonce || ""),
      hostPublicKeyJwk,
      hostProof: String(claimed.host_proof || ""),
    });
    if (!hostProofValid) {
      this.teardownConnection(false);
      const err = new Error("Host cryptographic proof verification failed");
      this.callbacks.onStateChange({
        mode: "unpaired",
        pairingState: "error",
        error: err.message,
        connectionState: "offline",
      });
      throw err;
    }

    const hostFingerprint = await computeKeyFingerprint(hostPublicKeyJwk);
    if (opts.expectedFingerprint) {
      const expected = opts.expectedFingerprint.trim().toUpperCase();
      if (expected && hostFingerprint !== expected) {
        this.teardownConnection(false);
        const err = new Error(`Host fingerprint mismatch (expected ${expected}, got ${hostFingerprint})`);
        this.callbacks.onStateChange({
          mode: "unpaired",
          pairingState: "error",
          error: err.message,
          connectionState: "offline",
        });
        throw err;
      }
    }

    const creds: RemoteSessionCredentials = {
      version: 1,
      relayUrl,
      deviceId: String(claimed.device_id),
      deviceName: String(claimed.device_name || claimed.device_id),
      hostPublicKeyJwk,
      hostFingerprint,
      clientId,
      clientLabel,
      clientPublicKeyJwk: kp.publicKeyJwk,
      clientPrivateKeyJwk: kp.privateKeyJwk,
      clientFingerprint: kp.fingerprint,
      remoteToken: String(claimed.remote_token || ""),
      pairedAt: new Date().toISOString(),
    };

    this.credentials = creds;
    saveCredentials(creds);
    syncRemoteUrlPath(creds.deviceId);

    this.callbacks.onStateChange({
      mode: "remote-relay",
      pairingState: "connecting",
      error: "",
      credentials: creds,
      connectionState: "connecting",
    });

    // Attach permanent runtime WS handlers on the already-authenticated socket
    this.attachSocketHandlers(socket);

    // Brief settle so host finishes persisting paired_clients.json after pair.approved_ack
    await new Promise((r) => window.setTimeout(r, 140));

    try {
      await this.negotiateTransportAndHandshake();
      return creds;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStateChange({
        mode: this.mode,
        pairingState: "error",
        error: msg,
        credentials: creds,
        connectionState: "reconnecting",
      });
      this.scheduleReconnect();
      throw err;
    }
  }

  async connectWithCredentials(creds: RemoteSessionCredentials): Promise<void> {
    this.stopReconnectTimer();
    this.teardownConnection(false);
    this.closed = false;
    this.intentionalDisconnect = false;
    this.credentials = creds;

    this.callbacks.onStateChange({
      mode: this.mode === "remote-p2p" ? "remote-p2p" : "remote-relay",
      pairingState: "connecting",
      error: "",
      credentials: creds,
      connectionState: this.hasInitialSync ? "reconnecting" : "connecting",
    });

    let socket: WebSocket;
    try {
      socket = await this.openSocket(creds.relayUrl, 10_000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unable to reach relay server";
      this.callbacks.onStateChange({
        mode: "remote-relay",
        pairingState: "error",
        error: msg,
        credentials: creds,
        connectionState: "reconnecting",
      });
      this.scheduleReconnect();
      throw err;
    }

    this.ws = socket;
    this.startKeepalive();

    const authResult = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out authenticating with relay"));
      }, 10_000);

      const onMsg = (evt: MessageEvent) => {
        let msg: any;
        try {
          msg = JSON.parse(String(evt.data || ""));
        } catch {
          return;
        }
        if (msg.type === "remote.auth_ok" && msg.ok) {
          cleanup();
          resolve(msg);
          return;
        }
        if (msg.type === "error") {
          cleanup();
          const e = new Error(String(msg.error || msg.code || "Authentication failed")) as Error & {
            code?: string;
          };
          e.code = String(msg.code || "");
          reject(e);
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Relay connection closed during auth"));
      };

      const cleanup = () => {
        window.clearTimeout(timer);
        socket.removeEventListener("message", onMsg);
        socket.removeEventListener("close", onClose);
      };

      socket.addEventListener("message", onMsg);
      socket.addEventListener("close", onClose);

      socket.send(
        JSON.stringify({
          type: "remote.auth",
          device_id: creds.deviceId,
          client_id: creds.clientId,
          remote_token: creds.remoteToken,
        })
      );
    }).catch((err: Error & { code?: string }) => {
      this.teardownConnection(false);
      if (err.code === "CLIENT_REVOKED") {
        this.handleRevoked(err.message || "This device's remote access was revoked by the host.");
        throw err;
      }
      this.callbacks.onStateChange({
        mode: "remote-relay",
        pairingState: "error",
        error: err.message,
        credentials: creds,
        connectionState: "reconnecting",
      });
      this.scheduleReconnect();
      throw err;
    });

    // Verify pinned host public key matches what we paired with
    if (validatePublicKeyJwk(authResult.host_public_key)) {
      const actualCanon = canonicalPublicKeyString(authResult.host_public_key);
      const expectedCanon = canonicalPublicKeyString(creds.hostPublicKeyJwk);
      if (actualCanon !== expectedCanon) {
        this.teardownConnection(false);
        const err = new Error("Host identity key changed unexpectedly. Please unpair and pair again.");
        this.callbacks.onStateChange({
          mode: "remote-relay",
          pairingState: "error",
          error: err.message,
          credentials: creds,
          connectionState: "offline",
        });
        throw err;
      }
    }

    if (authResult.device_name && authResult.device_name !== creds.deviceName) {
      creds = { ...creds, deviceName: String(authResult.device_name) };
      this.credentials = creds;
      saveCredentials(creds);
    }

    this.attachSocketHandlers(socket);

    try {
      await this.negotiateTransportAndHandshake();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStateChange({
        mode: "remote-relay",
        pairingState: "error",
        error: msg,
        credentials: creds,
        connectionState: "reconnecting",
      });
      this.scheduleReconnect();
      throw err;
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopReconnectTimer();
    this.teardownConnection(true);
    this.callbacks.onStateChange({
      mode: this.credentials ? "remote-relay" : "unpaired",
      pairingState: "idle",
      error: "",
      credentials: this.credentials,
      connectionState: "offline",
    });
  }

  unpair(): void {
    this.intentionalDisconnect = true;
    this.closed = true;
    this.stopReconnectTimer();
    this.teardownConnection(true);
    this.credentials = null;
    this.lastSeq = 0;
    this.hasInitialSync = false;
    this.mode = "unpaired";
    clearSavedCredentials();
    this.callbacks.onStateChange({
      mode: "unpaired",
      pairingState: "idle",
      error: "",
      credentials: null,
      connectionState: "offline",
    });
  }

  async sendCommand<T = Record<string, any>>(
    name: string,
    requestId: string,
    payload: Record<string, any>
  ): Promise<T> {
    if (!this.e2ee || !this.e2ee.ready) {
      throw new Error("Encrypted remote session is not connected");
    }
    const envelope: UiEnvelope = {
      protocol: "ufoo-ui/1",
      kind: "command",
      name,
      request_id: requestId,
      payload,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pendingCommands.has(requestId)) {
          this.pendingCommands.delete(requestId);
          reject(new Error(`Remote command "${name}" timed out`));
        }
      }, COMMAND_TIMEOUT_MS);

      this.pendingCommands.set(requestId, { resolve, reject, timer });

      this.enqueueEncryptedSend(envelope).catch((err) => {
        const entry = this.pendingCommands.get(requestId);
        if (entry) {
          window.clearTimeout(entry.timer);
          this.pendingCommands.delete(requestId);
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private handleRevoked(message: string): void {
    this.intentionalDisconnect = true;
    this.stopReconnectTimer();
    this.teardownConnection(true);
    this.credentials = null;
    this.lastSeq = 0;
    this.hasInitialSync = false;
    this.mode = "unpaired";
    clearSavedCredentials();
    this.callbacks.onRevoked(message);
  }

  private openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to relay ${url}`));
      }, timeoutMs);

      socket.addEventListener(
        "open",
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(socket);
        },
        { once: true }
      );

      socket.addEventListener(
        "error",
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(`Failed to connect to relay ${url}`));
        },
        { once: true }
      );

      socket.addEventListener(
        "close",
        () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(new Error(`Relay connection closed (${url})`));
        },
        { once: true }
      );
    });
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // ignore
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closePeerConnection(): void {
    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onmessage = null;
      this.dc.onclose = null;
      this.dc.onerror = null;
      try {
        this.dc.close();
      } catch {
        // ignore
      }
      this.dc = null;
    }
    if (this.pc) {
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      try {
        this.pc.close();
      } catch {
        // ignore
      }
      this.pc = null;
    }
    this.p2pSignalId = "";
  }

  private teardownConnection(rejectPending: boolean): void {
    this.stopKeepalive();
    if (this.handshakeWaiter) {
      window.clearTimeout(this.handshakeWaiter.timer);
      this.handshakeWaiter.reject(new Error("Connection closed during E2EE handshake"));
      this.handshakeWaiter = null;
    }
    if (this.probeWaiter) {
      window.clearTimeout(this.probeWaiter.timer);
      this.probeWaiter.resolve(null);
      this.probeWaiter = null;
    }
    this.closePeerConnection();
    this.e2ee = null;
    this.activeChannel = "relay";
    this.sendChain = Promise.resolve();
    this.recvChain = Promise.resolve();

    const prevWs = this.ws;
    this.ws = null;
    if (prevWs) {
      prevWs.onmessage = null;
      prevWs.onclose = null;
      prevWs.onerror = null;
      try {
        prevWs.close();
      } catch {
        // ignore
      }
    }

    if (rejectPending) {
      for (const [, waiter] of this.pendingCommands.entries()) {
        window.clearTimeout(waiter.timer);
        waiter.reject(new Error("Remote connection closed"));
      }
      this.pendingCommands.clear();
    }
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.onmessage = (evt) => {
      if (this.ws !== socket) return;
      let msg: any;
      try {
        msg = JSON.parse(String(evt.data || ""));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "pong") return;

      if (msg.type === "signal.probe") {
        if (this.probeWaiter && (!msg.signal_id || msg.signal_id === this.probeWaiter.signalId)) {
          const waiter = this.probeWaiter;
          this.probeWaiter = null;
          window.clearTimeout(waiter.timer);
          waiter.resolve(msg.probe || null);
        }
        return;
      }

      if (msg.type === "signal.answer" && msg.sdp && this.pc) {
        void this.pc.setRemoteDescription(msg.sdp).catch(() => {});
        return;
      }

      if (msg.type === "signal.ice" && msg.candidate && this.pc) {
        void this.pc.addIceCandidate(msg.candidate).catch(() => {});
        return;
      }

      if (msg.type === "relay.frame") {
        this.handleIncomingRawFrame(msg.frame, "relay");
        return;
      }

      if (msg.type === "device.offline") {
        this.e2ee = null;
        this.closePeerConnection();
        this.callbacks.onStateChange({
          mode: "remote-relay",
          pairingState: "connecting",
          error: "Host device went offline. Waiting to reconnect…",
          credentials: this.credentials,
          connectionState: "reconnecting",
        });
        this.scheduleReconnect();
        return;
      }

      if (msg.type === "error") {
        const code = String(msg.code || "");
        const errText = String(msg.error || code || "Relay error");
        if (code === "CLIENT_REVOKED") {
          this.handleRevoked(errText || "This device was revoked by the host.");
          return;
        }
        if (code === "DEVICE_OFFLINE") {
          this.callbacks.onStateChange({
            mode: "remote-relay",
            pairingState: "error",
            error: "Host device is currently offline",
            credentials: this.credentials,
            connectionState: "reconnecting",
          });
        }
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.stopKeepalive();
      if (this.handshakeWaiter) {
        window.clearTimeout(this.handshakeWaiter.timer);
        this.handshakeWaiter.reject(new Error("Relay socket closed"));
        this.handshakeWaiter = null;
      }
      // If active channel is P2P and DC is still open, keep running on P2P while WS reconnects?
      // Simpler & safer: if WS drops, schedule reconnect if not intentional.
      if (!this.intentionalDisconnect && this.credentials) {
        this.e2ee = null;
        this.closePeerConnection();
        this.callbacks.onStateChange({
          mode: "remote-relay",
          pairingState: "connecting",
          error: "",
          credentials: this.credentials,
          connectionState: "reconnecting",
        });
        this.scheduleReconnect();
      }
    };

    socket.onerror = () => {
      // close event handles reconnect
    };
  }

  private async negotiateTransportAndHandshake(): Promise<void> {
    if (!this.credentials) throw new Error("Missing remote credentials");

    // 1. P2P-first probe via relay signaling
    let useP2p = false;
    if (typeof RTCPeerConnection !== "undefined") {
      const probe = await this.probeHostWebRtc();
      if (probe && probe.webrtc_supported === true) {
        useP2p = await this.tryEstablishWebRtcDataChannel(probe.ice_servers);
      }
    }

    // 2. Establish authenticated E2EE session on chosen transport
    if (useP2p) {
      try {
        await this.performE2eeHandshake("p2p");
      } catch {
        // Fallback seamlessly to relay if P2P handshake fails
        this.closePeerConnection();
        await this.performE2eeHandshake("relay");
      }
    } else {
      await this.performE2eeHandshake("relay");
    }

    this.reconnectAttempt = 0;
    this.mode = this.activeChannel === "p2p" ? "remote-p2p" : "remote-relay";
    this.callbacks.onStateChange({
      mode: this.mode,
      pairingState: "connected",
      error: "",
      credentials: this.credentials,
      connectionState: "connected",
    });

    // 3. Initial snapshot or delta catchup
    await this.syncAfterConnect();
  }

  private probeHostWebRtc(): Promise<{ webrtc_supported?: boolean; ice_servers?: RTCIceServer[] } | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.credentials) {
      return Promise.resolve(null);
    }
    const signalId = `probe_${randomHex(6)}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (this.probeWaiter?.signalId === signalId) {
          this.probeWaiter = null;
        }
        resolve(null);
      }, P2P_PROBE_TIMEOUT_MS);

      this.probeWaiter = { signalId, resolve, timer };
      try {
        this.ws!.send(
          JSON.stringify({
            type: "signal.probe",
            device_id: this.credentials!.deviceId,
            signal_id: signalId,
            probe: { webrtc_supported: true, protocol: "ufoo-e2ee-v1" },
          })
        );
      } catch {
        window.clearTimeout(timer);
        this.probeWaiter = null;
        resolve(null);
      }
    });
  }

  private tryEstablishWebRtcDataChannel(iceServers?: RTCIceServer[]): Promise<boolean> {
    if (
      typeof RTCPeerConnection === "undefined"
      || !this.ws
      || this.ws.readyState !== WebSocket.OPEN
      || !this.credentials
    ) {
      return Promise.resolve(false);
    }

    this.closePeerConnection();
    const signalId = `p2p_${randomHex(6)}`;
    this.p2pSignalId = signalId;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        if (!ok) this.closePeerConnection();
        resolve(ok);
      };

      const timer = window.setTimeout(() => finish(false), P2P_CONNECT_TIMEOUT_MS);

      try {
        const pc = new RTCPeerConnection({
          iceServers:
            Array.isArray(iceServers) && iceServers.length > 0
              ? iceServers
              : [{ urls: "stun:stun.l.google.com:19302" }],
        });
        this.pc = pc;

        const dc = pc.createDataChannel("ufoo-e2ee", { ordered: true });
        this.dc = dc;

        pc.onicecandidate = (evt) => {
          if (evt.candidate && this.ws && this.ws.readyState === WebSocket.OPEN && this.credentials) {
            this.ws.send(
              JSON.stringify({
                type: "signal.ice",
                device_id: this.credentials.deviceId,
                signal_id: signalId,
                candidate: evt.candidate.toJSON ? evt.candidate.toJSON() : evt.candidate,
              })
            );
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
            if (!settled) {
              finish(false);
            } else if (this.activeChannel === "p2p") {
              void this.failoverP2pToRelay();
            }
          }
        };

        dc.onopen = () => {
          finish(true);
        };

        dc.onmessage = (evt) => {
          try {
            const parsed = JSON.parse(String(evt.data || ""));
            this.handleIncomingRawFrame(parsed, "p2p");
          } catch {
            // ignore malformed frame
          }
        };

        dc.onclose = () => {
          if (!settled) {
            finish(false);
          } else if (this.activeChannel === "p2p") {
            void this.failoverP2pToRelay();
          }
        };

        dc.onerror = () => {
          if (!settled) {
            finish(false);
          } else if (this.activeChannel === "p2p") {
            void this.failoverP2pToRelay();
          }
        };

        void (async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (this.ws && this.ws.readyState === WebSocket.OPEN && this.credentials) {
            this.ws.send(
              JSON.stringify({
                type: "signal.offer",
                device_id: this.credentials.deviceId,
                signal_id: signalId,
                sdp: pc.localDescription || offer,
              })
            );
          } else {
            finish(false);
          }
        })().catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  private async failoverP2pToRelay(): Promise<void> {
    if (this.failingOverToRelay || this.intentionalDisconnect || !this.credentials) return;
    this.failingOverToRelay = true;
    try {
      this.closePeerConnection();
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.scheduleReconnect();
        return;
      }
      this.callbacks.onStateChange({
        mode: "remote-relay",
        pairingState: "connecting",
        error: "",
        credentials: this.credentials,
        connectionState: "reconnecting",
      });
      await this.performE2eeHandshake("relay");
      this.mode = "remote-relay";
      this.callbacks.onStateChange({
        mode: "remote-relay",
        pairingState: "connected",
        error: "",
        credentials: this.credentials,
        connectionState: "connected",
      });
      await this.syncAfterConnect();
    } catch {
      this.scheduleReconnect();
    } finally {
      this.failingOverToRelay = false;
    }
  }

  private async performE2eeHandshake(channel: "p2p" | "relay"): Promise<void> {
    if (!this.credentials) throw new Error("Missing credentials for E2EE handshake");
    this.activeChannel = channel;
    this.sendChain = Promise.resolve();
    this.recvChain = Promise.resolve();

    const session = new E2eeSession({
      role: "client",
      deviceId: this.credentials.deviceId,
      clientId: this.credentials.clientId,
      localPrivateKeyJwk: this.credentials.clientPrivateKeyJwk,
      peerPublicKeyJwk: this.credentials.hostPublicKeyJwk,
    });
    const initFrame = await session.createHandshakeInit();

    const ackFrame = await new Promise<any>((resolve, reject) => {
      if (this.handshakeWaiter) {
        window.clearTimeout(this.handshakeWaiter.timer);
        this.handshakeWaiter.reject(new Error("Superseded by new handshake"));
      }
      const timer = window.setTimeout(() => {
        this.handshakeWaiter = null;
        reject(new Error("Timed out waiting for host E2EE handshake ack"));
      }, HANDSHAKE_TIMEOUT_MS);
      this.handshakeWaiter = { resolve, reject, timer };
      const sent = this.sendRawFrame(initFrame, channel);
      if (!sent) {
        window.clearTimeout(timer);
        this.handshakeWaiter = null;
        reject(new Error("Failed to transmit E2EE handshake init"));
      }
    });

    await session.completeHandshakeAck(ackFrame);
    this.e2ee = session;
  }

  private sendRawFrame(frame: unknown, channel = this.activeChannel): boolean {
    if (channel === "p2p" && this.dc && this.dc.readyState === "open") {
      try {
        this.dc.send(JSON.stringify(frame));
        return true;
      } catch {
        return false;
      }
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.credentials) {
      try {
        this.ws.send(
          JSON.stringify({
            type: "relay.frame",
            device_id: this.credentials.deviceId,
            frame,
          })
        );
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private enqueueEncryptedSend(envelope: UiEnvelope): Promise<void> {
    const task = this.sendChain.then(async () => {
      if (!this.e2ee || !this.e2ee.ready) {
        throw new Error("Encrypted remote session is not ready");
      }
      const encrypted = await this.e2ee.encryptJson(envelope);
      const ok = this.sendRawFrame(encrypted, this.activeChannel);
      if (!ok) {
        throw new Error("Failed to send encrypted frame");
      }
    });
    this.sendChain = task.catch(() => {});
    return task;
  }

  private handleIncomingRawFrame(frame: any, _source: "p2p" | "relay"): void {
    if (!frame || typeof frame !== "object") return;
    if (frame.t === "hs_ack") {
      if (this.handshakeWaiter) {
        const waiter = this.handshakeWaiter;
        this.handshakeWaiter = null;
        window.clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      return;
    }
    if (frame.t === "msg") {
      this.recvChain = this.recvChain
        .then(async () => {
          if (!this.e2ee || !this.e2ee.ready) return;
          const env = await this.e2ee.decryptJson<UiEnvelope>(frame);
          this.handleDecryptedEnvelope(env);
        })
        .catch(() => {
          // Strict E2EE invariant: drop tampered or replayed ciphertext
        });
    }
  }

  private handleDecryptedEnvelope(env: UiEnvelope): void {
    if (!env || typeof env !== "object") return;
    if (typeof env.seq === "number" && env.seq > this.lastSeq) {
      this.lastSeq = env.seq;
    }
    if (env.name === "app.snapshot") {
      this.hasInitialSync = true;
    }
    if (
      (env.kind === "result" || env.kind === "error")
      && env.request_id
      && this.pendingCommands.has(env.request_id)
    ) {
      const waiter = this.pendingCommands.get(env.request_id)!;
      this.pendingCommands.delete(env.request_id);
      window.clearTimeout(waiter.timer);
      if (env.kind === "error") {
        waiter.reject(new Error(String(env.payload?.error || "Remote command failed")));
      } else {
        waiter.resolve(env.payload);
      }
      return;
    }
    this.callbacks.onEnvelope(env);
  }

  private async syncAfterConnect(): Promise<void> {
    const reqId = `sync-${Date.now().toString(36)}-${++this.syncSeq}`;
    if (this.hasInitialSync && this.lastSeq > 0) {
      try {
        const res = await this.sendCommand<{
          ok?: boolean;
          events?: UiEnvelope[];
          resync_required?: boolean;
        }>("ui.events.since", reqId, { seq: this.lastSeq });

        if (res?.ok && Array.isArray(res.events) && !res.resync_required) {
          for (const item of res.events) {
            if (typeof item.seq === "number" && item.seq > this.lastSeq) {
              this.lastSeq = item.seq;
            }
            this.callbacks.onEnvelope(item);
          }
          return;
        }
      } catch {
        // fall through to full resync
      }
    }

    const resyncId = `resync-${Date.now().toString(36)}-${++this.syncSeq}`;
    await this.sendCommand("ui.resync.request", resyncId, {}).catch(() => {});
  }

  private scheduleReconnect(): void {
    if (this.closed || this.intentionalDisconnect || !this.credentials) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, Math.min(this.reconnectAttempt, 4))
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && !this.intentionalDisconnect && this.credentials) {
        void this.connectWithCredentials(this.credentials).catch(() => {});
      }
    }, delay);
  }
}

class UfooDesktopBridge {
  private listeners = new Set<EventListener>();
  private transportListeners = new Set<TransportListener>();
  private initialized = false;
  private reqSeq = 0;

  private transportMode: BridgeTransportMode = isTauriEnvironment() ? "tauri" : "unpaired";
  private pairingState: RemotePairingState = "idle";
  private remoteError = "";
  private routeDeviceId = extractRemoteRouteDeviceId();
  private deepLinkParams: RemoteDeepLinkParams | null = null;
  private remoteTransport: RemoteE2eeTransport | null = null;

  // Preview demo mutable state for Remote Access & Approval Inbox testing
  private previewRemoteEnabled = false;
  private previewRelayUrl = "wss://online.ufoo.dev/ufoo/online";
  private previewWebBaseUrl = "";
  private previewAllowInsecureWs = false;
  private previewPairedDevices: RemotePairedDevice[] = [
    {
      client_id: "cli_preview_iphone01",
      label: "iPhone 16 Pro (Safari)",
      fingerprint: "A1B2-C3D4-E5F6-7890",
      paired_at: new Date(Date.now() - 86_400_000).toISOString(),
      last_seen: new Date(Date.now() - 120_000).toISOString(),
      revoked_at: null,
      connected: true,
      transport: "p2p",
    },
  ];
  private previewPendingInteractions: Array<Record<string, any>> = [
    {
      id: "preview-approval-1",
      kind: "approval",
      toolName: "shell",
      agentId: "ucode:a1b2c3d4",
      projectRoot: previewProjectRoot,
      riskLevel: "high",
      prompt: "Run `npm run desktop:ui:build && git status --short` in `/workspace/ufoo`?",
      options: [
        { key: "allow", label: "Allow Once" },
        { key: "always", label: "Allow for Session" },
      ],
      allowFreeChat: true,
      createdAt: new Date().toISOString(),
    },
  ];

  getTransportMode(): BridgeTransportMode {
    if (isTauriEnvironment()) return "tauri";
    return this.transportMode;
  }

  getRemoteSessionInfo(): RemoteSessionInfo | null {
    return credentialsToSessionInfo(this.remoteTransport?.getCredentials() || loadSavedCredentials());
  }

  getTransportSnapshot(): RemoteTransportSnapshot {
    const info = this.getRemoteSessionInfo();
    return {
      mode: this.getTransportMode(),
      pairingState: this.pairingState,
      deviceId: info?.deviceId || "",
      deviceName: info?.deviceName || "",
      hostFingerprint: info?.hostFingerprint || "",
      clientId: info?.clientId || "",
      clientLabel: info?.clientLabel || "",
      relayUrl: info?.relayUrl || this.deepLinkParams?.relayUrl || inferDefaultRelayUrl(),
      error: this.remoteError,
      hasSavedSession: Boolean(info),
      routeDeviceId: this.routeDeviceId,
      deepLinkParams: this.deepLinkParams,
    };
  }

  subscribeTransport(fn: TransportListener): () => void {
    this.transportListeners.add(fn);
    try {
      fn(this.getTransportSnapshot());
    } catch {
      // ignore
    }
    return () => {
      this.transportListeners.delete(fn);
    };
  }

  private emitTransportSnapshot(): void {
    const snap = this.getTransportSnapshot();
    for (const fn of this.transportListeners) {
      try {
        fn(snap);
      } catch (err) {
        console.error("[ufoo-bridge] transport listener error", err);
      }
    }
  }

  private ensureRemoteTransport(): RemoteE2eeTransport {
    if (!this.remoteTransport) {
      this.remoteTransport = new RemoteE2eeTransport({
        onEnvelope: (env) => this.emit(env),
        onStateChange: (update) => {
          this.transportMode = update.mode;
          this.pairingState = update.pairingState;
          if (update.error !== undefined) this.remoteError = update.error;
          this.emitTransportSnapshot();
          const info = credentialsToSessionInfo(update.credentials ?? this.remoteTransport?.getCredentials() ?? null);
          this.emit({
            protocol: "ufoo-ui/1",
            kind: "event",
            name: "host.connection",
            payload: {
              state: update.connectionState,
              connected: update.connectionState === "connected",
              transport: update.mode,
              device_name: info?.deviceName || "",
              device_id: info?.deviceId || "",
            },
          });
        },
        onRevoked: (message) => {
          this.transportMode = "unpaired";
          this.pairingState = "error";
          this.remoteError = message;
          this.emitTransportSnapshot();
          this.emit({
            protocol: "ufoo-ui/1",
            kind: "event",
            name: "host.connection",
            payload: {
              state: "offline",
              connected: false,
              transport: "unpaired",
              device_name: "",
              device_id: "",
              revoked: true,
              error: message,
            },
          });
        },
      });
    }
    return this.remoteTransport;
  }

  async init(): Promise<void> {
    if (isTauriEnvironment()) {
      this.transportMode = "tauri";
      this.pairingState = "connected";
      this.emitTransportSnapshot();

      const { listen } = await import("@tauri-apps/api/event");
      const { invoke } = await import("@tauri-apps/api/core");

      if (!this.initialized) {
        this.initialized = true;
        await listen<UiEnvelope>("ufoo://ui-event", (event) => {
          if (event.payload) {
            this.emit(event.payload);
          }
        });

        await listen<string>("ufoo://deep-link", async (event) => {
          if (event.payload) {
            await this.sendCommand("handoff.open_url", { url: event.payload });
          }
        });
      }

      try {
        await invoke("ufoo_client_ready");
      } catch {
        // Host may still be booting; supervisor will push resync once connected
      }
      return;
    }

    if (this.initialized) {
      if (this.transportMode === "preview") {
        this.seedPreviewState();
      }
      this.emitTransportSnapshot();
      return;
    }
    this.initialized = true;

    const { preview, routeDeviceId, deepLink } = parseUrlBootstrap();
    this.routeDeviceId = routeDeviceId;
    this.deepLinkParams = deepLink;

    if (preview) {
      this.enterPreviewMode();
      return;
    }

    if (deepLink) {
      this.transportMode = "unpaired";
      this.pairingState = "pairing";
      this.remoteError = "";
      this.emitTransportSnapshot();
      void this.pairRemote({
        relayUrl: deepLink.relayUrl,
        pairCode: deepLink.pairCode,
        deviceId: deepLink.deviceId || undefined,
        expectedFingerprint: deepLink.fingerprint || undefined,
      }).catch(() => {
        // Error state already broadcast to RemoteConnectScreen
      });
      return;
    }

    const saved = loadSavedCredentials();
    if (saved && (!routeDeviceId || saved.deviceId === routeDeviceId)) {
      syncRemoteUrlPath(saved.deviceId);
      this.routeDeviceId = saved.deviceId;
      this.transportMode = "remote-relay";
      this.pairingState = "connecting";
      this.remoteError = "";
      this.emitTransportSnapshot();
      const transport = this.ensureRemoteTransport();
      void transport.connectWithCredentials(saved).catch(() => {
        // Reconnect loop + error state already broadcast
      });
      return;
    }

    // No saved session and no ?preview=1 -> stay unpaired so RemoteConnectScreen renders
    this.transportMode = "unpaired";
    this.pairingState = "idle";
    this.remoteError = "";
    this.emitTransportSnapshot();
  }

  async pairRemote(opts: PairRemoteOptions): Promise<RemoteSessionInfo> {
    const transport = this.ensureRemoteTransport();
    const creds = await transport.pair(opts);
    this.routeDeviceId = creds.deviceId;
    this.deepLinkParams = null;
    this.emitTransportSnapshot();
    return credentialsToSessionInfo(creds)!;
  }

  async reconnectRemote(): Promise<void> {
    const saved = this.remoteTransport?.getCredentials() || loadSavedCredentials();
    if (!saved) {
      throw new Error("No saved remote session found");
    }
    const transport = this.ensureRemoteTransport();
    await transport.connectWithCredentials(saved);
  }

  disconnectRemote(): void {
    this.remoteTransport?.disconnect();
    if (this.transportMode === "preview") {
      this.transportMode = "unpaired";
      this.pairingState = "idle";
      this.emitTransportSnapshot();
    }
  }

  unpairRemote(): void {
    if (this.remoteTransport) {
      this.remoteTransport.unpair();
    } else {
      clearSavedCredentials();
    }
    this.transportMode = "unpaired";
    this.pairingState = "idle";
    this.remoteError = "";
    this.deepLinkParams = null;
    this.emitTransportSnapshot();
    this.emit({
      protocol: "ufoo-ui/1",
      kind: "event",
      name: "host.connection",
      payload: {
        state: "offline",
        connected: false,
        transport: "unpaired",
        device_name: "",
        device_id: "",
      },
    });
  }

  enterPreviewMode(): void {
    this.remoteTransport?.disconnect();
    this.transportMode = "preview";
    this.pairingState = "connected";
    this.remoteError = "";
    this.emitTransportSnapshot();
    this.emit({
      protocol: "ufoo-ui/1",
      kind: "event",
      name: "host.connection",
      payload: {
        state: "connected",
        connected: true,
        transport: "preview",
        device_name: "Preview Workspace",
        device_id: "dev_preview",
      },
    });
    this.seedPreviewState();
  }

  async requestResync(): Promise<void> {
    if (isTauriEnvironment()) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("ufoo_client_ready").catch(() => {});
      return;
    }
    if (this.transportMode === "remote-p2p" || this.transportMode === "remote-relay") {
      await this.sendCommand("ui.resync.request", {}).catch(() => {});
      return;
    }
    if (this.transportMode === "preview") {
      this.seedPreviewState();
    }
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(envelope: UiEnvelope) {
    for (const fn of this.listeners) {
      try {
        fn(envelope);
      } catch (err) {
        console.error("[ufoo-bridge] listener error", err);
      }
    }
  }

  async sendCommand<T = Record<string, any>>(
    name: string,
    payload: Record<string, any> = {}
  ): Promise<T> {
    const requestId = `ui-${Date.now().toString(36)}-${++this.reqSeq}`;
    if (isTauriEnvironment()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<T>("ufoo_send_command", {
        name,
        requestId,
        payload,
      });
    }
    if (this.transportMode === "remote-p2p" || this.transportMode === "remote-relay") {
      if (!this.remoteTransport) {
        throw new Error("Remote transport not initialized");
      }
      return this.remoteTransport.sendCommand<T>(name, requestId, payload);
    }
    if (this.transportMode === "preview") {
      return this.handlePreviewCommand(name, payload) as T;
    }
    throw new Error("Not connected to a Ufoo host");
  }

  async pickProjectFolder(): Promise<string | null> {
    if (isTauriEnvironment()) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<string | null>("ufoo_pick_folder");
    }
    const manual = window.prompt("Enter project workspace path:");
    return manual ? manual.trim() : null;
  }

  async openProjectInFinder(root: string): Promise<void> {
    if (!isTauriEnvironment()) {
      throw new Error("Open in Finder is available in the Ufoo desktop app.");
    }
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke<void>("ufoo_open_project_in_finder", { root });
  }

  private buildPreviewRemoteStatus(): RemoteStatusSnapshot {
    const base = (this.previewWebBaseUrl || "https://online.ufoo.dev").replace(/\/+$/, "").replace(/\/remote$/i, "");
    return {
      ok: true,
      enabled: this.previewRemoteEnabled,
      connected: this.previewRemoteEnabled,
      state: this.previewRemoteEnabled ? "connected" : "disabled",
      relay_url: this.previewRelayUrl,
      web_base_url: this.previewWebBaseUrl,
      remote_url: `${base}/remote/dev_preview_macbook_pro`,
      has_auth_token: false,
      allow_insecure_ws: this.previewAllowInsecureWs,
      device_id: "dev_preview_macbook_pro",
      device_name: "MacBook-Pro (Preview)",
      fingerprint: "4F9A-82C1-D7E3-50B6",
      paired_count: this.previewPairedDevices.length,
      active_clients: this.previewRemoteEnabled
        ? this.previewPairedDevices
            .filter((d) => d.connected)
            .map((d) => ({
              client_id: d.client_id,
              label: d.label,
              transport: String(d.transport || "p2p"),
              connected_at: d.last_seen,
            }))
        : [],
      last_error: "",
    };
  }

  private seedPreviewState() {
    window.setTimeout(() => {
      if (this.transportMode !== "preview") return;
      const headInteraction = this.previewPendingInteractions[0] || null;
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "event",
        name: "projects.tree",
        payload: {
          controller_root: "~/.ufoo",
          active_root: previewProjectRoot,
          scope: "project",
          stage_target: { kind: "project_main", agentId: "" },
          projects: [
            {
              id: "ufoo-repo",
              label: "ufoo",
              root: previewProjectRoot,
              branch: "master",
              status: "running",
              active: true,
              selectedAsMain: true,
              selectedWorkerId: "",
              mainBusy: false,
              waitingUser: Boolean(headInteraction),
              conversationId: "main-default",
              workers: [
                {
                  id: "codex:e5f60718",
                  label: "architect",
                  type: "codex",
                  internal: true,
                  external: false,
                  activity_state: "idle",
                  activity_detail: "Signed off E2EE framing",
                  group_id: "grp-release",
                  group_template_alias: "release-squad",
                },
                {
                  id: "claude:3b9a1102",
                  label: "backend",
                  type: "claude",
                  internal: true,
                  external: false,
                  activity_state: "working",
                  activity_detail: "Running remoteRelayServer.test.js",
                  group_id: "grp-release",
                  group_template_alias: "release-squad",
                },
                {
                  id: "agy:88c4f190",
                  label: "frontend",
                  type: "antigravity",
                  internal: true,
                  external: false,
                  activity_state: "idle",
                  activity_detail: "Built responsive PWA shell",
                  group_id: "grp-release",
                  group_template_alias: "release-squad",
                },
                {
                  id: "gemini:551a08de",
                  label: "reviewer",
                  type: "gemini",
                  internal: true,
                  external: false,
                  activity_state: "idle",
                  activity_detail: "Audited worktree safety",
                },
                {
                  id: "ucode:a1b2c3d4",
                  label: "ucode-1",
                  type: "ucode",
                  internal: true,
                  external: false,
                  activity_state: "idle",
                  activity_detail: "Ready · Native engine",
                },
              ],
              recoverable: [],
            },
            {
              id: "neptune-repo",
              label: "Neptune",
              root: "/Users/demo/Code/neptune",
              branch: "main",
              status: "idle",
              active: false,
              selectedAsMain: false,
              selectedWorkerId: "",
              mainBusy: false,
              waitingUser: false,
              conversationId: "main-neptune",
              workers: [
                {
                  id: "codex:neptune1",
                  label: "codex-1",
                  type: "codex",
                  internal: true,
                  external: false,
                  activity_state: "idle",
                  activity_detail: "Ready",
                },
              ],
              recoverable: [],
            },
          ],
        },
      });
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "event",
        name: "workspace.changes.snapshot",
        payload: {
          projectRoot: previewProjectRoot,
          worktreeRoot: previewProjectRoot,
          isGitRepo: true,
          branch: "master",
          worktrees: [
            { path: previewProjectRoot, branch: "master", head: "a84c19e", isMain: true },
            { path: `${previewProjectRoot}/.ufoo/worktrees/backend`, branch: "ufoo/backend", head: "f21d08b", isMain: false },
          ],
          files: [
            { path: "src/online/remoteCrypto.js", status: "M", code: "M", staged: true, unstaged: false, additions: 84, deletions: 12 },
            { path: "src/ui/remoteRelayBridge.js", status: "M", code: "M", staged: true, unstaged: false, additions: 56, deletions: 9 },
            { path: "apps/desktop/src/bridge/ufooClient.ts", status: "M", code: "M", staged: false, unstaged: true, additions: 42, deletions: 6 },
            { path: "test/unit/ui/remoteBridgeE2E.test.js", status: "A", code: "A", staged: true, unstaged: false, additions: 118, deletions: 0 },
          ],
          totals: { additions: 300, deletions: 27 },
          selectedFile: "src/ui/remoteRelayBridge.js",
          diff: [
            "diff --git a/src/ui/remoteRelayBridge.js b/src/ui/remoteRelayBridge.js",
            "@@ -98,8 +98,16 @@ function buildRemoteWebUrl(webBaseUrl, deviceId) {",
            "   return `${base}/remote/${encodeURIComponent(id)}`;",
            " }",
            "+function isSameOriginDefaultRelay(webBaseUrl, relayUrl) {",
            "+  const web = new URL(normalizeWebBaseUrl(webBaseUrl));",
            "+  const relay = new URL(String(relayUrl || \"\").trim());",
            "+  return web.host === relay.host && relay.pathname === \"/ufoo/online\";",
            "+}",
            " function buildDeepPairUrl({ webBaseUrl, relayUrl, deviceId, pairCode, fingerprint }) {",
            "-  params.set(\"relay\", relayUrl);",
            "+  if (relayUrl && !isSameOriginDefaultRelay(base, relayUrl)) {",
            "+    params.set(\"relay\", relayUrl);",
            "+  }",
            "   params.set(\"pair\", pairCode);",
            "   return `${remoteUrl}?${params.toString()}`;",
            " }",
          ].join("\n"),
          reports: [],
        },
      });
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "snapshot",
        name: "app.snapshot",
        payload: {
          status: "ready",
          package_version: "5.0.0",
          active_root: previewProjectRoot,
          scope: "project",
          stage_target: { kind: "project_main", agentId: "" },
          pending_interaction: headInteraction,
          pending_interactions: this.previewPendingInteractions,
          entries: [
            {
              id: "demo-1",
              kind: "user",
              text: "为 ufoo 设计并落地支持 Zero-Knowledge E2EE 远程访问与移动端审批的 Web/PWA 客户端。",
            },
            {
              id: "demo-2",
              kind: "thinking",
              text: "Confirmed architecture: ECDH P-256 + HKDF-SHA256 + AES-256-GCM over P2P WebRTC DataChannel with zero-knowledge ufoo-online relay fallback.",
            },
            {
              id: "demo-3",
              kind: "tool",
              text: "• Verified remoteCrypto & relay protocol",
              detail: "src/online/remoteCrypto.js\nsrc/online/server.js\nsrc/ui/remoteRelayBridge.js",
            },
            {
              id: "demo-peer-1",
              kind: "assistant",
              speaker: "architect",
              sender_id: "codex:e5f60718",
              sender_type: "codex",
              text: "已确认零知识 E2EE 方案：采用 **ECDH P-256 + HKDF-SHA256 + AES-256-GCM**，同源中继自动隐藏 `relay=` 参数，路径统一分配为 `/remote/<device_id>`。",
            },
            {
              id: "demo-peer-2",
              kind: "assistant",
              speaker: "backend",
              sender_id: "claude:3b9a1102",
              sender_type: "claude",
              text: "`src/online/server.js` 与 `src/ui/remoteRelayBridge.js` 已完成双向 HMAC 配对校验与 302 路由转发，12 组中继与桥接测试全部通过。",
            },
            {
              id: "demo-peer-3",
              kind: "assistant",
              speaker: "frontend",
              sender_id: "agy:88c4f190",
              sender_type: "antigravity",
              text: "移动端 PWA 与 `Settings → Remote Access` 已就绪，支持扫码自动配对、断线增量追平以及 Approval Inbox 一键审批。",
            },
            {
              id: "demo-4",
              kind: "assistant",
              speaker: "ufoo",
              text: "已完成端到端加密远程桥接与移动端审批流。你可以随时通过桌面端 **Settings → Remote Access** 生成配对二维码，或在手机上打开 **Inbox** 一键审批工具执行请求。",
            },
          ],
          settings: {
            agent_provider: "codex-cli",
            agent_model: "gpt-6.1-sol",
            agent_thinking: "medium",
          },
          window: { active: false, mode: "main", panes: [] },
        },
      });
    }, 30);
  }

  private handlePreviewCommand(name: string, payload: Record<string, any>) {
    if (name === "remote.status") {
      return this.buildPreviewRemoteStatus();
    }
    if (name === "remote.enable") {
      this.previewRemoteEnabled = true;
      if (typeof payload.relay_url === "string" && payload.relay_url.trim()) {
        this.previewRelayUrl = payload.relay_url.trim();
      }
      if (typeof payload.web_base_url === "string") {
        this.previewWebBaseUrl = payload.web_base_url.trim();
      }
      if (payload.allow_insecure_ws !== undefined) {
        this.previewAllowInsecureWs = Boolean(payload.allow_insecure_ws);
      }
      const status = this.buildPreviewRemoteStatus();
      this.emit({ protocol: "ufoo-ui/1", kind: "event", name: "remote.status", payload: status });
      return status;
    }
    if (name === "remote.disable") {
      this.previewRemoteEnabled = false;
      const status = this.buildPreviewRemoteStatus();
      this.emit({ protocol: "ufoo-ui/1", kind: "event", name: "remote.status", payload: status });
      return status;
    }
    if (name === "remote.pair.create") {
      this.previewRemoteEnabled = true;
      const pairCode = "UFOO-7X4K";
      const base = (this.previewWebBaseUrl || "https://online.ufoo.dev").replace(/\/+$/, "").replace(/\/remote$/i, "");
      const remoteUrl = `${base}/remote/dev_preview_macbook_pro`;
      let sameHost = false;
      try {
        const w = new URL(base);
        const r = new URL(this.previewRelayUrl);
        sameHost = w.host.toLowerCase() === r.host.toLowerCase() && r.pathname.replace(/\/+$/, "") === "/ufoo/online";
      } catch {
        sameHost = false;
      }
      const qp = new URLSearchParams();
      if (!sameHost) qp.set("relay", this.previewRelayUrl);
      qp.set("pair", pairCode);
      qp.set("fp", "4F9A-82C1-D7E3-50B6");
      const deepUrl = `${remoteUrl}?${qp.toString()}`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#ffffff"/><path d="M4,4h7v7h-7zM5,5v5h5v-5zM6,6h3v3h-3zM18,4h7v7h-7zM19,5v5h5v-5zM20,6h3v3h-3zM4,18h7v7h-7zM5,19v5h5v-5zM6,20h3v3h-3zM13,5h2v2h-2zM13,9h2v4h-2zM13,15h3v3h-3zM18,14h3v2h-3zM22,18h3v3h-3zM16,21h4v3h-4z" fill="#111114"/></svg>`;
      const ticket: RemotePairTicket = {
        ok: true,
        pair_id: "pair_preview_1",
        pair_code: pairCode,
        device_id: "dev_preview_macbook_pro",
        device_name: "MacBook-Pro (Preview)",
        relay_url: this.previewRelayUrl,
        remote_url: remoteUrl,
        deep_url: deepUrl,
        qr_svg: svg,
        qr_data_url: `data:image/svg+xml;base64,${btoa(svg)}`,
        expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        fingerprint: "4F9A-82C1-D7E3-50B6",
      };
      return ticket;
    }
    if (name === "remote.devices.list") {
      return {
        ok: true,
        device_id: "dev_preview_macbook_pro",
        devices: this.previewPairedDevices.slice(),
      };
    }
    if (name === "remote.devices.revoke") {
      const target = String(payload.client_id || "");
      this.previewPairedDevices = this.previewPairedDevices.filter((d) => d.client_id !== target);
      return {
        ok: true,
        client_id: target,
        devices: this.previewPairedDevices.slice(),
      };
    }
    if (name === "interaction.respond") {
      const targetId = String(payload.id || "");
      if (payload.dismiss_all) {
        this.previewPendingInteractions = [];
      } else if (targetId) {
        this.previewPendingInteractions = this.previewPendingInteractions.filter((i) => i.id !== targetId);
      } else {
        this.previewPendingInteractions.shift();
      }
      const next = this.previewPendingInteractions[0] || null;
      if (next) {
        this.emit({
          protocol: "ufoo-ui/1",
          kind: "event",
          name: "interaction.request",
          payload: { ...next, queue_count: this.previewPendingInteractions.length, queue: this.previewPendingInteractions },
        });
      } else {
        this.emit({
          protocol: "ufoo-ui/1",
          kind: "event",
          name: "interaction.clear",
          payload: { id: targetId, queue: [] },
        });
      }
      return { ok: true };
    }
    if (name === "daemon.service.status") {
      return {
        ok: true,
        supported: true,
        daemon_running: true,
        daemon_pid: 4242,
        daemon_state: "connected",
        daemon_connected: true,
        launchd: {
          supported: true,
          label: "dev.ufoo.daemon",
          plistPath: "~/Library/LaunchAgents/dev.ufoo.daemon.plist",
          installed: false,
          loaded: false,
          running: false,
          pid: null,
          state: "not_installed",
        },
      };
    }
    if (name === "settings.models") {
      const models = payload.agent_provider === "codex-cli" ? ["gpt-6.1-sol"] : [];
      return { ok: Boolean(models.length), models, default_model: models[0] || "" };
    }
    if (name === "window.set") {
      const mode = payload.mode || "main";
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "event",
        name: "window.set",
        payload: {
          active: mode !== "main",
          mode,
          panes: [
            { agent_id: "ucode:a1b2c3d4", label: "ucode-1", mode: "internal" },
            ...(mode === "multi" ? [{ agent_id: "codex:e5f60718", label: "codex-1", mode: "internal" }] : []),
          ],
        },
      });
    }
    if (name === "project.return_controller") {
      this.emit({
        protocol: "ufoo-ui/1",
        kind: "event",
        name: "projects.tree",
        payload: {
          controller_root: "~/.ufoo",
          active_root: "~/.ufoo",
          scope: "controller",
          stage_target: { kind: "project_main", agentId: "" },
        },
      });
      return { ok: true };
    }
    if (name === "worker.focus_view") {
      const id = payload.agent_id || "";
      const root = payload.root || previewProjectRoot;
      if (!id || id === "main") {
        this.emit({
          protocol: "ufoo-ui/1",
          kind: "event",
          name: "handoff.state",
          payload: { project_root: root, stage_target: { kind: "project_main", agentId: "" } },
        });
      } else {
        const previewMetaMap: Record<string, { label: string; type: string }> = {
          "codex:e5f60718": { label: "architect", type: "codex" },
          "claude:3b9a1102": { label: "backend", type: "claude" },
          "agy:88c4f190": { label: "frontend", type: "antigravity" },
          "gemini:551a08de": { label: "reviewer", type: "gemini" },
          "ucode:a1b2c3d4": { label: "ucode-1", type: "ucode" },
          "codex:neptune1": { label: "codex-1", type: "codex" },
        };
        const meta = previewMetaMap[id] || {
          label: id.startsWith("cursor") ? "cursor-1" : "ucode-1",
          type: id.startsWith("cursor") ? "cursor" : "ucode",
        };
        this.emit({
          protocol: "ufoo-ui/1",
          kind: "event",
          name: "worker.view.frame",
          payload: {
            project_root: root,
            agent_id: id,
            label: meta.label,
            type: meta.type,
            internal: !id.startsWith("cursor"),
            external: id.startsWith("cursor"),
            entries: [
              { id: "w-1", kind: "user", text: "Implement desktopUiHost.js and verify unit tests." },
              {
                id: "w-peer-1",
                kind: "user",
                sender_kind: "peer",
                sender_id: "codex:e5f60718",
                sender_label: "architect",
                sender_type: "codex",
                text: "Please preserve original worktree paths on resume.",
              },
              {
                id: "w-peer-2",
                kind: "user",
                sender_kind: "peer",
                sender_id: "gemini:551a08de",
                sender_label: "reviewer",
                sender_type: "gemini",
                text: "Verified UTF-8 streaming decoder handles split multi-byte characters cleanly.",
              },
              { id: "w-2", kind: "assistant", text: "All 120 Phase 0 tests in `test/unit/ui/desktopUiHost.test.js` passed." },
            ],
            reports: [],
            status: "ready",
            busy: false,
            usage: "18% ctx",
            plan: ["✓ Extend uiProtocol", "✓ Implement desktopUiHost", "◐ Connect Tauri v2 UI"],
            activity_detail: "",
            host_name: "Cursor",
            input: "",
            input_revision: 0,
          },
        });
      }
    }
    return { ok: true };
  }
}

export const ufooBridge = new UfooDesktopBridge();
