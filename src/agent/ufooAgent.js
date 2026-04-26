const fs = require("fs");
const path = require("path");
const { runCliAgent } = require("./cliRunner");
const { normalizeCliOutput } = require("./normalizeOutput");
const { buildStatus } = require("../daemon/status");
const { getUfooPaths } = require("../ufoo/paths");
const { normalizeGateRouterResult } = require("../controller/gateRouter");
const { normalizeProvider, sendUpstreamPrompt } = require("./upstreamTransport");
const { normalizeAgentTypeAlias } = require("../bus/utils");
const { buildCachedMemoryPrefix } = require("../memory");
const { listProjectRuntimes, isGlobalControllerProjectRoot } = require("../projects");
const { assignMissingLaunchNicknames } = require("../controller/launchRouting");
const {
  CONTROLLER_MODES,
  resolveControllerMode,
} = require("../controller/flags");

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

function toReportAgentSnapshot(value = {}) {
  const last = value && typeof value.last === "object" ? value.last : null;
  return {
    agent_id: String(value && value.agent_id ? value.agent_id : ""),
    pending_count: Number(value && value.pending_count ? value.pending_count : 0) || 0,
    updated_at: String(value && value.updated_at ? value.updated_at : ""),
    last: last
      ? {
        phase: String(last.phase || ""),
        task_id: String(last.task_id || ""),
        ok: last.ok !== false,
      }
      : null,
  };
}

function isBusyActivityState(value = "") {
  const state = String(value || "").trim().toLowerCase();
  return state === "working" || state === "starting" || state === "running"
    || state === "waiting_input" || state === "blocked";
}

function clipPromptText(value = "", maxChars = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
}

function resolveHistoryAgentId(rawTarget, activeIdSet, nicknames) {
  const target = String(rawTarget || "").trim();
  if (!target) return "";
  if (target === "*" || target === "broadcast") return "";
  if (activeIdSet.has(target)) return target;
  if (nicknames[target]) return nicknames[target];

  const targetAlias = normalizeAgentTypeAlias(target);
  if (!targetAlias) return "";

  const matches = [];
  for (const id of activeIdSet) {
    const prefix = String(id).split(":")[0] || "";
    const alias = normalizeAgentTypeAlias(prefix);
    if (alias === targetAlias) matches.push(id);
  }
  return matches.length === 1 ? matches[0] : "";
}

