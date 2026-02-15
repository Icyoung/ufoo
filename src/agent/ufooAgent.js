const fs = require("fs");
const path = require("path");
const { runCliAgent } = require("./cliRunner");
const { normalizeCliOutput } = require("./normalizeOutput");
const { buildStatus } = require("../daemon/status");
const { getUfooPaths } = require("../ufoo/paths");
const {
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
} = require("../code/nativeRunner");

function loadSessionState(projectRoot) {
  const dir = getUfooPaths(projectRoot).agentDir;
  const file = path.join(dir, "ufoo-agent.json");
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, dir, data };
  } catch {
    return { file, dir, data: null };
  }
}

function saveSessionState(projectRoot, state) {
  const dir = getUfooPaths(projectRoot).agentDir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ufoo-agent.json"), JSON.stringify(state, null, 2));
}

function loadBusSummary(projectRoot, maxLines = 20) {
  // Use daemon's buildStatus as the single source of truth
  let agents = [];
  let nicknames = {};
  try {
    const status = buildStatus(projectRoot);
    const activeMeta = status.active_meta || [];
    agents = activeMeta.map((item) => {
      const nickname = item.nickname || "";
      if (nickname) {
        nicknames[nickname] = item.id;
      }
      return {
        id: item.id,
        status: "active",
        online: true,
        agent_type: "", // Not included in active_meta, but not needed
        nickname,
        last_heartbeat: "",
      };
    });
  } catch {
    agents = [];
    nicknames = {};
  }

  const eventsDir = getUfooPaths(projectRoot).busEventsDir;
  let recent = [];
  try {
    const files = fs
      .readdirSync(eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    const lastFile = files[files.length - 1];
    if (lastFile) {
      const lines = fs
        .readFileSync(path.join(eventsDir, lastFile), "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      recent = lines.slice(-maxLines);
    }
  } catch {
    recent = [];
  }

  return { agents, nicknames, recent };
}

function buildSystemPrompt(context) {
  const hasAgents = context.agents && context.agents.length > 0;
  const agentGuidance = hasAgents
    ? ""
    : "\n- IMPORTANT: No coding agents are currently online. For lightweight exploration or temporary command execution, prefer top-level assistant_call.\n- Use ops.launch only when persistent coding-agent sessions are necessary.";

  return [
    "You are ufoo-agent, a headless routing controller.",
    "You can call a private execution helper via top-level assistant_call (not visible on bus).",
    "Return ONLY valid JSON. No extra text.",
    "Schema:",
    "{",
    '  "reply": "string",',
    '  "assistant_call": {"kind":"explore|bash|mixed","task":"string","context":"optional","expect":"optional","provider":"codex|claude|ufoo (optional)","model":"optional","timeout_ms":60000},',
    '  "dispatch": [{"target":"broadcast|<agent-id>|<nickname>","message":"string"}],',
    '  "ops": [{"action":"launch|close|rename|cron","agent":"codex|claude|ucode","count":1,"agent_id":"id","nickname":"optional","operation":"start|list|stop","every":"30m","interval_ms":1800000,"target":"agent-id|nickname|csv","targets":["agent-id"],"prompt":"message","id":"task-id|all"}],',
    '  "disambiguate": {"prompt":"string","candidates":[{"agent_id":"id","reason":"string"}]}',
    "}",
    "Rules:",
    "- target must be 'broadcast', concrete agent-id, or a known nickname",
    "- If multiple possible agents, use disambiguate with candidates and no dispatch.",
    "- If user specifies a nickname for a new agent, include ops.launch with nickname so daemon can rename.",
    "- If user requests rename, use ops.rename with agent_id and nickname (do NOT launch).",
    "- For scheduled follow-up (cron/corn), use ops.cron with operation=start and include every+target(s)+prompt.",
    "- To check scheduled tasks, use ops.cron with operation=list.",
    "- To stop scheduled tasks, use ops.cron with operation=stop and id (or id=all).",
    "- Use top-level assistant_call for project exploration, temporary shell tasks, and quick execution support.",
    "- assistant_call fields: kind (explore|bash|mixed), task (required), context/expect (optional), provider (codex|claude|ufoo, optional), model/timeout_ms (optional).",
    "- Prefer assistant_call over launching coding agents when the task is short-lived.",
    "- Legacy compatibility: if model emits ops.assistant_call, daemon will still process it.",
    "- If no action needed, return reply with empty dispatch/ops.",
    agentGuidance,
    "",
    "Context: online agents and recent bus events:",
    JSON.stringify(context),
  ].join("\n");
}

function loadHistory(projectRoot, maxTurns = 6) {
  const file = path.join(getUfooPaths(projectRoot).agentDir, "ufoo-agent.history.jsonl");
  try {
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const items = lines.map((l) => JSON.parse(l));
    return items.slice(-maxTurns);
  } catch {
    return [];
  }
}

function appendHistory(projectRoot, item) {
  const dir = getUfooPaths(projectRoot).agentDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "ufoo-agent.history.jsonl");
  fs.appendFileSync(file, `${JSON.stringify(item)}\n`);
}

function buildHistoryPrompt(history) {
  if (!history.length) return "";
  const lines = ["Recent conversation:"];
  for (const h of history) {
    lines.push(`User: ${h.prompt}`);
    if (h.reply) lines.push(`Agent: ${h.reply}`);
  }
  lines.push("");
  return lines.join("\n");
}

function extractNickname(prompt) {
  if (!prompt) return "";
  const patterns = [
    /(?:叫|名为|叫做|取名|昵称)\s*([A-Za-z0-9_-]{1,32})/i,
    /(?:named|name)\s+([A-Za-z0-9_-]{1,32})/i,
  ];
  for (const re of patterns) {
    const match = prompt.match(re);
    if (match && match[1]) return match[1];
  }
  const quoted = prompt.match(/[“"']([^“"'\\]{1,32})[”"']/);
  if (quoted && quoted[1]) return quoted[1];
  return "";
}

function isUcodeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return text === "ucode" || text === "ufoo" || text === "ufoo-code";
}

