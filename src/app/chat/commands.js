const { SETTINGS_MODEL_DEFAULTS } = require("../../config");
const { DEFAULT_THINKING_LEVEL } = require("../../agents/providers/thinkingLevels");

const COMMAND_TREE = {
  "/bus": {
    desc: "Event bus operations",
    children: {
      activate: { desc: "Activate agent terminal" },
      list: { desc: "List all agents" },
      rename: { desc: "Rename agent nickname" },
      send: { desc: "Send message to agent" },
      status: { desc: "Bus status" },
    },
  },
  "/ctx": {
    desc: "Context management",
    children: {
      decisions: { desc: "List all decisions" },
      doctor: { desc: "Check context integrity" },
      status: { desc: "Show context status (default)" },
    },
  },
  "/daemon": {
    desc: "Daemon management",
    children: {
      restart: { desc: "Restart daemon" },
      start: { desc: "Start daemon" },
      status: { desc: "Daemon status" },
      stop: { desc: "Stop daemon" },
    },
  },
  "/doctor": { desc: "Health check diagnostics" },
  "/cron": {
    desc: "Cron scheduler operations",
    children: {
      start: { desc: "Create cron task (optional title)" },
      list: { desc: "List cron tasks" },
      stop: { desc: "Stop cron task by id or all" },
    },
  },
  "/provider": {
    desc: "Set ufoo-agent provider",
    children: {
      show: { desc: "Show current agent provider", order: 1 },
      codex: { desc: "Use Codex", order: 2 },
      claude: { desc: "Use Claude", order: 3 },
      agy: { desc: "Use Antigravity (agy)", order: 4 },
      kimi: { desc: "Use Kimi Code", order: 5 },
      custom: { desc: "Configure a custom OpenAI API endpoint", order: 6 },
    },
  },
  "/clear": { desc: "Clear chat log on screen" },
  "/group": {
    desc: "Agent group orchestration",
    children: {
      run: { desc: "Launch a group template", order: 1 },
      diagram: { desc: "Render group diagram (ascii|mermaid)", order: 2 },
      stop: { desc: "Stop a running group" },
      status: { desc: "Show group runtime status" },
      template: { desc: "Template ops (list/show/validate/new)" },
      templates: { desc: "List available templates" },
    },
  },
  "/init": { desc: "Initialize workspace" },
  "/window": {
    desc: "Choose the main, side or multi window layout",
    children: {
      main: { desc: "Show only the main agent", order: 1 },
      side: { desc: "Show the main agent and the most recently activated child, or the first child", order: 2 },
      multi: { desc: "Show the main agent and all internal children", order: 3 },
    },
  },
  "/mcp": {
    desc: "MCP bridge diagnostics",
    children: {
      status: { desc: "Show global MCP bridge status", order: 1 },
      tools: { desc: "List exposed MCP tools", order: 2 },
      help: { desc: "Show MCP setup hints", order: 3 },
    },
  },
  "/open": { desc: "Open project path in global mode", globalOnly: true },
  "/launch": {
    desc: "Launch new agent",
    children: {
      claude: { desc: "Launch Claude agent", order: 1 },
      codex: { desc: "Launch Codex agent", order: 2 },
      ucode: { desc: "Launch ucode core agent", order: 5 },
    },
  },
  "/project": {
    desc: "Project switch operations (spike)",
    globalOnly: true,
    children: {
      current: { desc: "Show current chat project" },
      list: { desc: "List running projects from registry" },
      switch: { desc: "Switch daemon connection to project index/path" },
    },
  },
  "/role": {
    desc: "Assign preset role to an existing agent",
    children: {
      assign: { desc: "Assign a role to an existing agent", order: 1 },
      list: { desc: "List available prompt profiles", order: 2 },
    },
  },
  "/solo": {
    desc: "Solo role agent operations",
    children: {
      run: { desc: "Launch a solo role agent", order: 1 },
      list: { desc: "List available solo roles", order: 2 },
    },
  },
  "/resume": {
    desc: "Resume an internal agent session or a group",
    hasArguments: true,
  },
  "/settings": {
    desc: "Settings operations",
    children: {
      show: {
        desc: "Show settings overview",
        order: 1,
      },
      agent: {
        desc: "Manage ufoo main agent provider/model",
        order: 2,
        children: {
          show: { desc: "Show main agent provider/model", order: 1 },
          set: { desc: "Set provider=<codex|claude> model=<id>", order: 2 },
          clear: { desc: "Clear agent model or reset provider", order: 3 },
          codex: { desc: `Use Codex default (${SETTINGS_MODEL_DEFAULTS.agent.codex} · ${DEFAULT_THINKING_LEVEL})`, order: 4 },
          claude: { desc: `Use Claude default model (${SETTINGS_MODEL_DEFAULTS.agent.claude})`, order: 5 },
          custom: { desc: "Configure custom API URL and key", order: 6 },
          model: { desc: "Select a model for the current provider", hasArguments: true, order: 7 },
          thinking: { desc: "Select thinking intensity", hasArguments: true, order: 8 },
        },
      },
      ucode: {
        desc: "Manage ucode model provider config",
        order: 4,
        children: {
          show: { desc: "Show ucode provider/model/url/key", order: 1 },
          set: { desc: "Set ucode provider/model/url/key", order: 2 },
          models: { desc: "List models from the provider /models route", order: 3 },
          clear: { desc: "Clear ucode provider/model/url/key", order: 4 },
        },
      },
    },
  },
  "/skills": {
    desc: "List ufoo built-in skills and preset workflows",
    children: {
      install: { desc: "Install built-in skills (use: all or name)" },
      list: { desc: "List built-in skills for discovery" },
    },
  },
  "/status": { desc: "Status display" },
  "/task": { desc: "Main agent tasks", children: { list: { desc: "List durable tasks" }, inspect: { desc: "Inspect a child task" }, cancel: { desc: "Cancel a task by run ID" } } },
  "/answer": { desc: "Answer a runtime interaction: /answer <interaction-id> <reply>" },
  "/session": { desc: "Main conversation", children: { show: { desc: "Show conversation ID" }, new: { desc: "Start a conversation with current settings" } } },
  "/ufoo": { desc: "ufoo protocol" },
};

