"use strict";

const { randomUUID } = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const { loadGlobalBrowserConfig } = require("../../config");
const { writeFileAtomic } = require("../../coordination/bus/utils");
const {
  privateDir,
  brokerSocketPath,
  brokerInfoPath,
} = require("./paths");
const {
  getReleaseManifest,
  isExtensionCompatible,
  resolveAllowedExtensionIds,
} = require("./manifest");

const TOKEN_TTL_MS = 60 * 1000;
const EXTENSION_RPC_TIMEOUT_MS = 15 * 1000;
const MAX_EXTENSION_TOKENS = 32;

function isSupportedTab(tab) {
  if (!tab || tab.id === undefined || tab.id === null) return false;
  if (tab.incognito === true) return false;
  const rawUrl = String(tab.url || tab.pendingUrl || "").trim().toLowerCase();
  if (!rawUrl) return true;
  if (
    rawUrl.startsWith("chrome://")
    || rawUrl.startsWith("chrome-extension://")
    || rawUrl.startsWith("devtools://")
    || rawUrl.startsWith("edge://")
    || rawUrl.startsWith("view-source:chrome-extension://")
  ) {
    return false;
  }
  return true;
}

function parseExtensionOrigin(originHeader = "") {
  const raw = String(originHeader || "").trim();
  const match = raw.match(/^chrome-extension:\/\/([a-p]{32})$/);
  return match ? match[1] : "";
}

function parseBearerToken(authHeader = "") {
  const raw = String(authHeader || "").trim();
  const match = raw.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : "";
}

class BrowserBroker {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.hostVersion = options.hostVersion || "";
    this.loadConfig = options.loadConfig || loadGlobalBrowserConfig;
    this.background = options.background !== false;
    this.devAllowed = options.devAllowed !== false;
    this.socketPath = options.socketPath || brokerSocketPath(this.env);
    this.infoPath = options.infoPath || brokerInfoPath(this.env);

    this.ipcServer = null;
    this.httpServer = null;
    this.wss = null;
    this.port = 0;
    this.started = false;
    this.closed = false;

    this.extensionWs = null;
    this.connectedExtension = null;
    this.protocolMismatch = false;
    this.protocolError = "";
    this.paused = false;

    this.pendingExtensionTokens = new Map();
    this.extensionRpcCallbacks = new Map();
    this.nextRpcId = 1;
    this.nextTabSeq = 1;

