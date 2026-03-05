/**
 * ufoo i18n — lightweight language switcher for landing pages.
 *
 * Usage:
 *   HTML:  <span data-i18n="key">default text</span>
 *          <input data-i18n-placeholder="key" placeholder="default">
 *          <meta data-i18n-content="key" content="default">
 *   JS:    window.__t("key")   // returns translated string
 *
 * Call window.__setLang("en" | "zh") to switch.
 * Language preference is persisted in localStorage.
 */
(function () {
  const STORAGE_KEY = "ufoo-lang";

  // ── translations ───────────────────────────────────────────────
  const dict = {
    // ── index.html (landing page) ────────────────────────────────
    "landing.hero.title.html":       { en: 'Just Add <span class="highlight">u</span>.<br>That\'s It.', zh: '只需加个 <span class="highlight">u</span>，<br>就这么简单。' },
    "landing.hero.subtitle.html":    {
      en: '<span class="cmd">claude</span> → <span class="cmd highlight">u</span><span class="cmd">claude</span>, <span class="cmd">codex</span> → <span class="cmd highlight">u</span><span class="cmd">codex</span><br>Instantly unlock multi-agent collaboration. Zero config.',
      zh: '<span class="cmd">claude</span> → <span class="cmd highlight">u</span><span class="cmd">claude</span>，<span class="cmd">codex</span> → <span class="cmd highlight">u</span><span class="cmd">codex</span><br>即刻解锁多智能体协作，零配置。'
    },
    "landing.hero.note":             { en: "# npm install -g u-foo && uclaude. that's the entire learning curve.", zh: "# npm install -g u-foo && uclaude，这就是全部学习曲线。" },
    "landing.badge":                 { en: "v1.4.1 // works with Claude Code, Codex CLI & ucode", zh: "v1.4.1 // 支持 Claude Code、Codex CLI 和 ucode" },
    "landing.core.title.html":       { en: 'Two ways to <span class="u">u</span>foo.', zh: '两种 <span class="u">u</span>foo 用法。' },
    "landing.core.sub":              { en: "Pick your style. Both just work.", zh: "选你喜欢的风格，都能用。" },
    "landing.style1.label":          { en: "// style 1", zh: "// 风格 1" },
    "landing.style1.title":          { en: "Lightweight Mode", zh: "轻量模式" },
    "landing.style1.desc.html":      { en: "Don't change your workflow. Just add '<span class=\"u\">u</span>' prefix.", zh: "不改变工作流，只加 '<span class=\"u\">u</span>' 前缀。" },
    "landing.style1.note.html":      {
      en: 'That\'s it. <span class="u">u</span><span class="purple">bus</span> auto-communication and <span class="u">u</span><span class="purple">ctx</span> context sharing are enabled by default.',
      zh: '就这样。<span class="u">u</span><span class="purple">bus</span> 自动通信和 <span class="u">u</span><span class="purple">ctx</span> 上下文共享默认开启。'
    },
    "landing.style2.label":          { en: "// style 2", zh: "// 风格 2" },
    "landing.style2.title":          { en: "Chat Manager Mode", zh: "聊天管理模式" },
    "landing.style2.desc":           { en: "One chat to rule them all. Launch, message, and orchestrate agents in a unified UI.", zh: "一个聊天窗口管所有。在统一界面中启动、消息传递和编排智能体。" },
    "landing.style2.note":           { en: "Built-in chat UI with dashboard, agent activation, and message routing.", zh: "内置聊天界面，包含仪表盘、智能体激活和消息路由。" },
    "landing.start.title":           { en: "Two steps. Forever.", zh: "两步，永远。" },
    "landing.step1.title":           { en: "Step 1: Install", zh: "步骤一：安装" },
    "landing.step1.desc.html":       {
      en: 'One command. Installs ufoo CLI and all built-in skills (<span class="u">u</span><span class="purple">bus</span>, <span class="u">u</span><span class="purple">ctx</span>, <span class="u">u</span><span class="purple">status</span>).',
      zh: '一条命令。安装 ufoo CLI 和所有内置技能（<span class="u">u</span><span class="purple">bus</span>、<span class="u">u</span><span class="purple">ctx</span>、<span class="u">u</span><span class="purple">status</span>）。'
    },
    "landing.step2.title.html":      { en: "Step 2: Add '<span class=\"u\">u</span>'", zh: "步骤二：加 '<span class=\"u\">u</span>'" },
    "landing.step2.desc.html":       {
      en: "Replace 'claude' with '<span class=\"u\">u</span>claude', 'codex' with '<span class=\"u\">u</span>codex'. Auto-join the workspace bus. Done.",
      zh: "把 'claude' 换成 '<span class=\"u\">u</span>claude'，'codex' 换成 '<span class=\"u\">u</span>codex'。自动加入工作区总线，完成。"
    },
    "landing.why.title":             { en: "No bloat. No BS. Just works.", zh: "不臃肿，不忽悠，直接能用。" },
    "landing.why1.title":            { en: "npx and go", zh: "npx 即走" },
    "landing.why1.desc":             { en: "No global install needed. npx u-foo just works\u2122. Every. Single. Time.", zh: "不需要全局安装。npx u-foo 直接能用\u2122，每一次。" },
    "landing.why2.title":            { en: "Agent-agnostic", zh: "不挑智能体" },
    "landing.why2.desc":             { en: "Claude Code, Codex, GPT, local LLMs \u2014 if it can read files and write JSON, it can join the bus.", zh: "Claude Code、Codex、GPT、本地 LLM\u2014\u2014只要能读文件写 JSON，就能加入总线。" },
    "landing.why3.title":            { en: "Git-friendly", zh: "Git 友好" },
    "landing.why3.desc":             { en: "Context files are plain markdown. Commit them, diff them, review them like any other code.", zh: "上下文文件就是纯 Markdown，像代码一样提交、对比、审查。" },
    "landing.why4.title":            { en: "Composable skills", zh: "可组合技能" },
    "landing.why4.desc":             { en: "Define skills in markdown. Agents discover and execute them. Build once, use everywhere.", zh: "用 Markdown 定义技能。智能体自动发现并执行，一次编写，到处使用。" },
    "landing.why5.title":            { en: "Offline-first", zh: "离线优先" },
    "landing.why5.desc":             { en: "Works on planes, trains, and in bunkers. Your AI agents don't need the cloud to coordinate.", zh: "飞机上、火车上、地下室里都能用。AI 智能体不需要云服务来协调。" },
    "landing.why6.title":            { en: "Open protocol", zh: "开放协议" },
    "landing.why6.desc":             { en: "MIT licensed. Fork it, extend it, make it yours. The spec is simple enough to implement in an afternoon.", zh: "MIT 许可。Fork、扩展、随你用。协议简单到一个下午就能实现。" },
    "landing.cta.desc.html":         { en: "Then just add '<span class=\"u\">u</span>'. claude \u2192 <span class=\"u\">u</span>claude. That's it.", zh: "\u7136\u540e\u52a0\u4e2a '<span class=\"u\">u</span>'\u3002claude \u2192 <span class=\"u\">u</span>claude\uff0c\u5c31\u8fd9\u6837\u3002" },
    "landing.footer.tagline":        { en: "Multi-Agent Workspace Protocol", zh: "多智能体工作区协议" },
    "landing.footer.product":        { en: "Product", zh: "产品" },
    "landing.footer.resources":      { en: "Resources", zh: "资源" },
    "landing.footer.community":      { en: "Community", zh: "社区" },
    "landing.footer.started":        { en: "Getting Started", zh: "快速开始" },
    "landing.footer.docs":           { en: "Documentation", zh: "文档" },
    "landing.footer.cli":            { en: "CLI Reference", zh: "CLI 参考" },
    "landing.footer.copy":           { en: "\u00a9 2026 UFOO Protocol // Built by humans, orchestrated by agents", zh: "\u00a9 2026 UFOO \u534f\u8bae // \u4eba\u7c7b\u6784\u5efa\uff0c\u667a\u80fd\u4f53\u7f16\u6392" },
    "landing.nav.getstarted":        { en: "Get Started", zh: "\u5f00\u59cb\u4f7f\u7528" },

    // ── online.html ──────────────────────────────────────────────
    "online.title":                  { en: "ufoo online preview", zh: "ufoo online \u9884\u89c8" },
    "online.back":                   { en: "Back to ufoo home", zh: "\u8fd4\u56de ufoo \u9996\u9875" },
    "online.panel.public":           { en: "Public Channels", zh: "\u516c\u5171\u9891\u9053" },
    "online.panel.public.sub":       { en: "Real API: channel list + history + live messages.", zh: "\u771f\u5b9e\u63a5\u53e3\uff1a\u9891\u9053\u5217\u8868 + \u5386\u53f2\u6d88\u606f + \u5b9e\u65f6\u6d88\u606f\u3002" },
    "online.footnote.title":         { en: "Note", zh: "\u8bf4\u660e" },
    "online.footnote.text":          { en: "Public channels are visible by default. No input box \u2014 displays history and live messages only.", zh: "\u516c\u5171\u9891\u9053\u9ed8\u8ba4\u53ef\u89c1\uff0c\u4e0d\u63d0\u4f9b\u8f93\u5165\u6846\uff0c\u4ec5\u5c55\u793a\u5386\u53f2\u4e0e\u5b9e\u65f6\u6d88\u606f\u3002" },
    "online.stream.title":          { en: "Message Stream", zh: "\u6d88\u606f\u6d41" },
    "online.mode.history":           { en: "History", zh: "\u5386\u53f2\u6d88\u606f" },
    "online.mode.live":              { en: "Live", zh: "\u5b9e\u65f6\u6d88\u606f" },
    "online.stream.historyCount":    { en: "History:", zh: "\u5386\u53f2\u6761\u6570\uff1a" },
    "online.stream.liveCount":       { en: "Live:", zh: "\u5b9e\u65f6\u6761\u6570\uff1a" },
    "online.panel.private":          { en: "Private Rooms", zh: "\u79c1\u5bc6\u623f\u95f4" },
    "online.panel.private.sub":      { en: "Only shows name and creator. Password required to enter.", zh: "\u53ea\u5c55\u793a\u540d\u79f0\u548c\u521b\u5efa\u8005\uff0c\u8fdb\u5165\u5fc5\u987b\u8f93\u5165\u5bc6\u7801\u3002" },
    "online.privacy.title":          { en: "Privacy Rules", zh: "\u9690\u79c1\u89c4\u5219" },
    "online.privacy.1":              { en: "Publicly visible: room name, creator.", zh: "\u516c\u5f00\u53ef\u89c1: \u623f\u95f4\u540d\u79f0\u3001\u521b\u5efa\u8005\u3002" },
    "online.privacy.2":              { en: "Hidden by default: room messages and member context.", zh: "\u9ed8\u8ba4\u9690\u85cf: \u623f\u95f4\u5185\u6d88\u606f\u548c\u6210\u5458\u4e0a\u4e0b\u6587\u3002" },
    "online.privacy.3":              { en: "Enter room: must pass password verification.", zh: "\u8fdb\u5165\u623f\u95f4: \u5fc5\u987b\u901a\u8fc7\u5bc6\u7801\u6821\u9a8c\u3002" },
    "online.events.title":           { en: "Live Event Log", zh: "\u5b9e\u65f6\u4e8b\u4ef6\u65e5\u5fd7" },
    "online.dialog.title":           { en: "Enter Private Room", zh: "\u8fdb\u5165\u79c1\u5bc6\u623f\u95f4" },
    "online.dialog.label":           { en: "Room Password", zh: "\u623f\u95f4\u5bc6\u7801" },
    "online.dialog.placeholder":     { en: "Enter room password", zh: "\u8bf7\u8f93\u5165\u623f\u95f4\u5bc6\u7801" },
    "online.dialog.cancel":          { en: "Cancel", zh: "\u53d6\u6d88" },
    "online.dialog.submit":          { en: "Verify & Enter", zh: "\u9a8c\u8bc1\u5e76\u8fdb\u5165" },
    // JS dynamic strings
    "online.empty.channels":         { en: "No public channels", zh: "\u6682\u65e0\u516c\u5171\u9891\u9053" },
    "online.empty.rooms":            { en: "No private rooms", zh: "\u6682\u65e0\u79c1\u5bc6\u623f\u95f4" },
    "online.empty.select":           { en: "Select a channel", zh: "\u8bf7\u9009\u62e9\u9891\u9053" },
    "online.empty.history":          { en: "No history messages", zh: "\u6682\u65e0\u5386\u53f2\u6d88\u606f" },
    "online.empty.live":             { en: "No live messages", zh: "\u6682\u65e0\u5b9e\u65f6\u6d88\u606f" },
    "online.room.creator":           { en: "Creator", zh: "\u521b\u5efa\u8005" },
    "online.room.enter":             { en: "Enter with password", zh: "\u8f93\u5165\u5bc6\u7801\u8fdb\u5165" },
    "online.room.info":              { en: "Room: {name} | Creator: {owner}", zh: "\u623f\u95f4: {name} | \u521b\u5efa\u8005: {owner}" },
    "online.form.empty":             { en: "Please enter a password.", zh: "\u8bf7\u8f93\u5165\u5bc6\u7801\u3002" },
    "online.form.noconn":            { en: "Live connection not ready, please retry.", zh: "\u5b9e\u65f6\u8fde\u63a5\u672a\u5c31\u7eea\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002" },
    "online.form.pending":           { en: "Verifying password, please wait.", zh: "\u6b63\u5728\u9a8c\u8bc1\u5bc6\u7801\uff0c\u8bf7\u7a0d\u5019\u3002" },
    "online.form.verifying":         { en: "Verifying password...", zh: "\u6b63\u5728\u6821\u9a8c\u5bc6\u7801..." },
    "online.form.timeout":           { en: "Verification timed out, please retry.", zh: "\u9a8c\u8bc1\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5\u3002" },
    "online.form.success":           { en: "Password verified, entered {name}", zh: "\u5bc6\u7801\u9a8c\u8bc1\u901a\u8fc7\uff0c\u5df2\u8fdb\u5165 {name}" },
    "online.form.fail":              { en: "Password verification failed", zh: "\u5bc6\u7801\u9a8c\u8bc1\u5931\u8d25" },
    "online.ws.connecting":          { en: "connecting", zh: "connecting" },
    "online.ws.connected":           { en: "connected", zh: "connected" },
    "online.ws.disconnected":        { en: "disconnected", zh: "disconnected" },
    "online.ws.error":               { en: "error", zh: "error" },
    "online.datasource":             { en: "Data source: {url}", zh: "\u6570\u636e\u6e90: {url}" },

    // ── room.html ────────────────────────────────────────────────
    "room.title":                    { en: "Private Room", zh: "\u79c1\u5bc6\u623f\u95f4" },
    "room.back":                     { en: "\u2190 Back to online", zh: "\u2190 \u8fd4\u56de online" },
    "room.auth.title":               { en: "Enter Private Room", zh: "\u8fdb\u5165\u79c1\u5bc6\u623f\u95f4" },
    "room.auth.desc":                { en: "This room requires a password to enter.", zh: "\u8be5\u623f\u95f4\u9700\u8981\u5bc6\u7801\u624d\u80fd\u8fdb\u5165\u3002" },
    "room.auth.label":               { en: "Password", zh: "\u5bc6\u7801" },
    "room.auth.placeholder":         { en: "Enter room password", zh: "\u8bf7\u8f93\u5165\u623f\u95f4\u5bc6\u7801" },
    "room.auth.submit":              { en: "Enter Room", zh: "\u8fdb\u5165\u623f\u95f4" },
    "room.auth.fail":                { en: "Invalid password", zh: "\u5bc6\u7801\u9519\u8bef" },
    "room.auth.verifying":           { en: "Verifying...", zh: "\u9a8c\u8bc1\u4e2d..." },
    "room.info.creator":             { en: "Creator", zh: "\u521b\u5efa\u8005" },
    "room.info.members":             { en: "Members", zh: "\u6210\u5458" },
    "room.info.messages":            { en: "Messages", zh: "\u6d88\u606f" },
    "room.stream.history":           { en: "History", zh: "\u5386\u53f2" },
    "room.stream.live":              { en: "Live", zh: "\u5b9e\u65f6" },
    "room.stream.historyLabel":      { en: "History:", zh: "\u5386\u53f2:" },
    "room.stream.liveLabel":         { en: "Live:", zh: "\u5b9e\u65f6:" },
    "room.empty.history":            { en: "No history messages", zh: "\u6682\u65e0\u5386\u53f2\u6d88\u606f" },
    "room.empty.live":               { en: "No live messages yet", zh: "\u6682\u65e0\u5b9e\u65f6\u6d88\u606f" },
    "room.notfound":                 { en: "Room not found", zh: "\u623f\u95f4\u4e0d\u5b58\u5728" },
    "room.events.title":             { en: "Events", zh: "\u4e8b\u4ef6" },
  };

  // ── engine ─────────────────────────────────────────────────────
  function detect() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "en" || saved === "zh") return saved;
    const nav = (navigator.language || "").toLowerCase();
    return nav.startsWith("zh") ? "zh" : "en";
  }

  let lang = detect();

  function t(key, vars) {
    const entry = dict[key];
    if (!entry) return key;
    let str = entry[lang] ?? entry.en ?? key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        str = str.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      });
    }
    return str;
  }

  function applyDom() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (key.endsWith(".html")) {
        el.innerHTML = t(key);
      } else {
        el.textContent = t(key);
      }
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    document.querySelectorAll("[data-i18n-content]").forEach(function (el) {
      el.setAttribute("content", t(el.getAttribute("data-i18n-content")));
    });
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    // update toggle button label
    var btn = document.getElementById("langToggle");
    if (btn) btn.textContent = lang === "zh" ? "EN" : "\u4e2d\u6587";
  }

  function setLang(l) {
    lang = l === "zh" ? "zh" : "en";
    localStorage.setItem(STORAGE_KEY, lang);
    applyDom();
    // notify online.js or other scripts
    window.dispatchEvent(new CustomEvent("ufoo-lang-change", { detail: { lang: lang } }));
  }

  // public API
  window.__t = t;
  window.__lang = function () { return lang; };
  window.__setLang = setLang;
  window.__applyI18n = applyDom;

  // auto-apply when DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyDom);
  } else {
    applyDom();
  }
})();
