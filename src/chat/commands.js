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
  "/init": { desc: "Initialize modules" },
  "/open": { desc: "Open project path in global mode" },
  "/launch": {
    desc: "Launch new agent",
    children: {
      claude: { desc: "Launch Claude agent" },
      codex: { desc: "Launch Codex agent" },
      ucode: { desc: "Launch ucode core agent" },
    },
  },
  "/project": {
    desc: "Project switch operations (spike)",
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
    desc: "Resume agents (optional nickname) or list recoverable targets",
    children: {
      list: { desc: "List recoverable agents (optional target)" },
    },
  },
  "/settings": {
    desc: "Settings operations",
    children: {
      show: {
        desc: "Show settings overview",
        order: 1,
      },
      agent: {
        desc: "Manage main ufoo-agent/router provider/model",
        order: 2,
        children: {
          show: { desc: "Show main agent provider/model", order: 1 },
          set: { desc: "Set provider=<codex|claude> model=<id>", order: 2 },
          clear: { desc: "Clear agent model or reset provider", order: 3 },
          codex: { desc: "Use Codex default model (gpt-5.5)", order: 4 },
          claude: { desc: "Use Claude default model (opus-4.7)", order: 5 },
        },
      },
      router: {
        desc: "Manage gate router mode/provider/model",
        order: 3,
        children: {
          show: { desc: "Show gate router mode/provider/model", order: 1 },
          set: { desc: "Set mode/provider/model", order: 2 },
          clear: { desc: "Clear gate router provider/model or reset mode", order: 3 },
          main: { desc: "Set router mode to main", order: 4 },
          loop: { desc: "Set router mode to loop", order: 5 },
          legacy: { desc: "Set router mode to legacy", order: 6 },
          shadow: { desc: "Set router mode to shadow", order: 7 },
          codex: { desc: "Use Codex gate model (gpt-5.4-mini)", order: 8 },
          claude: { desc: "Use Claude gate model (sonnet-4.7)", order: 9 },
        },
      },
      ucode: {
        desc: "Manage ucode model provider config",
        order: 4,
        children: {
          show: { desc: "Show ucode provider/model/url/key", order: 1 },
          set: { desc: "Set ucode provider/model/url/key", order: 2 },
          clear: { desc: "Clear ucode provider/model/url/key", order: 3 },
        },
      },
    },
  },
  "/skills": {
    desc: "Skills management",
    children: {
      install: { desc: "Install skills (use: all or name)" },
      list: { desc: "List available skills" },
    },
  },
  "/status": { desc: "Status display" },
  "/ufoo": { desc: "ufoo protocol (session marker)" },
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
      return { cmd, ...mapNode(node) };
    });
}

const COMMAND_REGISTRY = buildCommandRegistry(COMMAND_TREE);

function parseCommand(text) {
  if (!text.startsWith("/")) return null;

  // Split by whitespace, respecting quotes
  const parts = text.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  if (parts.length === 0) return null;

  const command = parts[0].slice(1); // Remove leading /
  const args = parts.slice(1).map((arg) => arg.replace(/^"|"$/g, "")); // Remove quotes

  return { command, args };
}

function shouldEchoCommandInChat(text) {
  const parsed = parseCommand(String(text || "").trim());
  if (!parsed) return true;
  if (parsed.command === "group" && parsed.args[0] === "run") return false;
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
  parseCommand,
  shouldEchoCommandInChat,
  parseAtTarget,
};