    this.knownTabs = new Map(); // tabId -> tab metadata
    this.attachedTabs = new Map(); // tabId -> { tabId, relaySessionId, targetInfo, childSessions: Set, ownerSessionId }
    this.tabOwners = new Map(); // tabId -> agentSessionId
    this.sessions = new Map(); // agentSessionId -> { sessionId, token, projectName, agentName, workspaceRoot, ws, autoAttach, invalidated }
  }

  allowedExtensionIds() {
    return resolveAllowedExtensionIds({ dev: this.devAllowed, env: this.env });
  }

  isBrowserEnabled() {
    try {
      const cfg = this.loadConfig();
      return cfg.enabled === true;
    } catch {
      return false;
    }
  }

  async start() {
    if (this.started) return this.info();
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(privateDir(this.env), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.socketPath)) {
      try { fs.rmSync(this.socketPath, { force: true }); } catch { /* ignore */ }
    }

    this.httpServer = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("Not found");
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(0, "127.0.0.1", () => {
        this.httpServer.removeListener("error", reject);
        const addr = this.httpServer.address();
        this.port = addr && typeof addr === "object" ? addr.port : 0;
        resolve();
      });
    });

    this.ipcServer = net.createServer((socket) => this._handleIpcSocket(socket));
    await new Promise((resolve, reject) => {
      this.ipcServer.once("error", reject);
      this.ipcServer.listen(this.socketPath, () => {
        this.ipcServer.removeListener("error", reject);
        try { fs.chmodSync(this.socketPath, 0o600); } catch { /* ignore */ }
        resolve();
      });
    });

    this.started = true;
    writeFileAtomic(this.infoPath, JSON.stringify({
      pid: process.pid,
      port: this.port,
      socketPath: this.socketPath,
      startedAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    return this.info();
  }

  info() {
    return {
      ok: true,
      pid: process.pid,
      port: this.port,
      socketPath: this.socketPath,
    };
  }

  status() {
    const tabOwners = [];
    for (const [tabId, sessionId] of this.tabOwners.entries()) {
      const session = this.sessions.get(sessionId);
      const tab = this.knownTabs.get(tabId) || {};
      tabOwners.push({
        tabId,
        sessionId,
        projectName: session?.projectName || "",
        agentName: session?.agentName || "",
        title: tab.title || "",
        url: tab.url || "",
      });
    }
    return {
      ok: true,
      pid: process.pid,
      port: this.port,
      enabled: this.isBrowserEnabled(),
      extensionConnected: Boolean(this.extensionWs && this.extensionWs.readyState === WebSocket.OPEN),
      connectedExtension: this.connectedExtension,
      protocolMismatch: this.protocolMismatch,
      protocolError: this.protocolError,
      paused: this.paused,
      sessionCount: this.sessions.size,
      tabOwners,
    };
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this._revokeAllSessions("Broker stopped");
    this._closeExtension("Broker stopped");
    await Promise.all([
      new Promise((resolve) => {
        if (!this.ipcServer) return resolve();
        try { this.ipcServer.close(() => resolve()); } catch { resolve(); }
      }),
      new Promise((resolve) => {
        if (!this.wss) return resolve();
        try { this.wss.close(() => resolve()); } catch { resolve(); }
      }),
      new Promise((resolve) => {
        if (!this.httpServer) return resolve();
        try { this.httpServer.close(() => resolve()); } catch { resolve(); }
      }),
    ]);
    try { fs.rmSync(this.socketPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(this.infoPath, { force: true }); } catch { /* ignore */ }
  }

  _handleIpcSocket(socket) {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({ ok: false, code: "invalid_json", error: "Malformed IPC JSON" })}\n`);
          continue;
        }
        Promise.resolve(this.handleRpc(req.op, req.params || {})).then(
          (res) => {
            if (!socket.destroyed) socket.write(`${JSON.stringify(res)}\n`);
          },
          (err) => {
            if (!socket.destroyed) {
              socket.write(`${JSON.stringify({
                ok: false,
                code: err?.code || "broker_error",
                error: err?.message || String(err),
              })}\n`);
            }
          }
        );
      }
    });
  }

  async handleRpc(op, params = {}) {
    switch (op) {
      case "ping":
        return { ok: true, pid: process.pid, port: this.port, protocolVersion: getReleaseManifest(this.env).protocolVersion };
      case "status":
        return this.status();
      case "native_hello":
        return this._handleNativeHello(params);
      case "register_session":
        return this._registerSession(params);
      case "unregister_session":
        return this._unregisterSession(params.sessionId);
      case "list_tabs":
        return this._listTabs();
      case "claim_tab":
        return this._claimTab(params.sessionId, params.tabId);
      case "create_tab":
        return this._createTab(params.sessionId, params.url);
      case "close_tab":
        return this._closeTab(params.sessionId, params.tabId);
      case "release_tab":
        return this._releaseTab(params.sessionId, params.tabId);
      case "session_tab_status":
        return this._sessionTabStatus(params.sessionId);
      case "config_changed":
        return this._handleConfigChanged();
      case "revoke_all":
        this._revokeAllSessions("Revoked by operator");
        this._closeExtension("Revoked by operator");
        return { ok: true };
      default:
        return { ok: false, code: "unknown_broker_op", error: `Unknown broker operation: ${op}` };
    }
  }

  _handleNativeHello({ extensionId = "", extensionVersion = "", protocolVersion = 0 } = {}) {
    if (!this.isBrowserEnabled()) {
      return { ok: false, code: "disabled", error: "ufoo Browser is disabled" };
    }
    const allowed = this.allowedExtensionIds();
    if (!extensionId || !allowed.includes(extensionId)) {
      return { ok: false, code: "extension_not_allowed", error: "Extension ID is not authorized for this host" };
    }
    const manifest = getReleaseManifest(this.env);
    const compat = isExtensionCompatible({ extensionVersion, protocolVersion }, manifest);
    if (!compat.ok) {
      this.protocolMismatch = true;
      this.protocolError = compat.reason;
      return { ok: false, code: "protocol_mismatch", error: compat.reason };
    }
    this.protocolMismatch = false;
    this.protocolError = "";

    const now = Date.now();
    for (const [tok, entry] of this.pendingExtensionTokens.entries()) {
      if (entry.expiresAt <= now) this.pendingExtensionTokens.delete(tok);
    }
    if (this.pendingExtensionTokens.size >= MAX_EXTENSION_TOKENS) {
      const oldest = this.pendingExtensionTokens.keys().next().value;
      if (oldest) this.pendingExtensionTokens.delete(oldest);
    }
    const token = randomUUID();
    this.pendingExtensionTokens.set(token, {
      extensionId,
      extensionVersion,
      expiresAt: now + TOKEN_TTL_MS,
    });
    return {
      ok: true,
      wsUrl: `ws://127.0.0.1:${this.port}/extension?token=${encodeURIComponent(token)}`,
      token,
      protocolVersion: manifest.protocolVersion,
      hostVersion: this.hostVersion,
    };
  }

  _handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || "/", `http://127.0.0.1:${this.port}`);
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    if (url.pathname === "/extension") {
      const originExtId = parseExtensionOrigin(req.headers.origin);
      const allowed = this.allowedExtensionIds();
      if (!originExtId || !allowed.includes(originExtId)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("token") || parseBearerToken(req.headers.authorization);
      const tokenEntry = token ? this.pendingExtensionTokens.get(token) : null;
      if (!tokenEntry || tokenEntry.expiresAt < Date.now() || tokenEntry.extensionId !== originExtId) {
        if (token) this.pendingExtensionTokens.delete(token);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.pendingExtensionTokens.delete(token);
      if (!this.isBrowserEnabled()) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this._attachExtensionWs(ws, { extensionId: originExtId, extensionVersion: tokenEntry.extensionVersion });
      });
      return;
    }

    if (url.pathname.startsWith("/cdp/")) {
      // Reject browser-originated WebSocket upgrades (CSWSH defense).
      if (req.headers.origin) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      const sessionId = decodeURIComponent(url.pathname.slice("/cdp/".length));
      const session = this.sessions.get(sessionId);
      const bearer = parseBearerToken(req.headers.authorization);
      if (!session || session.invalidated || !bearer || bearer !== session.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (this.paused || !this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this._attachCdpWs(session, ws);
      });
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  }

  _attachExtensionWs(ws, meta) {
    if (this.extensionWs && this.extensionWs !== ws) {
      this._closeExtension("Superseded by newer extension connection");
    }
    this.extensionWs = ws;
    this.connectedExtension = {
      extensionId: meta.extensionId,
      extensionVersion: meta.extensionVersion || "",
      connectedAt: new Date().toISOString(),
    };
    this.protocolMismatch = false;
    this.protocolError = "";

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      this._onExtensionMessage(ws, msg);
    });

    ws.on("close", () => {
      if (this.extensionWs !== ws) return;
      this.extensionWs = null;
      this.connectedExtension = null;
      for (const cb of this.extensionRpcCallbacks.values()) {
        clearTimeout(cb.timer);
        cb.reject(new Error("Extension disconnected"));
      }
      this.extensionRpcCallbacks.clear();
      this.knownTabs.clear();
      this.attachedTabs.clear();
      this.tabOwners.clear();
      this._invalidateAllSessions("Chrome extension disconnected");
    });

    ws.on("error", () => {});
    this._syncExtensionState();
  }

  _closeExtension(reason) {
    this.pendingExtensionTokens.clear();
    if (this.extensionWs) {
      try {
        if (this.extensionWs.readyState === WebSocket.OPEN) {
          this.extensionWs.close(1000, reason);
        }
      } catch { /* ignore */ }
    }
    this.extensionWs = null;
    this.connectedExtension = null;
    this.knownTabs.clear();
    this.attachedTabs.clear();
    this.tabOwners.clear();
  }

  _sendExtensionRpc(method, params = []) {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(Object.assign(new Error("Chrome extension is not connected"), { code: "waiting_for_browser" }));
    }
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.extensionRpcCallbacks.delete(id);
        reject(new Error(`Extension RPC timed out: ${method}`));
      }, EXTENSION_RPC_TIMEOUT_MS);
      timer.unref?.();
      this.extensionRpcCallbacks.set(id, { resolve, reject, timer });
      this.extensionWs.send(JSON.stringify({ id, method, params }));
    });
  }

  _sendExtensionNotification(method, params = {}) {
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) return;
    try {
      this.extensionWs.send(JSON.stringify({ method, params }));
    } catch { /* ignore */ }
  }

  _syncExtensionState() {
    const tabOwners = [];
    for (const [tabId, sessionId] of this.tabOwners.entries()) {
      const session = this.sessions.get(sessionId);
      const tab = this.knownTabs.get(tabId) || {};
      tabOwners.push({
        tabId,
        sessionId,
        projectName: session?.projectName || "",
        agentName: session?.agentName || "",
        title: tab.title || "",
        url: tab.url || "",
      });
    }
    this._sendExtensionNotification("host.state_sync", {
      paused: this.paused,
      enabled: this.isBrowserEnabled(),
      sessionCount: this.sessions.size,
      tabOwners,
    });
  }

  _onExtensionMessage(ws, msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.id) {
      const cb = this.extensionRpcCallbacks.get(msg.id);
      if (!cb) return;
      this.extensionRpcCallbacks.delete(msg.id);
      clearTimeout(cb.timer);
      if (msg.error) cb.reject(new Error(typeof msg.error === "string" ? msg.error : msg.error.message || "Extension error"));
      else cb.resolve(msg.result);
      return;
    }

    switch (msg.method) {
      case "extension.initialized": {
        const info = msg.params || {};
        const compat = isExtensionCompatible({
          extensionVersion: info.extensionVersion || this.connectedExtension?.extensionVersion || "",
          protocolVersion: info.protocolVersion,
        }, getReleaseManifest(this.env));
        if (!compat.ok) {
          this.protocolMismatch = true;
          this.protocolError = compat.reason;
          this._sendExtensionNotification("host.protocol_mismatch", { reason: compat.reason });
          try { ws.close(1008, compat.reason); } catch { /* ignore */ }
          return;
        }
        if (this.connectedExtension) {
          this.connectedExtension.extensionVersion = String(info.extensionVersion || this.connectedExtension.extensionVersion || "");
        }
        if (Array.isArray(info.tabs)) {
          this.knownTabs.clear();
          for (const tab of info.tabs) {
            if (isSupportedTab(tab)) this.knownTabs.set(tab.id, tab);
          }
        }
        this._syncExtensionState();
        break;
      }
      case "extension.pause_all":
        this._pauseAll();
        break;
      case "extension.resume_all":
        this.paused = false;
        this._syncExtensionState();
        break;
      case "extension.release_tab": {
        const tabId = Number(msg.params?.tabId);
        if (Number.isInteger(tabId)) {
          void this._forceReleaseTab(tabId, "Released by user in extension");
        }
        break;
      }
      case "chrome.tabs.onCreated": {
        const [tab] = Array.isArray(msg.params) ? msg.params : [];
        if (isSupportedTab(tab)) this.knownTabs.set(tab.id, tab);
        break;
      }
      case "chrome.tabs.onUpdated": {
        const [tabId, changeInfo, tab] = Array.isArray(msg.params) ? msg.params : [];
        if (tab && isSupportedTab(tab)) {
          this.knownTabs.set(tabId, tab);
        } else if (changeInfo && this.knownTabs.has(tabId)) {
          const updated = { ...this.knownTabs.get(tabId), ...changeInfo };
          if (isSupportedTab(updated)) this.knownTabs.set(tabId, updated);
          else {
            this.knownTabs.delete(tabId);
            void this._forceReleaseTab(tabId, "Tab navigated to unsupported page");
          }
        }
        this._syncExtensionState();
        break;
      }
      case "chrome.tabs.onRemoved": {
        const [tabId] = Array.isArray(msg.params) ? msg.params : [];
        this.knownTabs.delete(tabId);
        void this._forceReleaseTab(tabId, "Tab closed");
        break;
      }
      case "chrome.debugger.onEvent": {
        const [source, method, params] = Array.isArray(msg.params) ? msg.params : [];
        this._onDebuggerEvent(source, method, params);
        break;
      }
      case "chrome.debugger.onDetach": {
        const [source] = Array.isArray(msg.params) ? msg.params : [];
        if (source && source.tabId !== undefined) {
          void this._forceReleaseTab(source.tabId, "Debugger detached");
        }
        break;
      }
      default:
        break;
    }
  }

  _pauseAll() {
    this.paused = true;
    for (const tabId of [...this.attachedTabs.keys()]) {
      this._sendExtensionRpc("chrome.debugger.detach", [{ tabId }]).catch(() => {});
    }
    for (const [tabId, attached] of this.attachedTabs.entries()) {
      const owner = this.sessions.get(attached.ownerSessionId);
      this._emitTargetDetached(owner, attached);
      this.tabOwners.delete(tabId);
    }
    this.attachedTabs.clear();
    this.tabOwners.clear();
    this._invalidateAllSessions("Browser control paused by user");
    this._syncExtensionState();
  }

  _invalidateAllSessions(reason) {
    for (const session of this.sessions.values()) {
      session.invalidated = true;
      session.token = "";
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        try { session.ws.close(1000, reason); } catch { /* ignore */ }
      }
      session.ws = null;
    }
  }

  _revokeAllSessions(reason) {
    this._invalidateAllSessions(reason);
    this.sessions.clear();
  }

  _handleConfigChanged() {
    if (!this.isBrowserEnabled()) {
      this._pauseAll();
      this._sendExtensionNotification("host.disabled", {});
      this._closeExtension("Browser capability disabled");
      return { ok: true, enabled: false };
    }
    this._syncExtensionState();
    return { ok: true, enabled: true };
  }

  _emitTargetAttached(session, attached) {
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN || !session.autoAttach) return;
    session.ws.send(JSON.stringify({
      method: "Target.attachedToTarget",
      params: {
        sessionId: attached.relaySessionId,
        targetInfo: { ...attached.targetInfo, attached: true },
        waitingForDebugger: false,
      },
    }));
  }

  _emitTargetDetached(session, attached) {
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;
    try {
      session.ws.send(JSON.stringify({
        method: "Target.detachedFromTarget",
        params: {
          sessionId: attached.relaySessionId,
          targetId: attached.targetInfo?.targetId,
        },
      }));
    } catch { /* ignore */ }
  }

  async _forceReleaseTab(tabId, reason = "") {
    void reason;
    const ownerSessionId = this.tabOwners.get(tabId);
    this.tabOwners.delete(tabId);
    const attached = this.attachedTabs.get(tabId);
    if (attached) {
      this.attachedTabs.delete(tabId);
      const owner = this.sessions.get(ownerSessionId || attached.ownerSessionId);
      this._emitTargetDetached(owner, attached);
      if (owner) owner.releasedSinceLastClaim = true;
      await this._sendExtensionRpc("chrome.debugger.detach", [{ tabId }]).catch(() => {});
    }
    this._syncExtensionState();
  }

  _registerSession({ sessionId = "", projectName = "", agentName = "", workspaceRoot = "" } = {}) {
    if (!sessionId) return { ok: false, code: "browser_context_required", error: "sessionId is required" };
    if (!this.isBrowserEnabled()) return { ok: false, code: "browser_disabled", error: "ufoo Browser is disabled" };
    if (this.protocolMismatch) return { ok: false, code: "protocol_mismatch", error: this.protocolError || "Protocol mismatch" };
    if (this.paused) return { ok: false, code: "browser_paused", error: "Browser control is paused in Ufoo extension" };
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return { ok: false, code: "waiting_for_browser", error: "Chrome with Ufoo extension is not connected" };
    }

    const existing = this.sessions.get(sessionId);
    if (existing && !existing.invalidated) {
      if (projectName) existing.projectName = String(projectName);
      if (agentName) existing.agentName = String(agentName);
      return {
        ok: true,
        sessionId,
        wsEndpoint: `ws://127.0.0.1:${this.port}/cdp/${encodeURIComponent(sessionId)}`,
        sessionToken: existing.token,
      };
    }

    const token = randomUUID();
    const record = {
      sessionId,
      token,
      projectName: String(projectName || (workspaceRoot ? path.basename(workspaceRoot) : "") || "ufoo"),
      agentName: String(agentName || "agent"),
      workspaceRoot: String(workspaceRoot || ""),
      ws: null,
      autoAttach: false,
      invalidated: false,
      releasedSinceLastClaim: false,
    };
    this.sessions.set(sessionId, record);
    this._syncExtensionState();
    return {
      ok: true,
      sessionId,
      wsEndpoint: `ws://127.0.0.1:${this.port}/cdp/${encodeURIComponent(sessionId)}`,
      sessionToken: token,
    };
  }

  async _unregisterSession(sessionId = "") {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: true };
    const ownedTabs = [...this.tabOwners.entries()]
      .filter(([, ownerId]) => ownerId === sessionId)
      .map(([tabId]) => tabId);
    for (const tabId of ownedTabs) {
      await this._forceReleaseTab(tabId, "Session unregistered");
    }
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.close(1000, "Session disconnected"); } catch { /* ignore */ }
    }
    this.sessions.delete(sessionId);
    this._syncExtensionState();
    return { ok: true };
  }

  async _listTabs() {
    if (this.protocolMismatch) return { ok: false, code: "protocol_mismatch", error: this.protocolError };
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return { ok: false, code: "waiting_for_browser", error: "Chrome with Ufoo extension is not connected" };
    }
    const rawTabs = await this._sendExtensionRpc("ufoo.listTabs", []);
    const list = Array.isArray(rawTabs) ? rawTabs : [];
    this.knownTabs.clear();
    const tabs = [];
    for (const tab of list) {
      if (!isSupportedTab(tab)) continue;
      this.knownTabs.set(tab.id, tab);
      const ownerId = this.tabOwners.get(tab.id);
      const ownerSession = ownerId ? this.sessions.get(ownerId) : null;
      tabs.push({
        tabId: tab.id,
        windowId: tab.windowId,
        active: Boolean(tab.active),
        title: String(tab.title || ""),
        url: String(tab.url || ""),
        owner: ownerSession
          ? { sessionId: ownerId, projectName: ownerSession.projectName, agentName: ownerSession.agentName }
          : null,
      });
    }
    return { ok: true, paused: this.paused, tabs };
  }

  async _ensureTabAttached(tabId, ownerSessionId) {
    const existing = this.attachedTabs.get(tabId);
    if (existing && existing.ownerSessionId === ownerSessionId) return existing;
    await this._sendExtensionRpc("chrome.debugger.attach", [{ tabId }, "1.3"]);
    const infoRes = await this._sendExtensionRpc("chrome.debugger.sendCommand", [{ tabId }, "Target.getTargetInfo"]);
    const targetInfo = infoRes?.targetInfo || { targetId: `tab-${tabId}`, type: "page", url: this.knownTabs.get(tabId)?.url || "", title: this.knownTabs.get(tabId)?.title || "" };
    const relaySessionId = `pw-tab-${this.nextTabSeq++}`;
    const attached = {
      tabId,
      relaySessionId,
      targetInfo,
      childSessions: new Set(),
      ownerSessionId,
    };
    this.attachedTabs.set(tabId, attached);
    const owner = this.sessions.get(ownerSessionId);
    this._emitTargetAttached(owner, attached);
    return attached;
  }

  async _claimTab(sessionId = "", rawTabId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.invalidated) {
      return { ok: false, code: "browser_reconnect_required", error: "Browser session is not registered or was invalidated" };
    }
    if (this.paused) {
      return { ok: false, code: "browser_paused", error: "Browser control is paused in Ufoo extension" };
    }
    if (!this.extensionWs || this.extensionWs.readyState !== WebSocket.OPEN) {
      return { ok: false, code: "waiting_for_browser", error: "Chrome with Ufoo extension is not connected" };
    }
    const tabId = Number(rawTabId);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      return { ok: false, code: "invalid_tab_id", error: "A valid positive integer tabId is required" };
    }
    // Refresh tab list if unknown
    if (!this.knownTabs.has(tabId)) {
      await this._listTabs();
    }
    const tab = this.knownTabs.get(tabId);
    if (!tab || !isSupportedTab(tab)) {
      return { ok: false, code: "unsupported_tab", error: `Tab ${tabId} was not found or is an unsupported/incognito Chrome page` };
    }
    const currentOwnerId = this.tabOwners.get(tabId);
    if (currentOwnerId && currentOwnerId !== sessionId) {
      const ownerSession = this.sessions.get(currentOwnerId);
      return {
        ok: false,
        code: "browser_tab_busy",
        error: `Tab ${tabId} is currently in use by ${ownerSession?.projectName || "another project"} (${ownerSession?.agentName || "agent"})`,
        owner: {
          projectName: ownerSession?.projectName || "unknown",
          agentName: ownerSession?.agentName || "agent",
        },
      };
    }

    this.tabOwners.set(tabId, sessionId);
    session.releasedSinceLastClaim = false;
    try {
      const attached = await this._ensureTabAttached(tabId, sessionId);
      this._syncExtensionState();
      return {
        ok: true,
        tabId,
        relaySessionId: attached.relaySessionId,
        targetId: attached.targetInfo?.targetId || "",
        title: tab.title || "",
        url: tab.url || "",
      };
    } catch (error) {
      this.tabOwners.delete(tabId);
      this.attachedTabs.delete(tabId);
      this._syncExtensionState();
      return { ok: false, code: "tab_attach_failed", error: error?.message || "Failed to attach debugger to tab" };
    }
  }

  async _createTab(sessionId = "", url = "") {
    const session = this.sessions.get(sessionId);
    if (!session || session.invalidated) {
      return { ok: false, code: "browser_reconnect_required", error: "Browser session is not registered or was invalidated" };
    }
    if (this.paused) {
      return { ok: false, code: "browser_paused", error: "Browser control is paused in Ufoo extension" };
    }
    const created = await this._sendExtensionRpc("chrome.tabs.create", [{
      url: url || "about:blank",
      active: !this.background,
    }]);
    if (!created || created.id === undefined) {
      return { ok: false, code: "tab_create_failed", error: "Failed to create browser tab" };
    }
    if (!isSupportedTab(created)) {
      await this._sendExtensionRpc("chrome.tabs.remove", [created.id]).catch(() => {});
      return { ok: false, code: "unsupported_tab", error: "Cannot control internal or incognito Chrome pages" };
    }
    this.knownTabs.set(created.id, created);
    return this._claimTab(sessionId, created.id);
  }

  async _closeTab(sessionId = "", tabId) {
    const numId = Number(tabId);
    if (!Number.isInteger(numId)) return { ok: false, code: "invalid_tab_id", error: "tabId is required" };
    if (this.tabOwners.get(numId) !== sessionId) {
      return { ok: false, code: "tab_not_owned", error: "Session does not own this tab" };
    }
    await this._forceReleaseTab(numId, "Closed by owning session");
    await this._sendExtensionRpc("chrome.tabs.remove", [numId]).catch(() => {});
    this.knownTabs.delete(numId);
    return { ok: true, closedTabId: numId };
  }

  async _releaseTab(sessionId = "", tabId) {
    const numId = Number(tabId);
    if (!Number.isInteger(numId)) return { ok: false, code: "invalid_tab_id", error: "tabId is required" };
    if (this.tabOwners.get(numId) !== sessionId) {
      return { ok: true, released: false };
    }
    await this._forceReleaseTab(numId, "Released by session");
    return { ok: true, released: true };
  }

  _sessionTabStatus(sessionId = "") {
    const session = this.sessions.get(sessionId);
    const ownedTabs = [];
    for (const [tabId, ownerId] of this.tabOwners.entries()) {
      if (ownerId !== sessionId) continue;
      const tab = this.knownTabs.get(tabId) || {};
      const attached = this.attachedTabs.get(tabId);
      ownedTabs.push({
        tabId,
        targetId: attached?.targetInfo?.targetId || "",
        title: tab.title || "",
        url: tab.url || "",
      });
    }
    return {
      ok: true,
      paused: this.paused,
      invalidated: Boolean(!session || session.invalidated),
      releasedSinceLastClaim: Boolean(session && session.releasedSinceLastClaim),
      ownedTabs,
    };
  }

  _attachCdpWs(session, ws) {
    session.ws = ws;
    session.autoAttach = false;
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      const { id, sessionId: cdpSessionId, method, params } = msg;
      try {
        const result = await this._handleCdpCommand(session, method, params, cdpSessionId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, sessionId: cdpSessionId, result }));
        }
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, sessionId: cdpSessionId, error: { message: error?.message || String(error) } }));
        }
      }
    });
    ws.on("close", () => {
      if (session.ws === ws) session.ws = null;
    });
    ws.on("error", () => {});
  }

  _ownedAttachedTabs(agentSessionId) {
    const list = [];
    for (const attached of this.attachedTabs.values()) {
      if (attached.ownerSessionId === agentSessionId) list.push(attached);
    }
    return list;
  }

  _debuggerTargetForSession(agentSessionId, method, cdpSessionId) {
    const owned = this._ownedAttachedTabs(agentSessionId);
    if (!cdpSessionId) {
      if (owned.length === 0) {
        throw new Error(`No claimed tab for session to execute ${method}`);
      }
      return { tabId: owned[0].tabId };
    }
    const direct = owned.find((item) => item.relaySessionId === cdpSessionId);
    if (direct) return { tabId: direct.tabId };
    const parent = owned.find((item) => item.childSessions.has(cdpSessionId));
    if (parent) return { tabId: parent.tabId, sessionId: cdpSessionId };
    throw new Error(`Session does not own CDP target ${cdpSessionId}`);
  }

  async _handleCdpCommand(session, method, params, cdpSessionId) {
    if (this.paused || session.invalidated) {
      throw new Error("Browser control is paused or session was invalidated");
    }
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "Chrome/Extension-Bridge",
          userAgent: "ufoo-browser-relay/1.0.0",
        };
      case "Browser.setDownloadBehavior":
        return {};
      case "Target.setAutoAttach": {
        if (cdpSessionId) break;
        session.autoAttach = true;
        for (const attached of this._ownedAttachedTabs(session.sessionId)) {
          this._emitTargetAttached(session, attached);
        }
        return {};
      }
      case "Target.createTarget": {
        const created = await this._createTab(session.sessionId, params?.url);
        if (!created.ok) throw new Error(created.error || "Failed to create target");
        return { targetId: created.targetId };
      }
      case "Target.closeTarget": {
        const targetId = params?.targetId;
        const owned = this._ownedAttachedTabs(session.sessionId)
          .find((item) => item.targetInfo?.targetId === targetId);
        if (!owned) return { success: false };
        await this._closeTab(session.sessionId, owned.tabId);
        return { success: true };
      }
      case "Target.getTargetInfo": {
        const owned = this._ownedAttachedTabs(session.sessionId)
          .find((item) => item.relaySessionId === cdpSessionId);
        return owned ? owned.targetInfo : undefined;
      }
      case "Page.bringToFront":
      case "Target.activateTarget":
        if (this.background) return {};
        break;
      default:
        break;
    }
    const target = this._debuggerTargetForSession(session.sessionId, method, cdpSessionId);
    return this._sendExtensionRpc("chrome.debugger.sendCommand", [target, method, params]);
  }

  _onDebuggerEvent(source, method, params) {
    if (!source || source.tabId === undefined) return;
    const attached = this.attachedTabs.get(source.tabId);
    if (!attached) return;
    const owner = this.sessions.get(attached.ownerSessionId);
    if (!owner || !owner.ws || owner.ws.readyState !== WebSocket.OPEN) return;

    const childSessionId = params?.sessionId;
    if (method === "Target.attachedToTarget" && childSessionId) {
      attached.childSessions.add(childSessionId);
    } else if (method === "Target.detachedFromTarget" && childSessionId) {
      attached.childSessions.delete(childSessionId);
    }
    const outSessionId = source.sessionId || attached.relaySessionId;
    owner.ws.send(JSON.stringify({ sessionId: outSessionId, method, params }));
  }
}

module.exports = {
  BrowserBroker,
  isSupportedTab,
  parseExtensionOrigin,
  parseBearerToken,
};
