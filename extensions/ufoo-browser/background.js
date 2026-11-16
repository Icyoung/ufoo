"use strict";

const PROTOCOL_VERSION = 1;
const RELEASE_NATIVE_HOST = "com.ufoo.browser";
const DEV_NATIVE_HOST = "com.ufoo.browser.dev";
const DEV_EXTENSION_ID = "hepkcmckfedpfpijhdpbfccnddjpdceh";

let ws = null;
let nativePort = null;
let reconnectTimer = null;
let reconnectDelayMs = 2000;
let stopAutoReconnect = false;
const attachedTabIds = new Set();

const uiState = {
  connectionState: "connecting", // connected | waiting_for_ufoo | native_not_installed | disabled | protocol_mismatch | paused
  paused: false,
  error: "",
  hostVersion: "",
  tabOwners: [],
};

function isSupportedTab(tab) {
  if (!tab || tab.id === undefined || tab.id === null) return false;
  if (tab.incognito === true) return false;
  const rawUrl = String(tab.url || tab.pendingUrl || "").trim().toLowerCase();
  if (!rawUrl) return true;
  return !(
    rawUrl.startsWith("chrome://")
    || rawUrl.startsWith("chrome-extension://")
    || rawUrl.startsWith("devtools://")
    || rawUrl.startsWith("edge://")
    || rawUrl.startsWith("view-source:chrome-extension://")
  );
}

function summarizeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    incognito: Boolean(tab.incognito),
    title: String(tab.title || ""),
    url: String(tab.url || tab.pendingUrl || ""),
  };
}

function persistState() {
  try {
    chrome.storage.local.set({ ufooBrowserState: { ...uiState } });
  } catch {
    // ignore storage errors
  }
  try {
    // Keep the toolbar logo clear, including badges left by older versions.
    // Connection state and tab counts are shown in the popup instead.
    chrome.action.setBadgeText({ text: "" });
  } catch {
    // ignore badge errors
  }
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (stopAutoReconnect) return;
  clearReconnect();
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(30000, Math.round(reconnectDelayMs * 1.5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToNativeHost();
  }, delay);
}

async function detachAllLocalTabs() {
  for (const tabId of [...attachedTabIds]) {
    attachedTabIds.delete(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // ignore already detached tabs
    }
  }
}

function disconnectWs(reason = "Disconnected") {
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, reason);
      }
    } catch {
      // ignore
    }
    ws = null;
  }
  void detachAllLocalTabs();
}

function preferredHostNames() {
  if (chrome.runtime.id === DEV_EXTENSION_ID) {
    return [DEV_NATIVE_HOST, RELEASE_NATIVE_HOST];
  }
  return [RELEASE_NATIVE_HOST];
}

function connectToNativeHost(hostIndex = 0) {
  clearReconnect();
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const candidates = preferredHostNames();
  if (hostIndex >= candidates.length) {
    uiState.connectionState = "native_not_installed";
    uiState.error = "本机 ufoo Native Messaging Host 未注册";
    stopAutoReconnect = true;
    persistState();
    return;
  }

  const hostName = candidates[hostIndex];
  try {
    nativePort = chrome.runtime.connectNative(hostName);
  } catch (err) {
    connectToNativeHost(hostIndex + 1);
    return;
  }

  let receivedMessage = false;
  nativePort.onMessage.addListener((msg) => {
    receivedMessage = true;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "connect_info" && msg.wsUrl) {
      stopAutoReconnect = false;
      reconnectDelayMs = 2000;
      uiState.hostVersion = msg.hostVersion || "";
      openRelaySocket(msg.wsUrl);
      try { nativePort?.disconnect(); } catch { /* ignore */ }
      nativePort = null;
      return;
    }
    if (msg.type === "status") {
      uiState.error = msg.error || "";
      if (msg.state === "native_not_installed" || msg.state === "disabled" || msg.state === "protocol_mismatch") {
        uiState.connectionState = msg.state;
        stopAutoReconnect = true;
        disconnectWs(msg.state);
      } else {
        uiState.connectionState = "waiting_for_ufoo";
        stopAutoReconnect = false;
        scheduleReconnect();
      }
      persistState();
      try { nativePort?.disconnect(); } catch { /* ignore */ }
      nativePort = null;
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const errMsg = chrome.runtime.lastError?.message || "";
    nativePort = null;
    if (!receivedMessage) {
      if (hostIndex + 1 < candidates.length) {
        connectToNativeHost(hostIndex + 1);
        return;
      }
      if (errMsg.toLowerCase().includes("not found") || errMsg.toLowerCase().includes("forbidden")) {
        uiState.connectionState = "native_not_installed";
        uiState.error = errMsg;
        stopAutoReconnect = true;
        persistState();
        return;
      }
      uiState.connectionState = "waiting_for_ufoo";
      uiState.error = errMsg;
      persistState();
      scheduleReconnect();
    }
  });

  const manifest = chrome.runtime.getManifest();
  nativePort.postMessage({
    type: "hello",
    id: Date.now(),
    extensionId: chrome.runtime.id,
    extensionVersion: manifest.version,
    protocolVersion: PROTOCOL_VERSION,
  });
}

