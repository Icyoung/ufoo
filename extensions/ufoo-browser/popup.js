"use strict";

const STATUS_LABELS = {
  connected: { text: "已连接", cls: "connected", title: "浏览器已就绪", detail: "ufoo 与 ucode 可以按任务操作网页。你可以随时暂停或释放页面控制。" },
  paused: { text: "已暂停", cls: "paused", title: "浏览器控制已暂停", detail: "已停止全部页面控制。恢复后，Agent 可以继续发起浏览器任务。" },
  waiting_for_ufoo: { text: "等待连接", cls: "", title: "等待本机 ufoo", detail: "打开 ufoo 或 ucode 后会自动尝试连接，你也可以手动重试。" },
  native_not_installed: { text: "需要安装", cls: "error", title: "还差一步，连接本机", detail: "尚未找到本机浏览器组件。安装后，就能将网页交给 Agent 操作。", help: "在终端运行下面的命令，完成后重新连接。", command: "ufoo browser install" },
  disabled: { text: "已禁用", cls: "", title: "浏览器连接已关闭", detail: "请先在本机启用浏览器功能，再重新连接。", help: "在终端启用浏览器功能：", command: "ufoo browser enable" },
  protocol_mismatch: { text: "需要更新", cls: "error", title: "更新后即可继续连接", detail: "插件与本机 ufoo 的版本不兼容，请更新后再试。", help: "将 ufoo 与浏览器插件更新至配套版本，然后在 Chrome 扩展管理页重新加载插件。" },
  connecting: { text: "连接中", cls: "", title: "正在连接你的浏览器", detail: "正在查找本机 ufoo，请稍候。" },
};

const byId = id => document.getElementById(id);
let busy = false;

function setBusy(value) {
  busy = value;
  document.querySelector(".panel").setAttribute("aria-busy", String(value));
  document.querySelectorAll("button").forEach(button => { button.disabled = value; });
}

function showError(message) {
  byId("action-error").textContent = message;
  byId("action-error").hidden = !message;
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("操作超时，请重试。")), 8000);
    try {
      chrome.runtime.sendMessage(message, response => {
        clearTimeout(timer);
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || "暂时无法连接插件，请重新打开面板。"));
        else if (!response || response.ok === false) reject(new Error(response?.error || "操作未完成，请重试。"));
        else resolve(response);
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

async function perform(action) {
  if (busy) return;
  showError("");
  setBusy(true);
  try { await action(); }
  catch (error) { showError(error.message || "操作未完成，请重试。"); }
  finally { setBusy(false); }
}

function displayUrl(value) {
  try {
    const url = new URL(value);
    return url.host ? `${url.host}${url.pathname === "/" ? "" : url.pathname}` : value;
  } catch { return value || "地址暂不可用"; }
}

function renderState(state = {}) {
  const connectionState = state.paused ? "paused" : state.connectionState;
  const meta = STATUS_LABELS[connectionState] || STATUS_LABELS.connecting;
  byId("status-badge").textContent = meta.text;
  byId("status-badge").className = `badge ${meta.cls}`.trim();
  document.querySelector(".connection").dataset.state = connectionState || "connecting";
  byId("status-title").textContent = meta.title;
  byId("status-detail").textContent = meta.detail;
  byId("connection-help").hidden = !(meta.help || state.error);
  byId("help-text").textContent = meta.help || "如果连接一直没有恢复，请重新打开 ufoo 并重试。";
  byId("help-command").hidden = !meta.command;
  byId("help-command").textContent = meta.command || "";
  byId("connection-error").textContent = state.error || "";
  byId("connection-error").hidden = !state.error;
  const paused = connectionState === "paused";
  byId("toggle-pause").textContent = paused ? "恢复浏览器控制" : "暂停全部控制";
  byId("toggle-pause").hidden = !paused && connectionState !== "connected";
  byId("reconnect").hidden = paused || connectionState === "connected";

  const list = byId("tab-list");
  const focusedTab = list.contains(document.activeElement) ? document.activeElement.dataset.tabId : null;
  list.replaceChildren();
  const owners = Array.isArray(state.tabOwners) ? state.tabOwners : [];
  byId("tab-count").textContent = String(owners.length);
  byId("project-count").textContent = owners.length
    ? `${new Set(owners.map(item => item.projectName || "ufoo")).size} 个项目协作中` : "随时可以释放控制";
  byId("empty-tabs").hidden = owners.length > 0;
  byId("empty-title").textContent = paused ? "页面控制已释放" : "还没有正在协作的页面";
  byId("empty-detail").textContent = paused
    ? "你可以自由浏览。恢复控制后，这里会显示新的浏览器任务。"
    : "在 ufoo 或 ucode 中发起浏览器任务，正在被操作的页面会显示在这里。";
  for (const item of owners) {
    const li = document.createElement("li");
    li.className = "tab-item";
    const icon = document.createElement("span");
    icon.className = "tab-symbol";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 18 20"><path d="M4 2h7l3 3v13H4zM10 2v4h4M7 10h4M7 13h4"/></svg>';
    const info = document.createElement("div");
    info.className = "tab-meta";
    const owner = document.createElement("div");
    owner.className = "tab-owner";
    owner.textContent = `${item.projectName || "ufoo"} / ${item.agentName || "agent"}`;
    owner.title = owner.textContent;
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = item.title || `标签页 ${item.tabId}`;
    title.title = title.textContent;
    const url = document.createElement("div");
    url.className = "tab-url";
    url.textContent = displayUrl(item.url);
    url.title = item.url || "";
    info.append(owner, title, url);
    const release = document.createElement("button");
    release.className = "btn btn-release";
    release.type = "button";
    release.textContent = "释放";
    release.dataset.tabId = String(item.tabId);
    release.setAttribute("aria-label", `释放此标签页：${title.textContent}`);
    release.title = "停止 Agent 对此页面的控制";
    release.disabled = busy;
    release.addEventListener("click", () => perform(async () => {
      await sendMessage({ type: "ufoo.releaseTab", tabId: item.tabId });
      await refresh();
    }));
    li.append(icon, info, release);
    list.appendChild(li);
  }
  if (focusedTab !== null) {
    const buttons = [...list.querySelectorAll("button")];
    const next = buttons.find(button => button.dataset.tabId === focusedTab) || buttons[0]
      || (byId("toggle-pause").hidden ? byId("reconnect") : byId("toggle-pause"));
    if (!next.disabled) next.focus();
  }
}

async function refresh() { renderState(await sendMessage({ type: "ufoo.getStatus" })); }

byId("toggle-pause").addEventListener("click", () => perform(async () => {
  const current = await sendMessage({ type: "ufoo.getStatus" });
  const type = current.paused || current.connectionState === "paused" ? "ufoo.resumeAll" : "ufoo.pauseAll";
  renderState(await sendMessage({ type }));
}));
byId("reconnect").addEventListener("click", () => perform(async () => {
  await sendMessage({ type: "ufoo.reconnect" });
  await refresh();
}));
chrome.storage.onChanged.addListener((changes, area) => {
  if ((!area || area === "local") && changes.ufooBrowserState?.newValue) renderState(changes.ufooBrowserState.newValue);
});
const version = chrome.runtime.getManifest?.().version;
byId("version").textContent = version ? `v${version}` : "";
refresh().catch(error => {
  renderState({ connectionState: "waiting_for_ufoo", error: error.message });
  showError("暂时无法读取连接状态，请重试。");
});
