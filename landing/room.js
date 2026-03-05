(function () {
  var query = new URLSearchParams(window.location.search);
  var roomId = query.get("id") || "";
  var apiBase = (query.get("api") || "https://online.ufoo.dev").replace(/\/+$/, "");
  var wsUrl = query.get("ws") || apiBase.replace(/^http/i, "ws") + "/ufoo/online";
  var token = query.get("token") || "public-preview";
  var nickname = "room-observer-" + Math.random().toString(36).slice(2, 8);
  var subscriberId = "room-observer:" + Math.random().toString(36).slice(2, 12);

  function t(key, vars) { return window.__t ? window.__t(key, vars) : key; }

  // DOM
  var authGate = document.getElementById("authGate");
  var roomView = document.getElementById("roomView");
  var authForm = document.getElementById("authForm");
  var authPassword = document.getElementById("authPassword");
  var authMessage = document.getElementById("authMessage");
  var authRoomInfo = document.getElementById("authRoomInfo");
  var roomMetaName = document.getElementById("roomMetaName");
  var roomTitle = document.getElementById("roomTitle");
  var roomCreator = document.getElementById("roomCreator");
  var messageList = document.getElementById("messageList");
  var historyCount = document.getElementById("historyCount");
  var liveCount = document.getElementById("liveCount");
  var liveStatus = document.getElementById("liveStatus");
  var eventLog = document.getElementById("eventLog");
  var eventTag = document.getElementById("eventTag");
  var modeHistoryBtn = document.getElementById("modeHistory");
  var modeLiveBtn = document.getElementById("modeLive");

  var state = {
    authed: false,
    password: "",
    roomInfo: null,
    history: [],
    live: [],
    activeMode: "history",
    ws: null,
    wsAuthed: false,
    reconnectTimer: null,
  };

  // Start with room view dimmed behind dialog
  roomView.style.opacity = "0.3";

  if (!roomId) {
    authGate.showModal();
    authMessage.textContent = t("room.notfound");
    authPassword.disabled = true;
    return;
  }

  // ── Helpers ────────────────────────────────────────────────────
  function formatTime(ts) {
    if (!ts) return "--:--";
    var dt = new Date(ts);
    if (Number.isNaN(dt.getTime())) return String(ts).slice(11, 16) || String(ts);
    return dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function pushEvent(text) {
    var li = document.createElement("li");
    li.innerHTML = "<time>" + formatTime(new Date().toISOString()) + "</time><span>" + text + "</span>";
    eventLog.prepend(li);
    while (eventLog.children.length > 20) eventLog.removeChild(eventLog.lastElementChild);
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  // ── Render ─────────────────────────────────────────────────────
  function renderStream() {
    var list = state.activeMode === "history" ? state.history : state.live;
    historyCount.textContent = String(state.history.length);
    liveCount.textContent = String(state.live.length);
    messageList.innerHTML = "";
    if (!list.length) {
      var li = document.createElement("li");
      li.className = "empty-item";
      li.textContent = state.activeMode === "history" ? t("room.empty.history") : t("room.empty.live");
      messageList.appendChild(li);
      return;
    }
    list.forEach(function (item) {
      var li = document.createElement("li");
      li.innerHTML = "<time>" + item.time + "</time><strong>" + escapeHtml(item.agent) + "</strong><span>" + escapeHtml(item.text) + "</span>";
      messageList.appendChild(li);
    });
    // auto-scroll
    var sw = document.getElementById("streamWindow");
    if (sw) sw.scrollTop = sw.scrollHeight;
  }

  function setMode(mode) {
    state.activeMode = mode;
    var isHistory = mode === "history";
    modeHistoryBtn.classList.toggle("active", isHistory);
    modeLiveBtn.classList.toggle("active", !isHistory);
    modeHistoryBtn.setAttribute("aria-selected", String(isHistory));
    modeLiveBtn.setAttribute("aria-selected", String(!isHistory));
    renderStream();
  }

  function showRoomView(info) {
    state.roomInfo = info;
    var name = info.name || roomId;
    roomMetaName.textContent = name;
    roomTitle.textContent = name;
    roomCreator.textContent = info.created_by || "unknown";
    document.title = name + " - ufoo online";
    if (authGate.open) authGate.close();
    roomView.style.opacity = "1";
    eventTag.textContent = new URL(apiBase).host;
  }

  // ── HTTP API ───────────────────────────────────────────────────
  async function fetchRoomInfo() {
    var res = await fetch(apiBase + "/ufoo/online/public/rooms?type=private");
    var data = await res.json().catch(function () { return {}; });
    var rooms = Array.isArray(data.rooms) ? data.rooms : [];
    return rooms.find(function (r) { return r.room_id === roomId; }) || null;
  }

  async function fetchRoomMessages(password) {
    var url = apiBase + "/ufoo/online/rooms/" + encodeURIComponent(roomId) + "/messages?password=" + encodeURIComponent(password) + "&limit=200";
    var res = await fetch(url);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || "HTTP " + res.status);
    }
    return res.json();
  }

  // ── WebSocket ──────────────────────────────────────────────────
  function wsSend(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function connectSocket() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    liveStatus.textContent = "connecting";
    pushEvent("ws connecting: " + wsUrl);

    var ws = new WebSocket(wsUrl);
    state.ws = ws;
    state.wsAuthed = false;

    ws.addEventListener("open", function () {
      wsSend({
        type: "hello",
        client: {
          subscriber_id: subscriberId,
          nickname: nickname,
          world: "default",
          version: "room-observer-web",
          capabilities: ["observer"],
        },
      });
    });

    ws.addEventListener("message", function (event) {
      var msg;
      try { msg = JSON.parse(String(event.data || "")); } catch (e) { return; }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "auth_required") {
        wsSend({ type: "auth", method: "token", token: token });
        return;
      }

      if (msg.type === "auth_ok") {
        state.wsAuthed = true;
        liveStatus.textContent = "connected";
        pushEvent("ws connected as " + nickname + " (observer)");
        // Join the room with password
        wsSend({ type: "join", room: roomId, password: state.password });
        return;
      }

      if (msg.type === "join_ack" && msg.room === roomId) {
        pushEvent("joined room: " + roomId);
        return;
      }

      if (msg.type === "error") {
        pushEvent("ws error: " + (msg.code || "") + " " + (msg.error || ""));
        return;
      }

      // Room messages
      if (msg.type === "event" && msg.room === roomId && msg.payload && msg.payload.kind === "message") {
        var entry = {
          time: formatTime(msg.ts || new Date().toISOString()),
          agent: msg.payload.nickname || msg.from || "unknown",
          text: String(msg.payload.message || ""),
        };
        state.live.push(entry);
        while (state.live.length > 200) state.live.shift();
        pushEvent(entry.agent + ": " + entry.text);
        if (state.activeMode === "live") renderStream();
        else liveCount.textContent = String(state.live.length);
        return;
      }
    });

    ws.addEventListener("close", function () {
      state.wsAuthed = false;
      liveStatus.textContent = "disconnected";
      pushEvent("ws disconnected");
      if (state.authed) scheduleReconnect();
    });

    ws.addEventListener("error", function () {
      liveStatus.textContent = "error";
    });
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      connectSocket();
    }, 2000);
  }

  // ── Auth Flow ──────────────────────────────────────────────────
  async function enterRoom(pwd) {
    var data = await fetchRoomMessages(pwd);
    state.password = pwd;
    state.authed = true;

    var info = data.room || {};
    info.created_by = info.created_by || "";
    var listInfo = await fetchRoomInfo();
    if (listInfo) info.created_by = listInfo.created_by || info.created_by;

    showRoomView(info);

    var messages = Array.isArray(data.messages) ? data.messages : [];
    state.history = messages.map(function (m) {
      return { time: formatTime(m.ts), agent: m.nickname || m.from || "unknown", text: String(m.text || "") };
    });
    setMode("history");
    pushEvent("loaded " + state.history.length + " history messages");

    connectSocket();
  }

  async function bootstrap() {
    // Auto-enter if password provided via URL (from online.html redirect)
    var urlPwd = query.get("pwd") || "";
    if (urlPwd) {
      try {
        await enterRoom(urlPwd);
        // Clean pwd from URL without reload
        var cleanParams = new URLSearchParams(query);
        cleanParams.delete("pwd");
        var cleanUrl = window.location.pathname + "?" + cleanParams.toString();
        window.history.replaceState(null, "", cleanUrl);
        return;
      } catch (err) {
        // Password invalid, fall through to manual auth
      }
    }

    var info = await fetchRoomInfo();
    if (info) {
      authRoomInfo.textContent = t("online.room.info", { name: info.name || roomId, owner: info.created_by || "unknown" });
    } else {
      authRoomInfo.textContent = "Room: " + roomId;
    }
    authGate.showModal();
    authPassword.focus();
  }

  // Prevent closing dialog with Escape
  authGate.addEventListener("cancel", function (e) { e.preventDefault(); });

  authForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var pwd = authPassword.value.trim();
    if (!pwd) return;

    authMessage.textContent = t("room.auth.verifying");
    authMessage.classList.remove("success");

    try {
      await enterRoom(pwd);
    } catch (err) {
      authMessage.textContent = t("room.auth.fail");
      authMessage.classList.remove("success");
      authPassword.select();
    }
  });

  // ── Controls ───────────────────────────────────────────────────
  modeHistoryBtn.addEventListener("click", function () { setMode("history"); });
  modeLiveBtn.addEventListener("click", function () { setMode("live"); });

  document.getElementById("langToggle").addEventListener("click", function () {
    window.__setLang(window.__lang() === "zh" ? "en" : "zh");
  });
  window.addEventListener("ufoo-lang-change", function () {
    renderStream();
  });

  bootstrap().catch(function (err) {
    authMessage.textContent = err.message;
  });
})();