async function openRelaySocket(wsUrl) {
  disconnectWs("Reconnecting");
  const socket = new WebSocket(wsUrl);
  ws = socket;

  socket.onopen = async () => {
    if (ws !== socket) return;
    let tabs = [];
    try {
      const queried = await chrome.tabs.query({});
      tabs = queried.filter(isSupportedTab).map(summarizeTab);
    } catch {
      tabs = [];
    }
    const manifest = chrome.runtime.getManifest();
    socket.send(JSON.stringify({
      method: "extension.initialized",
      params: {
        extensionId: chrome.runtime.id,
        extensionVersion: manifest.version,
        protocolVersion: PROTOCOL_VERSION,
        tabs,
      },
    }));
    uiState.connectionState = uiState.paused ? "paused" : "connected";
    uiState.error = "";
    persistState();
  };

  socket.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      try {
        const result = await handleBrokerRpc(msg.method, msg.params || []);
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ id: msg.id, result }));
        }
      } catch (error) {
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ id: msg.id, error: error?.message || String(error) }));
        }
      }
      return;
    }

    if (msg.method === "host.state_sync") {
      uiState.paused = Boolean(msg.params?.paused);
      uiState.tabOwners = Array.isArray(msg.params?.tabOwners) ? msg.params.tabOwners : [];
      uiState.connectionState = uiState.paused ? "paused" : "connected";
      persistState();
    } else if (msg.method === "host.disabled") {
      uiState.connectionState = "disabled";
      uiState.tabOwners = [];
      stopAutoReconnect = true;
      persistState();
      disconnectWs("Disabled by host");
    } else if (msg.method === "host.protocol_mismatch") {
      uiState.connectionState = "protocol_mismatch";
      uiState.error = msg.params?.reason || "Protocol version mismatch";
      stopAutoReconnect = true;
      persistState();
      disconnectWs("Protocol mismatch");
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    void detachAllLocalTabs();
    uiState.tabOwners = [];
    if (!stopAutoReconnect) {
      uiState.connectionState = "waiting_for_ufoo";
      persistState();
      scheduleReconnect();
    }
  };

  socket.onerror = () => {};
}

async function handleBrokerRpc(method, params = []) {
  switch (method) {
    case "ufoo.listTabs": {
      const queried = await chrome.tabs.query({});
      return queried.filter(isSupportedTab).map(summarizeTab);
    }
    case "chrome.tabs.create": {
      const tab = await chrome.tabs.create(params[0] || {});
      return summarizeTab(tab);
    }
    case "chrome.tabs.remove": {
      await chrome.tabs.remove(params[0]);
      return {};
    }
    case "chrome.debugger.attach": {
      const [target, version] = params;
      const tab = await chrome.tabs.get(target.tabId);
      if (!isSupportedTab(tab)) {
        throw new Error("Refusing to attach to internal or incognito Chrome tab");
      }
      await chrome.debugger.attach(target, version || "1.3");
      attachedTabIds.add(target.tabId);
      return {};
    }
    case "chrome.debugger.detach": {
      const [target] = params;
      if (target && target.tabId !== undefined) attachedTabIds.delete(target.tabId);
      await chrome.debugger.detach(target).catch(() => {});
      return {};
    }
    case "chrome.debugger.sendCommand": {
      const [target, cdpMethod, cdpParams] = params;
      return await chrome.debugger.sendCommand(target, cdpMethod, cdpParams);
    }
    default:
      throw new Error(`Unsupported broker RPC: ${method}`);
  }
}

function sendWsNotification(method, params = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ method, params }));
    } catch {
      // ignore
    }
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (isSupportedTab(tab)) sendWsNotification("chrome.tabs.onCreated", [summarizeTab(tab)]);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (isSupportedTab(tab)) sendWsNotification("chrome.tabs.onUpdated", [tabId, changeInfo, summarizeTab(tab)]);
  else sendWsNotification("chrome.tabs.onRemoved", [tabId]);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabIds.delete(tabId);
  sendWsNotification("chrome.tabs.onRemoved", [tabId]);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  sendWsNotification("chrome.debugger.onEvent", [source, method, params]);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source && source.tabId !== undefined) attachedTabIds.delete(source.tabId);
  sendWsNotification("chrome.debugger.onDetach", [source, reason]);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;
  if (msg.type === "ufoo.getStatus") {
    sendResponse({ ...uiState });
    return false;
  }
  if (msg.type === "ufoo.pauseAll") {
    uiState.paused = true;
    uiState.connectionState = "paused";
    sendWsNotification("extension.pause_all", {});
    void detachAllLocalTabs();
    persistState();
    sendResponse({ ok: true, ...uiState });
    return false;
  }
  if (msg.type === "ufoo.resumeAll") {
    uiState.paused = false;
    uiState.connectionState = ws && ws.readyState === WebSocket.OPEN ? "connected" : "waiting_for_ufoo";
    sendWsNotification("extension.resume_all", {});
    persistState();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stopAutoReconnect = false;
      connectToNativeHost();
    }
    sendResponse({ ok: true, ...uiState });
    return false;
  }
  if (msg.type === "ufoo.releaseTab") {
    const tabId = Number(msg.tabId);
    if (Number.isInteger(tabId)) {
      attachedTabIds.delete(tabId);
      chrome.debugger.detach({ tabId }).catch(() => {});
      sendWsNotification("extension.release_tab", { tabId });
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "ufoo.reconnect") {
    stopAutoReconnect = false;
    reconnectDelayMs = 2000;
    connectToNativeHost();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  stopAutoReconnect = false;
  connectToNativeHost();
});

chrome.runtime.onStartup.addListener(() => {
  stopAutoReconnect = false;
  connectToNativeHost();
});

connectToNativeHost();