const COMMAND_ORDER = ["/launch", "/group", "/bus", "/ctx"];
const COMMAND_ORDER_MAP = new Map(COMMAND_ORDER.map((cmd, idx) => [cmd, idx]));

function sortCommands(a, b) {
  const ai = COMMAND_ORDER_MAP.has(a) ? COMMAND_ORDER_MAP.get(a) : Number.POSITIVE_INFINITY;
  const bi = COMMAND_ORDER_MAP.has(b) ? COMMAND_ORDER_MAP.get(b) : Number.POSITIVE_INFINITY;
  if (ai !== bi) return ai - bi;
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function buildCommandRegistry(tree) {
  function mapNode(node = {}) {
    const entry = {
      desc: node.desc || "",
      order: Number.isFinite(node.order) ? node.order : undefined,
    };
    if (node.optionalArguments) entry.optionalArguments = true;
    if (node.children) {
      entry.subcommands = Object.keys(node.children)
        .sort((a, b) => {
          const aNode = node.children[a] || {};
          const bNode = node.children[b] || {};
          const aOrder = Number.isFinite(aNode.order) ? aNode.order : Number.POSITIVE_INFINITY;
          const bOrder = Number.isFinite(bNode.order) ? bNode.order : Number.POSITIVE_INFINITY;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return a.localeCompare(b, "en", { sensitivity: "base" });
        })
        .map((sub) => ({
          cmd: sub,
          ...mapNode(node.children[sub]),
        }));
    }
    return entry;
  }

  return Object.keys(tree)
    .sort(sortCommands)
    .map((cmd) => {
      const node = tree[cmd] || {};
      const entry = { cmd, ...mapNode(node) };
      // Stamp priority so buildCompletions keeps launch → group → bus → ctx
      // at the top of the `/` popup instead of falling back to A–Z.
      if (COMMAND_ORDER_MAP.has(cmd)) {
        entry.order = COMMAND_ORDER_MAP.get(cmd);
      }
      return entry;
    });
}

const COMMAND_REGISTRY = buildCommandRegistry(COMMAND_TREE);

function getChatCommandCatalog({ globalMode = false } = {}) {
  if (globalMode) {
    return { commands: COMMAND_REGISTRY, commandTree: COMMAND_TREE };
  }
  const commandTree = Object.fromEntries(
    Object.entries(COMMAND_TREE).filter(([, node]) => !node.globalOnly)
  );
  return { commands: buildCommandRegistry(commandTree), commandTree };
}

function parseCommand(text) {
  if (!text.startsWith("/")) return null;

  // Split by whitespace, respecting quotes
  const parts = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  if (parts.length === 0) return null;

  const command = parts[0].slice(1); // Remove leading /
  const args = parts.slice(1).map((arg) => arg.replace(/^"|"$/g, "")); // Remove quotes

  return { command, args };
}

function parseCommandOptions(args = []) {
  const options = {};
  const positional = [];
  for (const arg of args) {
    const raw = String(arg || "").trim();
    if (!raw) continue;
    if (raw.includes("=")) {
      const [key, value] = raw.split("=", 2);
      options[String(key || "").trim().toLowerCase()] = String(value || "").trim();
    } else {
      positional.push(raw);
    }
  }
  return { options, positional };
}

function normalizeAgentLabel(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "claude" || raw === "uclaude") return "claude";
  if (raw === "codex" || raw === "ucodex") return "codex";
  if (raw === "agy" || raw === "antigravity" || raw === "uagy") return "agy";
  if (raw === "grok" || raw === "ugrok" || raw === "grok-build" || raw === "xai") return "grok";
  if (raw === "kimi" || raw === "kimi-cli" || raw === "kimi-code" || raw === "ukimi") return "kimi";
  if (raw === "ucode") return "ucode";
  return raw || "agent";
}