function buildAgentPromptHistory(projectRoot, agents = [], nicknames = {}, options = {}) {
  const perAgentLimit = Number.isFinite(options.perAgentLimit) && options.perAgentLimit > 0
    ? Math.floor(options.perAgentLimit)
    : 6;
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0
    ? Math.floor(options.maxFiles)
    : 3;
  const eventsDir = getUfooPaths(projectRoot).busEventsDir;
  const activeIds = new Set((Array.isArray(agents) ? agents : []).map((item) => String(item.id || "")).filter(Boolean));
  if (activeIds.size === 0) {
    return { per_agent: [], scanned_files: 0, matched_events: 0 };
  }

  const entries = new Map();
  for (const item of agents) {
    if (!item || !item.id) continue;
    entries.set(item.id, {
      agent_id: String(item.id),
      nickname: String(item.nickname || ""),
      samples: [],
      sample_count: 0,
      total_count: 0,
      first_ts: "",
      last_ts: "",
    });
  }

  let files = [];
  try {
    files = fs
      .readdirSync(eventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .slice(-maxFiles)
      .reverse();
  } catch {
    return { per_agent: [], scanned_files: 0, matched_events: 0 };
  }

  let matchedEvents = 0;
  for (const file of files) {
    let lines = [];
    try {
      const raw = fs.readFileSync(path.join(eventsDir, file), "utf8");
      lines = raw.split(/\r?\n/).filter(Boolean).reverse();
    } catch {
      continue;
    }

    for (const line of lines) {
      let evt = null;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (!evt || evt.event !== "message") continue;
      const targetAgentId = resolveHistoryAgentId(evt.target, activeIds, nicknames);
      if (!targetAgentId) continue;
      const prompt = evt.data && typeof evt.data.message === "string"
        ? clipPromptText(evt.data.message)
        : "";
      if (!prompt) continue;

      const row = entries.get(targetAgentId);
      if (!row) continue;
      matchedEvents += 1;
      row.total_count += 1;
      const ts = String(evt.timestamp || evt.ts || "");
      if (!row.last_ts) row.last_ts = ts;
      row.first_ts = ts || row.first_ts;
      if (row.samples.length < perAgentLimit) {
        row.samples.push({
          ts,
          publisher: String(evt.publisher || ""),
          prompt,
        });
        row.sample_count = row.samples.length;
      }
    }
  }

  const perAgent = Array.from(entries.values())
    .filter((row) => row.total_count > 0)
    .sort((a, b) => {
      const left = String(a.last_ts || "");
      const right = String(b.last_ts || "");
      return right.localeCompare(left);
    });

  return {
    per_agent: perAgent,
    scanned_files: files.length,
    matched_events: matchedEvents,
  };
}

function loadBusSummary(projectRoot, maxLines = 20) {
  // Use daemon's buildStatus as the single source of truth.
  let agents = [];
  let nicknames = {};
  let reports = { pending_total: 0, agents: [] };
  let promptHistory = { per_agent: [], scanned_files: 0, matched_events: 0 };
  let summary = {
    active_count: 0,
    busy_count: 0,
    ready_count: 0,
    pending_total: 0,
  };
  try {
    const status = buildStatus(projectRoot);
    const activeMeta = Array.isArray(status && status.active_meta) ? status.active_meta : [];
    agents = activeMeta.map((item) => {
      const nickname = item.nickname || "";
      if (nickname) {
        nicknames[nickname] = item.id;
      }
      return {
        id: item.id,
        nickname,
        status: "active",
        online: true,
        launch_mode: String(item.launch_mode || ""),
        activity_state: String(item.activity_state || ""),
        activity_since: String(item.activity_since || ""),
      };
    });

    const reportState = status && status.reports && typeof status.reports === "object"
      ? status.reports
      : {};
    const reportAgents = Array.isArray(reportState.agents)
      ? reportState.agents.slice(0, 50).map((item) => toReportAgentSnapshot(item))
      : [];
    reports = {
      pending_total: Number(reportState.pending_total || 0) || 0,
      agents: reportAgents,
    };

    const busyCount = agents.filter((item) => isBusyActivityState(item.activity_state)).length;
    summary = {
      active_count: agents.length,
      busy_count: busyCount,
      ready_count: Math.max(agents.length - busyCount, 0),
      pending_total: reports.pending_total,
    };
    promptHistory = buildAgentPromptHistory(projectRoot, agents, nicknames);
  } catch {
    agents = [];
    nicknames = {};
    reports = { pending_total: 0, agents: [] };
    promptHistory = { per_agent: [], scanned_files: 0, matched_events: 0 };
    summary = {
      active_count: 0,
      busy_count: 0,
      ready_count: 0,
      pending_total: 0,
    };
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

  return { agents, nicknames, reports, agent_prompt_history: promptHistory, summary, recent };
}

function slicePromptHistoryForProject(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const perAgent = Array.isArray(input.per_agent) ? input.per_agent.slice(0, 3) : [];
  return {
    scanned_files: Number(input.scanned_files || 0) || 0,
    matched_events: Number(input.matched_events || 0) || 0,
    per_agent: perAgent.map((row) => ({
      agent_id: String(row && row.agent_id ? row.agent_id : ""),
      nickname: String(row && row.nickname ? row.nickname : ""),
      total_count: Number(row && row.total_count ? row.total_count : 0) || 0,
      sample_count: Number(row && row.sample_count ? row.sample_count : 0) || 0,
      last_ts: String(row && row.last_ts ? row.last_ts : ""),
      samples: Array.isArray(row && row.samples)
        ? row.samples.slice(0, 2).map((sample) => ({
          ts: String(sample && sample.ts ? sample.ts : ""),
          publisher: String(sample && sample.publisher ? sample.publisher : ""),
          prompt: String(sample && sample.prompt ? sample.prompt : ""),
        }))
        : [],
    })),
  };
}

function buildGlobalProjectRouterContext(projectRoot, options = {}) {
  const maxProjects = Number.isFinite(options.maxProjects) && options.maxProjects > 0
    ? Math.floor(options.maxProjects)
    : 12;

  let rows = [];
  try {
    rows = listProjectRuntimes({ validate: true, cleanupTmp: true });
  } catch {
    rows = [];
  }

  rows = rows
    .filter((row) => {
      const status = String((row && row.status) || "").trim().toLowerCase();
      if (status === "stopped") return false;
      return !isGlobalControllerProjectRoot(row && row.project_root ? row.project_root : "");
    })
    .slice(0, maxProjects);

  let activeAgentTotal = 0;
  let busyAgentTotal = 0;
  let unreadTotal = 0;
  let decisionsOpenTotal = 0;

  const projects = rows.map((row) => {
    const targetRoot = String(row && row.project_root ? row.project_root : "");
    const fallbackName = String(row && row.project_name ? row.project_name : targetRoot);
    let topDirs = [];
    try {
      const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
      topDirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => e.name)
        .slice(0, 20);
    } catch {
      // ignore unreadable directories
    }
    try {
      const status = buildStatus(targetRoot);
      const activeMeta = Array.isArray(status && status.active_meta) ? status.active_meta : [];
      const agents = activeMeta.map((item) => ({
        id: String(item && item.id ? item.id : ""),
        nickname: String(item && item.nickname ? item.nickname : ""),
        display: String(item && item.display ? item.display : ""),
        launch_mode: String(item && item.launch_mode ? item.launch_mode : ""),
        activity_state: String(item && item.activity_state ? item.activity_state : ""),
        activity_since: String(item && item.activity_since ? item.activity_since : ""),
      }));
      const nicknames = {};
      agents.forEach((item) => {
        if (item.nickname) nicknames[item.nickname] = item.id;
      });
      const promptHistory = buildAgentPromptHistory(targetRoot, agents, nicknames, {
        perAgentLimit: 2,
        maxFiles: 2,
      });
      const busyCount = agents.filter((item) => isBusyActivityState(item.activity_state)).length;
      activeAgentTotal += agents.length;
      busyAgentTotal += busyCount;
      const unread = Number(status && status.unread && status.unread.total ? status.unread.total : 0) || 0;
      const decisionsOpen = Number(status && status.decisions && status.decisions.open ? status.decisions.open : 0) || 0;
      unreadTotal += unread;
      decisionsOpenTotal += decisionsOpen;
      return {
        project_root: targetRoot,
        project_name: fallbackName,
        top_dirs: topDirs,
        status: String(row && row.status ? row.status : "unknown"),
        last_seen: String(row && row.last_seen ? row.last_seen : ""),
        active_count: agents.length,
        busy_count: busyCount,
        ready_count: Math.max(agents.length - busyCount, 0),
        unread_total: unread,
        decisions_open: decisionsOpen,
        reports_pending_total: Number(status && status.reports && status.reports.pending_total ? status.reports.pending_total : 0) || 0,
        groups_active: Number(status && status.groups && status.groups.active ? status.groups.active : 0) || 0,
        agents: agents.slice(0, 6),
        agent_prompt_history: slicePromptHistoryForProject(promptHistory),
      };
    } catch {
      return {
        project_root: targetRoot,
        project_name: fallbackName,
        top_dirs: topDirs,
        status: String(row && row.status ? row.status : "unknown"),
        last_seen: String(row && row.last_seen ? row.last_seen : ""),
        active_count: 0,
        busy_count: 0,
        ready_count: 0,
        unread_total: 0,
        decisions_open: 0,
        reports_pending_total: 0,
        groups_active: 0,
        agents: [],
        agent_prompt_history: { scanned_files: 0, matched_events: 0, per_agent: [] },
      };
    }
  });

  const runningCount = projects.filter((item) => item.status === "running").length;
  const staleCount = projects.filter((item) => item.status === "stale").length;

  return {
    mode: "global-router",
    controller_project_root: projectRoot,
    summary: {
      project_count: projects.length,
      running_count: runningCount,
      stale_count: staleCount,
      active_agent_total: activeAgentTotal,
      busy_agent_total: busyAgentTotal,
      unread_total: unreadTotal,
      decisions_open_total: decisionsOpenTotal,
    },
    projects,
  };
}

function buildSystemPrompt(context, options = {}) {
  const mode = String(options.routingMode || (context && context.mode) || "").trim().toLowerCase();
  const loopRuntime = options.loopRuntime && options.loopRuntime.enabled ? options.loopRuntime : null;
  const controllerMode = String(options.controllerMode || CONTROLLER_MODES.LEGACY);
  if (mode === "global-router") {
    const schemaLines = [
      "{",
      '  "reply": "string",',
    ];
    schemaLines.push('  "project_route": {"project_root":"absolute-path","project_name":"string","prompt":"string","reason":"string"},');
    schemaLines.push('  "dispatch": [],');
    schemaLines.push('  "ops": []');
    schemaLines.push("}");
    return [
      "You are ufoo-agent, the global project router for `ufoo chat -g`.",
      "You run inside the home-scoped controller runtime and must choose the right project before any project-local routing happens.",
      "Return ONLY valid JSON. No extra text.",
      "Schema:",
      ...schemaLines,
      "Rules:",
      "- Use project_route when the request should be handed to one specific registered project.",
      "- project_route.prompt should usually preserve the user request, optionally rewritten only to clarify project context for the next router.",
      "- Each project entry has top_dirs: the immediate subdirectories of project_root. Use these to match sub-project or component names mentioned by the user (e.g. if user says 'voyager' and a project has 'voyager' in top_dirs, route there).",
      "- Keep dispatch empty in global-router mode. Do NOT send directly to coding agents from the global controller.",
      "- Keep ops empty in global-router mode. Do NOT launch/rename/close/cron project-local agents from the global controller.",
      "- The target project's ufoo-agent will do the second-hop routing to a concrete agent.",
      "- If the user asks for a global comparison, registry overview, or other controller-level answer, reply directly and omit project_route.",
      "- If no registered project is a clear match, reply with a concise clarification request or tell the user to use /open <path> first.",
      `- Controller mode=${controllerMode}. Do not emit assistant_call or ops.assistant_call; the legacy helper path has been removed.`,
      "- Prefer continuity: if a project's recent prompt history clearly matches the current request, route there.",
      "",
      "Context: registered projects and project activity summaries:",
      JSON.stringify(context),
    ].join("\n");
  }

  const hasAgents = context.agents && context.agents.length > 0;
  const agentGuidance = hasAgents
    ? ""
    : "\n- IMPORTANT: No coding agents are currently online.\n- Use ops.launch only when a persistent coding-agent session is necessary; otherwise reply with a clarification or route later.";

  if (loopRuntime) {
    return [
      "You are ufoo-agent, a headless routing controller running in limited loop mode.",
      "Return ONLY valid JSON. No extra text.",
      "Loop schema:",
      "{",
      '  "reply": "string",',
      '  "done": true,',
      '  "dispatch": [{"target":"broadcast|<agent-id>|<nickname>","message":"string","injection_mode":"immediate|queued (optional)","source":"optional"}],',
      '  "ops": [{"action":"launch|close|rename|role|cron","agent":"codex|claude|ucode","count":1,"agent_id":"id","nickname":"optional"}],',
      '  "tool_call": {"id":"optional","name":"dispatch_message|ack_bus|launch_agent","arguments":{}}',
      "}",
      "Loop rules:",
      "- Use tool_call only when the controller must execute a control-plane action before deciding the final answer.",
      "- When returning tool_call, set done=false and keep dispatch/ops empty for that round.",
      "- Use dispatch_message for direct bus delivery, ack_bus for controller queue acknowledgement, and launch_agent for bounded worker launches.",
      "- When you have enough information, omit tool_call and return the final reply/dispatch/ops with done=true.",
      "- When launching a new coding agent for a user task, include a short task-specific nickname and include a dispatch to that launched nickname with the task.",
      "- Do not emit launch-only ops for delegated work; a launched worker must receive a task in dispatch.",
      "- Do not emit assistant_call or ops.assistant_call; that legacy helper path has been removed.",
      `- Round budget: maxRounds=${loopRuntime.maxRounds || ""}, remainingToolCalls=${loopRuntime.remainingToolCalls || 0}.`,
      agentGuidance,
      "",
      "Context: online agents and recent bus events:",
      JSON.stringify(context),
    ].join("\n");
  }

  const baseHeader = [
    "You are ufoo-agent, a headless routing controller.",
    `Controller mode=${controllerMode}. The legacy assistant_call / helper-agent path has been removed; route via dispatch/ops or reply directly.`,
  ];
  const schemaLines = [
    "{",
    '  "reply": "string",',
  ];
  schemaLines.push('  "dispatch": [{"target":"broadcast|<agent-id>|<nickname>","message":"string","injection_mode":"immediate|queued (optional)","source":"optional"}],');
  schemaLines.push('  "ops": [{"action":"launch|close|rename|role|cron","agent":"codex|claude|ucode","count":1,"agent_id":"id","nickname":"optional","prompt_profile":"profile-id (for role)","operation":"start|list|stop","every":"30m","interval_ms":1800000,"at":"YYYY-MM-DD HH:mm","once_at_ms":1700000000000,"target":"agent-id|nickname|csv","targets":["agent-id"],"title":"optional short title","prompt":"message","id":"task-id|all"}],');
  schemaLines.push('  "disambiguate": {"prompt":"string","candidates":[{"agent_id":"id","reason":"string"}]}');
  if (controllerMode === CONTROLLER_MODES.LOOP) {
    schemaLines.push('  "upgrade_to_loop_router": true');
  }
  schemaLines.push("}");

  return [
    ...baseHeader,
    "Return ONLY valid JSON. No extra text.",
    "Schema:",
    ...schemaLines,
    "Rules:",
    "- target must be 'broadcast', concrete agent-id, or a known nickname",
    "- If multiple possible agents, use disambiguate with candidates and no dispatch.",
    "- If user specifies a nickname for a new agent, include ops.launch with nickname so daemon can rename.",
    "- If user requests rename, use ops.rename with agent_id and nickname (do NOT launch).",
    "- For scheduled follow-up (cron), use ops.cron with operation=start and include target(s)+prompt, plus optional title; use every/interval_ms for recurring or at/once_at_ms for one-time.",
    "- To check scheduled tasks, use ops.cron with operation=list.",
    "- To stop scheduled tasks, use ops.cron with operation=stop and id (or id=all).",
    "- To assign a preset role to an existing agent, use ops.role with target (agent-id or nickname) and prompt_profile (profile id or alias). Available profiles: discovery-facilitator, scope-challenger, system-architect, implementation-lead, frontend-refiner, design-critic, review-critic, qa-driver, debug-investigator, release-coordinator, task-breakdown, research-scan, rapid-prototype.",
    "- Do not emit assistant_call or ops.assistant_call; that schema has been removed and the daemon will ignore it if emitted.",
    "- For short-lived exploration, prefer a dispatch to an online agent or reply with a clarification.",
    "- Primary routing signal is semantic continuity from agent_prompt_history; prefer the agent that already handled similar prompts.",
    "- Launch a new coding agent when the request is a new topic without clear ownership in existing histories.",
    "- When launching a new coding agent for a user task, include a short task-specific nickname and include a dispatch to that launched nickname with the task.",
    "- Do not emit launch-only ops for delegated work; a launched worker must receive a task in dispatch.",
    "- dispatch.injection_mode defaults to immediate when omitted.",
    "- Use queued only when routing a chat-dialog request that is clearly a new unrelated task for an agent whose recent prompt history shows a different ongoing thread.",
    "- If the new request strongly continues the target agent's recent prompt history, keep injection_mode immediate even when that agent is busy.",
    "- Manual @agent sends in ufoo chat are handled outside this router and remain immediate; do not model them here.",
    ...(controllerMode === CONTROLLER_MODES.LOOP
      ? [
        "- When single-shot routing is insufficient and the controller should continue with tool-assisted exploration, set upgrade_to_loop_router=true.",
        "- If upgrade_to_loop_router=true, keep dispatch/ops empty for this response.",
      ]
      : []),
    "- If no action needed, return reply with empty dispatch/ops.",
    agentGuidance,
    "",
    "Context: online agents and recent bus events:",
    JSON.stringify(context),
  ].join("\n");
}

function buildMemoryPrefixResult(projectRoot, limit = 50) {
  try {
    return buildCachedMemoryPrefix(projectRoot, { limit });
  } catch {
    return { prefix: "", estimated_tokens: 0, cache_hit: false, cache_semistatic_hit: 0, cache_semistatic_miss: 0 };
  }
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

function buildRouteAgentSystemPrompt(context, options = {}) {
  return [
    "You are ufoo-agent gate_router, the front-door router for pure delegation requests.",
    "Return ONLY valid JSON. No markdown or extra text.",
    "Schema:",
    "{",
    '  "decision": "direct_dispatch|upgrade_to_main_router",',
    '  "target": "broadcast|<agent-id>|<nickname>|unknown",',
    '  "message": "string",',
    '  "confidence": 0.0,',
    '  "reason": "string",',
    '  "injection_mode": "immediate|queued"',
    "}",
    "Rules:",
    "- Every request reaches you first. Decide whether to direct_dispatch immediately or upgrade.",
    "- Use decision=direct_dispatch only when a single target is clear and no richer orchestration is needed.",
    "- If the request needs repo work, richer controller context, or the best target is unclear, return decision=upgrade_to_main_router.",
    "- Do not decide loop_router here. Main_router will decide whether a later upgrade to loop_router is necessary.",
    "- Use only agent IDs or nicknames that appear in context.",
    "- Preserve the user request in message unless a small clarification helps the chosen target.",
    "- Prefer continuity from agent_prompt_history when one agent already owns the thread.",
    "- Use queued only when the user is clearly starting a new unrelated thread for a busy agent.",
    "",
    "Context: online agents and recent bus events:",
    JSON.stringify(context),
  ].join("\n");
}

function shouldUseDirectProvider(value = "") {
  const provider = normalizeProvider(value);
  return provider === "ucode" || provider === "codex" || provider === "claude";
}

function stripMarkdownFence(text = "") {
  const raw = String(text || "").trim();
  const match = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (match) return match[1].trim();
  return raw;
}

async function runNativeRouterCall({
  projectRoot,
  prompt,
  systemPrompt,
  provider: requestedProvider,
  model: requestedModel,
  timeoutMs = 120000,
}) {
  return sendUpstreamPrompt({
    projectRoot,
    prompt,
    systemPrompt,
    provider: requestedProvider,
    model: requestedModel,
    timeoutMs,
  });
}

async function runUfooAgent({
  projectRoot,
  prompt,
  provider,
  model,
  routingMode = "",
  routingContext = null,
  loopRuntime = null,
  controllerMode = null,
}) {
  const state = loadSessionState(projectRoot);
  const mode = String(routingMode || (routingContext && routingContext.mode) || "").trim().toLowerCase();
  const resolvedControllerMode = String(
    controllerMode
      || resolveControllerMode({ projectRoot })
      || CONTROLLER_MODES.LEGACY,
  );
  const bus = routingContext || (mode === "global-router"
    ? buildGlobalProjectRouterContext(projectRoot)
    : loadBusSummary(projectRoot));
  let systemPrompt = buildSystemPrompt(bus, {
    routingMode: mode,
    loopRuntime,
    controllerMode: resolvedControllerMode,
  });
  const memoryPrefixResult = buildMemoryPrefixResult(projectRoot);
  const memoryPrefix = String(memoryPrefixResult.prefix || "").trim();
  if (memoryPrefix) {
    systemPrompt = `${systemPrompt}\n\n${memoryPrefix}`;
  }
  const history = loadHistory(projectRoot);
  const historyPrompt = buildHistoryPrompt(history);
  const fullPrompt = historyPrompt ? `${historyPrompt}User: ${prompt}` : prompt;

  let res;

  const useDirectProvider = shouldUseDirectProvider(provider);
  let usedDirectProvider = false;

  if (useDirectProvider) {
    res = await runNativeRouterCall({
      projectRoot,
      prompt: fullPrompt,
      systemPrompt,
      provider,
      model,
    });
    if (!res.ok) {
      return { ok: false, error: res.error };
    } else {
      usedDirectProvider = true;
      res = { ok: true, output: res.output, sessionId: "", provider: res.provider, model: res.model };
    }
  }

  if (!useDirectProvider) {
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

  const rawText = usedDirectProvider
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

  payload = assignMissingLaunchNicknames(payload, { prompt, context: bus });

  saveSessionState(projectRoot, {
    provider,
    model,
    sessionId: res.sessionId || "",
    updated_at: new Date().toISOString(),
  });

  appendHistory(projectRoot, { prompt, reply: payload.reply || "" });

  return {
    ok: true,
    payload,
    meta: {
      memory_prefix_tokens: memoryPrefixResult.estimated_tokens || 0,
      cache_semistatic_hit: memoryPrefixResult.cache_semistatic_hit || 0,
      cache_semistatic_miss: memoryPrefixResult.cache_semistatic_miss || 0,
      memory_prefix_truncated: memoryPrefixResult.truncated === true,
      memory_prefix_entries: memoryPrefixResult.entry_count || 0,
      memory_prefix_emitted: memoryPrefixResult.emitted_count || 0,
    },
  };
}

async function runUfooRouteAgent({
  projectRoot,
  prompt,
  provider = "ucode",
  model = "",
  timeoutMs = 5000,
}) {
  const bus = loadBusSummary(projectRoot);
  const systemPrompt = buildRouteAgentSystemPrompt(bus);
  const history = loadHistory(projectRoot);
  const historyPrompt = buildHistoryPrompt(history);
  const fullPrompt = historyPrompt ? `${historyPrompt}User: ${prompt}` : prompt;

  const res = await runNativeRouterCall({
    projectRoot,
    prompt: fullPrompt,
    systemPrompt,
    provider,
    model,
    timeoutMs,
  });

  if (!res.ok) {
    return { ok: false, error: res.error || "gate_router failed" };
  }

  const text = stripMarkdownFence(String(res.output || "").trim());
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: "gate_router returned non-JSON output" };
  }

  return {
    ok: true,
    route: normalizeGateRouterResult(payload, prompt),
    meta: {
      provider: String(res.provider || ""),
      model: String(res.model || ""),
    },
  };
}

module.exports = { runUfooAgent, runUfooRouteAgent };
