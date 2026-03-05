(function () {
  const query = new URLSearchParams(window.location.search);
  const apiBase = (query.get("api") || "https://online.ufoo.dev").replace(/\/+$/, "");
  const wsUrl = query.get("ws") || `${apiBase.replace(/^http/i, "ws")}/ufoo/online`;
  const token = query.get("token") || "public-preview";
  const nickname = query.get("nick") || `web-preview-${Math.random().toString(36).slice(2, 8)}`;
  const subscriberId = `web-preview:${Math.random().toString(36).slice(2, 12)}`;

  const channelList = document.getElementById("channelList");
  const roomList = document.getElementById("roomList");
  const messageList = document.getElementById("messageList");
  const activeChannelLabel = document.getElementById("activeChannelLabel");
  const historyCount = document.getElementById("historyCount");
  const liveCount = document.getElementById("liveCount");
  const eventLog = document.getElementById("eventLog");
  const modeHistoryBtn = document.getElementById("modeHistory");
  const modeLiveBtn = document.getElementById("modeLive");
  const metaChannelCount = document.getElementById("metaChannelCount");
  const metaRoomCount = document.getElementById("metaRoomCount");
  const liveStatus = document.getElementById("liveStatus");
  const eventTag = document.getElementById("eventTag");
  const channelFootnote = document.getElementById("channelFootnote");

  const roomDialog = document.getElementById("roomDialog");
  const roomDialogInfo = document.getElementById("roomDialogInfo");
  const roomForm = document.getElementById("roomForm");
  const roomPassword = document.getElementById("roomPassword");
  const roomFormMessage = document.getElementById("roomFormMessage");
  const closeDialog = document.getElementById("closeDialog");

  const state = {
    channels: [],
    channelMap: new Map(),
    activeChannelId: "",
    activeMode: "history",
    joinedChannelId: "",
    ws: null,
    wsAuthed: false,
    reconnectTimer: null,
    rooms: [],
    selectedRoom: null,
    pendingRoomJoin: null,
  };

  function formatTime(ts) {
    if (!ts) return "--:--";
    const dt = new Date(ts);
    if (Number.isNaN(dt.getTime())) return String(ts).slice(11, 16) || String(ts);
    return dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function t(key, vars) { return window.__t ? window.__t(key, vars) : key; }

  function pushEvent(text) {
    const li = document.createElement("li");
    li.innerHTML = `<time>${formatTime(new Date().toISOString())}</time><span>${text}</span>`;
    eventLog.prepend(li);
    while (eventLog.children.length > 12) {
      eventLog.removeChild(eventLog.lastElementChild);
    }
  }

  function setLiveStatus(text) {
    liveStatus.textContent = text;
  }

  function getAuthHeaders() {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  async function fetchJson(pathname, { auth = false } = {}) {
    const response = await fetch(`${apiBase}${pathname}`, {
      headers: {
        Accept: "application/json",
        ...(auth ? getAuthHeaders() : {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function fetchWithFallback(publicPath, privatePath) {
    try {
      return await fetchJson(publicPath);
    } catch (error) {
      if (error.status && error.status !== 404) throw error;
      return fetchJson(privatePath, { auth: true });
    }
  }

  function normalizeChannel(raw) {
    const channelId = String(raw.channel_id || raw.id || raw.name || "").trim();
    if (!channelId) return null;
    const name = String(raw.name || raw.channel_name || channelId).trim();
    const existing = state.channelMap.get(channelId);
    return {
      channel_id: channelId,
      name,
      type: raw.type || "public",
      members: Number(raw.members || 0),
      created_by: String(raw.created_by || "").trim(),
      message_count: Number(raw.message_count || 0),
      history: existing ? existing.history : [],
      live: existing ? existing.live : [],
    };
  }

  function renderChannelList() {
    channelList.innerHTML = "";
    if (state.channels.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-item";
      li.textContent = t("online.empty.channels");
      channelList.appendChild(li);
      return;
    }

    state.channels.forEach((channel) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = `channel-item${channel.channel_id === state.activeChannelId ? " active" : ""}`;
      btn.type = "button";
      btn.dataset.channel = channel.channel_id;
      btn.innerHTML = `<span class="channel-name">#${channel.name}</span><em>history + live</em><b>${channel.message_count || 0}</b>`;
      btn.addEventListener("click", () => setChannel(channel.channel_id));
      li.appendChild(btn);
      channelList.appendChild(li);
    });
  }

  function renderRoomList() {
    roomList.innerHTML = "";
    if (state.rooms.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-item";
      li.textContent = t("online.empty.rooms");
      roomList.appendChild(li);
      return;
    }

    state.rooms.forEach((room) => {
      const li = document.createElement("li");
      li.className = "room-item";
      const roomName = room.name || room.room_id;
      const owner = room.created_by || "unknown";
      li.innerHTML = `
        <div>
          <strong>${roomName}</strong>
          <span>${t("online.room.creator")}: ${owner}</span>
          <p class="room-flags"><span>locked</span><span>metadata only</span></p>
        </div>
      `;
      const btn = document.createElement("button");
      btn.className = "join-btn";
      btn.type = "button";
      btn.textContent = t("online.room.enter");
      btn.addEventListener("click", () => openRoomDialog(room));
      li.appendChild(btn);
      roomList.appendChild(li);
    });
  }

  function renderStream() {
    const channel = state.channelMap.get(state.activeChannelId);
    if (!channel) {
      activeChannelLabel.textContent = "#-";
      historyCount.textContent = "0";
      liveCount.textContent = "0";
      messageList.innerHTML = `<li class="empty-item">${t("online.empty.select")}</li>`;
      return;
    }

    activeChannelLabel.textContent = `#${channel.name}`;
    historyCount.textContent = String(channel.history.length);
    liveCount.textContent = String(channel.live.length);

    const currentList = state.activeMode === "history" ? channel.history : channel.live;
    messageList.innerHTML = "";
    if (!currentList.length) {
      const li = document.createElement("li");
      li.className = "empty-item";
      li.textContent = state.activeMode === "history" ? t("online.empty.history") : t("online.empty.live");
      messageList.appendChild(li);
      return;
    }

    currentList.forEach((item) => {
      const li = document.createElement("li");
      li.innerHTML = `<time>${item.time}</time><strong>${item.agent}</strong><span>${item.text}</span>`;
      messageList.appendChild(li);
    });
  }

  function setMode(mode) {
    state.activeMode = mode;
    const isHistory = mode === "history";
    modeHistoryBtn.classList.toggle("active", isHistory);
    modeLiveBtn.classList.toggle("active", !isHistory);
    modeHistoryBtn.setAttribute("aria-selected", String(isHistory));
    modeLiveBtn.setAttribute("aria-selected", String(!isHistory));
    renderStream();
  }

  function wsSend(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function joinActiveChannel() {
    if (!state.wsAuthed || !state.activeChannelId) return;
    if (state.joinedChannelId && state.joinedChannelId !== state.activeChannelId) {
      wsSend({ type: "leave", channel: state.joinedChannelId });
    }
    state.joinedChannelId = state.activeChannelId;
    wsSend({ type: "join", channel: state.activeChannelId });
  }

  function handleIncomingChannelEvent(msg) {
    if (!msg || msg.type !== "event" || !msg.channel || !msg.payload || msg.payload.kind !== "message") return;
    const channelId = String(msg.channel);
    let channel = state.channelMap.get(channelId);
    if (!channel) {
      channel = normalizeChannel({ channel_id: channelId, name: channelId, type: "public", message_count: 0 });
      state.channelMap.set(channelId, channel);
      state.channels.push(channel);
      renderChannelList();
    }
    const entry = {
      time: formatTime(msg.ts || new Date().toISOString()),
      agent: msg.payload.nickname || msg.from || "unknown",
      text: String(msg.payload.message || ""),
    };
    channel.live.push(entry);
    while (channel.live.length > 120) channel.live.shift();
    channel.message_count += 1;
    pushEvent(`#${channel.name} <- ${entry.agent}: ${entry.text}`);
    renderChannelList();
    if (channel.channel_id === state.activeChannelId && state.activeMode === "live") {
      renderStream();
    } else {
      liveCount.textContent = String((state.channelMap.get(state.activeChannelId)?.live || []).length);
    }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectSocket();
    }, 1800);
  }

  function connectSocket() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setLiveStatus("connecting");
    pushEvent(`ws connecting: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    state.ws = ws;
    state.wsAuthed = false;

    ws.addEventListener("open", () => {
      wsSend({
        type: "hello",
        client: {
          subscriber_id: subscriberId,
          nickname,
          world: "default",
          version: "online-preview-web",
          capabilities: ["observer"],
        },
      });
    });

    ws.addEventListener("message", (event) => {
      let msg = null;
      try {
        msg = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "auth_required") {
        wsSend({ type: "auth", method: "token", token });
        return;
      }

      if (msg.type === "auth_ok") {
        state.wsAuthed = true;
        setLiveStatus("connected");
        pushEvent(`ws connected as ${nickname}`);
        joinActiveChannel();
        return;
      }

      if (msg.type === "join_ack" && msg.room && state.pendingRoomJoin && msg.room === state.pendingRoomJoin.roomId) {
        clearTimeout(state.pendingRoomJoin.timer);
        const pwd = state.pendingRoomJoin.password;
        state.pendingRoomJoin = null;
        roomFormMessage.textContent = t("online.form.success", { name: state.selectedRoom.name || msg.room });
        roomFormMessage.classList.add("success");
        wsSend({ type: "leave", room: msg.room });
        pushEvent(`private-room join success: ${msg.room}`);
        // Redirect to room page
        setTimeout(() => {
          const params = new URLSearchParams({ id: msg.room, pwd: pwd });
          if (query.get("api")) params.set("api", apiBase);
          window.location.href = `room.html?${params.toString()}`;
        }, 600);
        return;
      }

      if (msg.type === "error") {
        if (state.pendingRoomJoin) {
          clearTimeout(state.pendingRoomJoin.timer);
          state.pendingRoomJoin = null;
          roomFormMessage.textContent = msg.error || t("online.form.fail");
          roomFormMessage.classList.remove("success");
        }
        pushEvent(`ws error: ${msg.code || "UNKNOWN"} ${msg.error || ""}`.trim());
        return;
      }

      handleIncomingChannelEvent(msg);
    });

    ws.addEventListener("close", () => {
      state.wsAuthed = false;
      setLiveStatus("disconnected");
      pushEvent("ws disconnected");
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      setLiveStatus("error");
    });
  }

  async function loadChannels() {
    const data = await fetchWithFallback("/ufoo/online/public/channels", "/ufoo/online/channels");
    const rows = Array.isArray(data.channels) ? data.channels : [];
    const next = rows
      .map(normalizeChannel)
      .filter(Boolean)
      .filter((channel) => channel.type === "public" || channel.type === "world")
      .sort((a, b) => {
        if (a.type === "world" && b.type !== "world") return -1;
        if (a.type !== "world" && b.type === "world") return 1;
        return a.name.localeCompare(b.name);
      });

    state.channels = next;
    state.channelMap = new Map(next.map((channel) => [channel.channel_id, channel]));
    metaChannelCount.textContent = `public: ${next.length} channels`;
    renderChannelList();

    if (!state.activeChannelId || !state.channelMap.has(state.activeChannelId)) {
      state.activeChannelId = next[0] ? next[0].channel_id : "";
    }
    if (state.activeChannelId) {
      await loadChannelHistory(state.activeChannelId);
      joinActiveChannel();
    } else {
      renderStream();
    }
  }

  async function loadChannelHistory(channelId) {
    const data = await fetchWithFallback(
      `/ufoo/online/public/channels/${encodeURIComponent(channelId)}/messages?limit=120`,
      `/ufoo/online/channels/${encodeURIComponent(channelId)}/messages?limit=120`,
    );
    const channel = state.channelMap.get(channelId);
    if (!channel) return;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    channel.history = messages.map((item) => ({
      time: formatTime(item.ts),
      agent: item.nickname || item.from || "unknown",
      text: String(item.text || ""),
    }));
    channel.message_count = Math.max(channel.message_count, channel.history.length + channel.live.length);
    renderChannelList();
    renderStream();
  }

  async function loadRooms() {
    const data = await fetchWithFallback("/ufoo/online/public/rooms?type=private", "/ufoo/online/rooms");
    const rows = Array.isArray(data.rooms) ? data.rooms : [];
    state.rooms = rows
      .filter((room) => room.type === "private")
      .map((room) => ({
        room_id: String(room.room_id || ""),
        name: String(room.name || ""),
        created_by: String(room.created_by || "").trim(),
      }));
    metaRoomCount.textContent = `private: ${state.rooms.length} rooms`;
    renderRoomList();
  }

  async function setChannel(channelId) {
    if (!channelId || !state.channelMap.has(channelId)) return;
    state.activeChannelId = channelId;
    renderChannelList();
    renderStream();
    try {
      await loadChannelHistory(channelId);
    } catch (error) {
      pushEvent(`history load failed: ${error.message}`);
    }
    joinActiveChannel();
  }

  function openRoomDialog(room) {
    state.selectedRoom = room;
    roomDialogInfo.textContent = t("online.room.info", { name: room.name || room.room_id, owner: room.created_by || "unknown" });
    roomFormMessage.textContent = "";
    roomFormMessage.classList.remove("success");
    roomPassword.value = "";
    roomDialog.showModal();
    roomPassword.focus();
  }

  function handleRoomSubmit(event) {
    event.preventDefault();
    if (!state.selectedRoom) return;
    const pwd = roomPassword.value.trim();
    if (!pwd) {
      roomFormMessage.textContent = t("online.form.empty");
      roomFormMessage.classList.remove("success");
      return;
    }
    if (!state.wsAuthed) {
      roomFormMessage.textContent = t("online.form.noconn");
      roomFormMessage.classList.remove("success");
      return;
    }
    if (state.pendingRoomJoin) {
      roomFormMessage.textContent = t("online.form.pending");
      roomFormMessage.classList.remove("success");
      return;
    }

    const roomId = state.selectedRoom.room_id;
    const timer = setTimeout(() => {
      if (!state.pendingRoomJoin || state.pendingRoomJoin.roomId !== roomId) return;
      state.pendingRoomJoin = null;
      roomFormMessage.textContent = t("online.form.timeout");
      roomFormMessage.classList.remove("success");
    }, 5000);

    state.pendingRoomJoin = { roomId, timer, password: pwd };
    roomFormMessage.textContent = t("online.form.verifying");
    roomFormMessage.classList.remove("success");
    wsSend({ type: "join", room: roomId, password: pwd });
  }

  async function bootstrap() {
    eventTag.textContent = new URL(apiBase).host;
    channelFootnote.textContent = t("online.datasource", { url: `${apiBase}/ufoo/online/public/*` });
    pushEvent(`api base: ${apiBase}`);
    setMode("history");

    try {
      await Promise.all([loadChannels(), loadRooms()]);
    } catch (error) {
      pushEvent(`initial load failed: ${error.message}`);
    }

    connectSocket();
    setInterval(() => {
      loadChannels().catch(() => {});
      loadRooms().catch(() => {});
    }, 30000);
  }

  modeHistoryBtn.addEventListener("click", () => setMode("history"));
  modeLiveBtn.addEventListener("click", () => setMode("live"));
  closeDialog.addEventListener("click", () => roomDialog.close());
  roomDialog.addEventListener("cancel", () => roomDialog.close());
  roomForm.addEventListener("submit", handleRoomSubmit);

  document.getElementById("langToggle").addEventListener("click", function () {
    window.__setLang(window.__lang() === "zh" ? "en" : "zh");
  });
  window.addEventListener("ufoo-lang-change", function () {
    channelFootnote.textContent = t("online.datasource", { url: `${apiBase}/ufoo/online/public/*` });
    renderChannelList();
    renderRoomList();
    renderStream();
  });

  bootstrap().catch((error) => {
    pushEvent(`bootstrap failed: ${error.message}`);
  });
})();