function describeCommandForChat(text) {
  const parsed = parseCommand(String(text || "").trim());
  if (!parsed) return "";
  const command = String(parsed.command || "").trim().toLowerCase();
  const args = parsed.args || [];
  const sub = String(args[0] || "").trim().toLowerCase();
  const { options, positional } = parseCommandOptions(args);

  if (command === "launch") {
    const agent = normalizeAgentLabel(args[0]);
    const nickname = options.nickname || options.nick || options.name || "";
    const profile = options.profile || options.prompt_profile || "";
    const count = parseInt(options.count || "1", 10);
    const scope = options.scope || options.launch_scope || positional.slice(1).find((item) =>
      /^(window|new-window|separate|inplace|same|current|tab|pane)$/i.test(item)
    ) || "";
    const base = nickname
      ? `Launching a ${agent} named ${nickname}`
      : (Number.isFinite(count) && count > 1 ? `Launching ${count} ${agent} agents` : `Launching a ${agent} agent`);
    return `${base}${profile ? ` with profile ${profile}` : ""}${/^(window|new-window|separate)$/i.test(scope) ? " in a new window" : ""}`;
  }

  if (command === "group") {
    if (sub === "run") return `Launching group ${args[1] || "template"}`;
    if (sub === "status") return `Checking group ${args[1] || "status"}`;
    if (sub === "stop") return `Stopping group ${args[1] || "run"}`;
    if (sub === "diagram") return `Showing group diagram${args[1] ? ` for ${args[1]}` : ""}`;
    if (sub === "template" || sub === "templates") return "Browsing group templates";
    return "Managing agent groups";
  }

  if (command === "bus") {
    if (sub === "send") return `Sending a message to ${args[1] || "an agent"}`;
    if (sub === "rename") return `Renaming ${args[1] || "an agent"}${args[2] ? ` to ${args[2]}` : ""}`;
    if (sub === "activate") return `Activating ${args[1] || "an agent"}`;
    if (sub === "list") return "Listing active agents";
    if (sub === "status") return "Checking bus status";
    return "Using the event bus";
  }

  if (command === "daemon") {
    if (sub === "start") return "Starting the ufoo daemon";
    if (sub === "stop") return "Stopping the ufoo daemon";
    if (sub === "restart") return "Restarting the ufoo daemon";
    if (sub === "status") return "Checking daemon status";
    return "Managing the ufoo daemon";
  }

  if (command === "project") {
    if (sub === "switch") return `Switching to project ${args[1] || ""}`.trim();
    if (sub === "current") return "Showing current project";
    if (sub === "list") return "Listing running projects";
    return "Managing projects";
  }

  if (command === "solo") {
    if (sub === "run") return `Launching solo role ${args[1] || "agent"}`;
    if (sub === "list") return "Listing solo roles";
    return "Managing solo agents";
  }

  if (command === "role") {
    if (sub === "assign") return `Assigning role ${args[2] || ""}${args[1] ? ` to ${args[1]}` : ""}`.trim();
    if (sub === "list") return "Listing roles";
    return "Managing roles";
  }

  if (command === "cron") {
    if (sub === "start") return "Creating a cron task";
    if (sub === "stop") return `Stopping cron task ${args[1] || ""}`.trim();
    if (sub === "list") return "Listing cron tasks";
    return "Managing cron tasks";
  }

  if (command === "provider") {
    if (!sub || sub === "show" || sub === "status") return "Showing agent provider";
    return `Setting agent provider to ${sub}`;
  }

  if (command === "mcp") {
    if (!sub || sub === "status") return "Checking MCP bridge status";
    if (sub === "tools") return "Listing MCP tools";
    if (sub === "help") return "Showing MCP setup help";
    return `Running /mcp ${sub}`;
  }

  if (command === "settings") return !sub || sub === "show" ? "Showing settings" : "Updating settings";
  if (command === "ctx") return `Checking context${sub ? ` ${sub}` : ""}`;
  if (command === "doctor") return "Running ufoo diagnostics";
  if (command === "clear") return "Clearing the chat log";
  if (command === "multi") return "Toggling multi-pane view";
  if (command === "open") return `Opening project ${args[0] || ""}`.trim();
  if (command === "resume") return args[0] ? `Resuming ${args[0]}` : "Choose an agent or group to resume";
  if (command === "init") return "Initializing ufoo workspace";

  return `Running /${command}`;
}

function shouldEchoCommandInChat(text) {
  const parsed = parseCommand(String(text || "").trim());
  if (!parsed) return true;
  return true;
}

function parseAtTarget(text) {
  if (!text.startsWith("@")) return null;
  const trimmed = text.slice(1).trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { target: trimmed, message: "" };
  }
  const target = trimmed.slice(0, spaceIdx).trim();
  const message = trimmed.slice(spaceIdx + 1).trim();
  return { target, message };
}

module.exports = {
  COMMAND_TREE,
  COMMAND_REGISTRY,
  sortCommands,
  buildCommandRegistry,
  getChatCommandCatalog,
  parseCommand,
  describeCommandForChat,
  shouldEchoCommandInChat,
  parseAtTarget,
};
