"use strict";

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNicknameSegment(value = "", fallback = "task") {
  const normalized = asTrimmedString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function stripRoutingPromptMetadata(prompt = "") {
  let text = String(prompt || "");
  const markers = [
    "\nRouting request metadata (JSON):",
    "\nPrivate runtime reports for ufoo-agent (JSON):",
    "\nController loop state (JSON):",
    "\nController tool results so far (JSON):",
  ];
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0) {
      text = text.slice(0, index);
    }
  }
  return text.trim();
}

function normalizeLaunchAgentForNickname(agent = "") {
  const raw = asTrimmedString(agent).toLowerCase();
  if (raw === "claude" || raw === "claude-code" || raw === "uclaude") return "claude";
  if (raw === "codex" || raw === "ucodex") return "codex";
  if (raw === "ufoo" || raw === "ucode" || raw === "ufoo-code") return "ucode";
  return "";
}

function nicknameCapturePattern() {
  return "(?:`([^`]{1,32})`|[\"'“”]([^\"'“”]{1,32})[\"'“”]?|([A-Za-z0-9_-]{1,32}))";
}

function pickNicknameCapture(match) {
  if (!match) return "";
  for (let i = 1; i < match.length; i += 1) {
    const value = asTrimmedString(match[i]);
    if (value) return normalizeNicknameSegment(value, "");
  }
  return "";
}

function extractRequestedLaunchNickname(prompt = "") {
  const text = stripRoutingPromptMetadata(prompt);
  if (!text) return "";
  const value = nicknameCapturePattern();
  const patterns = [
    new RegExp(`(?:launch|start|create|spawn|open|new|启动|新建|创建|拉起)[\\s\\S]{0,80}(?:named|name|nickname|叫做|叫|名为|昵称|取名|为)\\s*${value}`, "i"),
    new RegExp(`(?:named|name|nickname|叫做|叫|名为|昵称|取名)\\s*${value}[\\s\\S]{0,80}(?:agent|worker|codex|claude|ucode|ufoo|代理|智能体)`, "i"),
  ];
  for (const re of patterns) {
    const nickname = pickNicknameCapture(text.match(re));
    if (nickname) return nickname;
  }
  return "";
}

function collectKeywordTokens(text = "") {
  const specs = [
    [/处理|修复|解决|排查/g, "fix"],
    [/路由|主路由/g, "route"],
    [/启动|新启动|拉起/g, "launch"],
    [/投递|派发|发送|分发/g, "dispatch"],
    [/任务|工作/g, "task"],
    [/测试|验证/g, "test"],
    [/前端|界面/g, "frontend"],
    [/后端|服务端/g, "backend"],
    [/设计/g, "design"],
    [/审查|评审/g, "review"],
    [/调试/g, "debug"],
    [/重构/g, "refactor"],
    [/发布/g, "release"],
    [/文档/g, "docs"],
    [/性能/g, "perf"],
  ];
  const matches = [];
  for (const [re, token] of specs) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match) {
      matches.push({ index: match.index, token });
      match = re.exec(text);
    }
  }
  return matches
    .sort((a, b) => a.index - b.index)
    .map((item) => item.token);
}

const ENGLISH_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "for", "with", "from", "this", "that",
  "please", "pls", "ufoo", "chat", "agent", "agents", "worker", "workers",
  "nickname", "nick", "name", "named", "new", "current", "online", "source",
  "metadata", "json", "request", "user", "feedback", "bug", "issue",
]);

function collectEnglishTokens(text = "") {
  const rawTokens = String(text || "").toLowerCase().match(/[a-z][a-z0-9_-]{1,24}/g) || [];
  return rawTokens
    .map((token) => normalizeNicknameSegment(token, ""))
    .filter((token) => token && !ENGLISH_STOPWORDS.has(token));
}

function uniqueOrdered(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const token = normalizeNicknameSegment(value, "");
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function toExistingNicknameSet(existingNicknames = []) {
  if (existingNicknames instanceof Set) return new Set(existingNicknames);
  if (Array.isArray(existingNicknames)) return new Set(existingNicknames.map((item) => normalizeNicknameSegment(item, "")));
  if (existingNicknames && typeof existingNicknames === "object") {
    return new Set(Object.keys(existingNicknames).map((item) => normalizeNicknameSegment(item, "")));
  }
  return new Set();
}

function truncateNickname(value = "", maxLength = 32) {
  const normalized = normalizeNicknameSegment(value, "task");
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).replace(/-+$/g, "") || "task";
}

function makeUniqueNickname(base, existingNicknames = []) {
  const existing = toExistingNicknameSet(existingNicknames);
  const normalizedBase = truncateNickname(base);
  if (!existing.has(normalizedBase)) return normalizedBase;
  for (let i = 2; i < 100; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${truncateNickname(normalizedBase, 32 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${truncateNickname(normalizedBase, 27)}-${Date.now().toString(36).slice(-4)}`;
}

function collectExistingNicknames(context = {}) {
  const values = [];
  if (context && typeof context === "object") {
    if (context.nicknames && typeof context.nicknames === "object") {
      values.push(...Object.keys(context.nicknames));
    }
    if (Array.isArray(context.agents)) {
      for (const agent of context.agents) {
        if (agent && agent.nickname) values.push(agent.nickname);
      }
    }
  }
  return values;
}

function buildLaunchNickname(prompt = "", agent = "", existingNicknames = []) {
  const explicit = extractRequestedLaunchNickname(prompt);
  if (explicit) return makeUniqueNickname(explicit, existingNicknames);

  const corePrompt = stripRoutingPromptMetadata(prompt);
  const agentPrefix = normalizeLaunchAgentForNickname(agent) || "agent";
  const tokens = uniqueOrdered([
    ...collectKeywordTokens(corePrompt),
    ...collectEnglishTokens(corePrompt),
  ]).filter((token) => token !== agentPrefix);
  const stem = tokens.slice(0, 2).join("-") || "task";
  return makeUniqueNickname(`${agentPrefix}-${stem}`, existingNicknames);
}

function assignMissingLaunchNicknames(payload = {}, options = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.ops)) return payload;
  const existing = new Set(collectExistingNicknames(options.context));
  let changed = false;
  const ops = payload.ops.map((op) => {
    if (!op || op.action !== "launch" || op.nickname) return op;
    const count = Number.parseInt(op.count || 1, 10);
    if (Number.isFinite(count) && count > 1) return op;
    const nickname = buildLaunchNickname(options.prompt || "", op.agent || "", existing);
    existing.add(nickname);
    changed = true;
    return { ...op, nickname };
  });
  return changed ? { ...payload, ops } : payload;
}

module.exports = {
  assignMissingLaunchNicknames,
  buildLaunchNickname,
  collectExistingNicknames,
  extractRequestedLaunchNickname,
  normalizeLaunchAgentForNickname,
  stripRoutingPromptMetadata,
};