function stripMarkdownFence(text = "") {
  const raw = String(text || "").trim();
  const match = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (match) return match[1].trim();
  return raw;
}

function clipText(value = "", maxChars = 500) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
}

async function runNativeRouterCall({ projectRoot, prompt, systemPrompt, model: requestedModel, timeoutMs = 120000 }) {
  const runtime = resolveRuntimeConfig({
    workspaceRoot: projectRoot,
    provider: "",
    model: requestedModel,
  });

  const requestModel = String(runtime.model || "").trim();
  if (!requestModel) {
    return { ok: false, error: "ucode model is not configured" };
  }

  const isAnthropic = runtime.transport === "anthropic-messages";
  const url = isAnthropic
    ? resolveAnthropicMessagesUrl(runtime.baseUrl)
    : resolveCompletionUrl(runtime.baseUrl);

  if (!url) {
    return { ok: false, error: "ucode baseUrl is not configured" };
  }

  const headers = { "content-type": "application/json" };
  let body;

  if (isAnthropic) {
    headers["anthropic-version"] = "2023-06-01";
    if (runtime.apiKey) headers["x-api-key"] = runtime.apiKey;
    body = JSON.stringify({
      model: requestModel,
      max_tokens: 4096,
      system: String(systemPrompt || ""),
      messages: [{ role: "user", content: String(prompt || "") }],
      temperature: 0,
    });
  } else {
    if (runtime.apiKey) headers.authorization = `Bearer ${runtime.apiKey}`;
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: String(systemPrompt) });
    messages.push({ role: "user", content: String(prompt || "") });
    body = JSON.stringify({
      model: requestModel,
      messages,
      temperature: 0,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      return { ok: false, error: `provider request failed (${response.status}): ${clipText(errBody)}` };
    }

    const data = await response.json();

    let text = "";
    if (isAnthropic) {
      const content = Array.isArray(data.content) ? data.content : [];
      text = content
        .filter((item) => item && item.type === "text")
        .map((item) => String(item.text || ""))
        .join("");
    } else {
      const choice = data.choices && data.choices[0];
      text = choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content
        : "";
    }

    return { ok: true, output: text.trim() };
  } catch (err) {
    const message = err && err.message ? err.message : "native router call failed";
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function runUfooAgent({ projectRoot, prompt, provider, model }) {
  const state = loadSessionState(projectRoot);
  const bus = loadBusSummary(projectRoot);
  const systemPrompt = buildSystemPrompt(bus);
  const history = loadHistory(projectRoot);
  const historyPrompt = buildHistoryPrompt(history);
  const fullPrompt = historyPrompt ? `${historyPrompt}User: ${prompt}` : prompt;

  let res;

  if (isUcodeProvider(provider)) {
    // Native path: direct HTTP to LLM API, no CLI binary needed
    res = await runNativeRouterCall({
      projectRoot,
      prompt: fullPrompt,
      systemPrompt,
      model,
    });
    if (!res.ok) {
      return { ok: false, error: res.error };
    }
    // Native path returns { ok, output } where output is raw text
    res = { ok: true, output: res.output, sessionId: "" };
  } else {
    // CLI path: spawn codex/claude binary
    res = await runCliAgent({
      provider,
      model,
      prompt: fullPrompt,
      systemPrompt,
      sessionId: state.data?.sessionId,
      disableSession: provider === "claude-cli",
      cwd: projectRoot,
    });

    if (!res.ok) {
      const msg = (res.error || "").toLowerCase();
      if (msg.includes("session id") || msg.includes("session-id") || msg.includes("already in use")) {
        res = await runCliAgent({
          provider,
          model,
          prompt: fullPrompt,
          systemPrompt,
          sessionId: undefined,
          disableSession: provider === "claude-cli",
          cwd: projectRoot,
        });
      }
    }

    if (!res.ok) {
      return { ok: false, error: res.error };
    }
  }

  const rawText = isUcodeProvider(provider)
    ? String(res.output || "").trim()
    : normalizeCliOutput(res.output);
  const text = stripMarkdownFence(rawText);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Best-effort fallback to plain reply if model didn't return JSON.
    // eslint-disable-next-line no-console
    console.warn("[ufoo-agent] Non-JSON output received; using raw text reply.");
    payload = { reply: text, dispatch: [], ops: [] };
  }

  const fallbackNickname = extractNickname(prompt);
  if (fallbackNickname && payload && Array.isArray(payload.ops)) {
    for (const op of payload.ops) {
      if (op && (op.action === "launch" || op.action === "rename") && !op.nickname) {
        op.nickname = fallbackNickname;
        break;
      }
    }
  }

  saveSessionState(projectRoot, {
    provider,
    model,
    sessionId: res.sessionId || "",
    updated_at: new Date().toISOString(),
  });

  appendHistory(projectRoot, { prompt, reply: payload.reply || "" });

  return { ok: true, payload };
}

module.exports = { runUfooAgent };
