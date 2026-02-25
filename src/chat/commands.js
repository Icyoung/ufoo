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
      start: { desc: "Create cron task" },
      list: { desc: "List cron tasks" },
      stop: { desc: "Stop cron task by id or all" },
    },
  },
  "/init": { desc: "Initialize modules" },
  "/launch": {
    desc: "Launch new agent",
    children: {
      claude: { desc: "Launch Claude agent" },
      codex: { desc: "Launch Codex agent" },
      ucode: { desc: "Launch ucode core agent" },
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
      ucode: { desc: "Manage ucode model provider config" },
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

const COMMAND_ORDER = ["/launch", "/bus", "/ctx"];
const COMMAND_ORDER_MAP = new Map(COMMAND_ORDER.map((cmd, idx) => [cmd, idx]));

function sortCommands(a, b) {
  const ai = COMMAND_ORDER_MAP.has(a) ? COMMAND_ORDER_MAP.get(a) : Number.POSITIVE_INFINITY;
  const bi = COMMAND_ORDER_MAP.has(b) ? COMMAND_ORDER_MAP.get(b) : Number.POSITIVE_INFINITY;
  if (ai !== bi) return ai - bi;
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function buildCommandRegistry(tree) {
  return Object.keys(tree)
    .sort(sortCommands)
    .map((cmd) => {
      const node = tree[cmd] || {};
      const entry = { cmd, desc: node.desc || "" };
      if (node.children) {
        entry.subcommands = Object.keys(node.children)
          .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
          .map((sub) => ({
            cmd: sub,
            desc: (node.children[sub] && node.children[sub].desc) || "",
          }));
      }
      return entry;
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
  parseAtTarget,
};
