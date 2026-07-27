"use strict";

/**
 * Multi-window handoff after Rust TUI suspend (exit 75, reason=multi).
 * Reuses createMultiWindowController (same VT/pane code as Ink).
 */

const { createMultiWindowController } = require("../app/chat/multiWindow");
const { resolveAgentEnterRequest, resolveInjectSockPathForAgent } = require("../app/chat/agentEnter");
const { restoreStdinAfterHandoff } = require("./ptyHandoff");

function agentIdsFromMeta(activeAgentMeta) {
  if (activeAgentMeta instanceof Map) {
    return Array.from(activeAgentMeta.keys()).map(String).filter(Boolean);
  }
  if (activeAgentMeta && typeof activeAgentMeta === "object") {
    return Object.keys(activeAgentMeta);
  }
  return [];
}

function labelForAgent(activeAgentMeta, agentId) {
  const meta = activeAgentMeta instanceof Map
    ? activeAgentMeta.get(agentId)
    : (activeAgentMeta && activeAgentMeta[agentId]);
  if (!meta || typeof meta !== "object") return agentId;
  return String(meta.display_nickname || meta.nickname || meta.scoped_nickname || agentId);
}

/**
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function runMultiWindowHandoff({
  projectRoot = process.cwd(),
  activeAgentMeta = new Map(),
  settings = {},
  getChatLogLines = () => [],
  getStatusText = () => "",
  getDashboardLines = () => [],
  onInternalSubmit = null,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  const agents = agentIdsFromMeta(activeAgentMeta);
  if (agents.length === 0) {
    return { ok: false, error: "No active agents for multi-window mode" };
  }

  let terminalFocused = false;
  let done = false;
  let resolveDone = null;
  const finished = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const originalWrite = stdout.write.bind(stdout);
  const controller = createMultiWindowController({
    processStdout: {
      write: originalWrite,
      rows: stdout.rows,
      columns: stdout.columns,
    },
    getRows: () => stdout.rows || 24,
    getCols: () => stdout.columns || 80,
    getInjectSockPath: (agentId) => resolveInjectSockPathForAgent(projectRoot, agentId),
    getActiveAgents: () => agentIdsFromMeta(activeAgentMeta),
    getAgentPaneOptions: (agentId) => {
      const enterRequest = resolveAgentEnterRequest({
        agentId,
        projectRoot,
        activeAgentMeta,
        settings,
      });
      if (!enterRequest || !enterRequest.useBus) return { mode: "socket" };
      let initialLines = [];
      try {
        const { loadInternalAgentLogHistory } = require("../app/chat/internalAgentLogHistory");
        initialLines = loadInternalAgentLogHistory(projectRoot, agentId, {
          maxEvents: 200,
          maxLines: 200,
        });
      } catch {
        initialLines = [];
      }
      return {
        mode: "internal",
        initialLines: [
          `ufoo internal agent · ${labelForAgent(activeAgentMeta, agentId)}`,
          `agent: ${agentId}`,
          "",
          ...initialLines,
        ],
      };
    },
    getChatLogLines,
    getStatusText,
    getPromptPrefix: () => "› ",
    getCurrentDraft: () => "",
    getCursorPos: () => 0,
    getCompletions: () => ({ items: [], index: -1, windowStart: 0, pageSize: 8 }),
    getAgentLabel: (id) => labelForAgent(activeAgentMeta, id),
    getInternalPaneInfo: (id) => {
      const meta = activeAgentMeta instanceof Map
        ? activeAgentMeta.get(id)
        : (activeAgentMeta && activeAgentMeta[id]);
      return {
        status: String((meta && meta.activity_state) || ""),
        detail: String((meta && meta.activity_detail) || ""),
        input: "",
        cursor: 0,
      };
    },
    getDashboardLines,
    getTerminalFocused: () => terminalFocused,
    freezeScreen: (frozen) => {
      if (frozen) stdout.write = () => true;
      else stdout.write = originalWrite;
    },
    restoreTerminal: () => {
      const rows = stdout.rows || 24;
      originalWrite(`\x1b[1;${rows}r`);
      originalWrite("\x1b[2J\x1b[H");
    },
    onInternalSubmit: (agentId, message) => {
      if (typeof onInternalSubmit === "function") {
        onInternalSubmit(agentId, message);
      }
    },
    onExit: () => {
      done = true;
      if (typeof resolveDone === "function") resolveDone();
    },
  });

  if (!controller.enter()) {
    return { ok: false, error: "No active agents for multi-window mode" };
  }

  const wasRaw = typeof stdin.isRaw === "boolean" ? stdin.isRaw : false;
  try {
    if (typeof stdin.setRawMode === "function" && stdin.isTTY) {
      stdin.setRawMode(true);
    }
    if (typeof stdin.resume === "function") stdin.resume();
  } catch {
    // ignore
  }

  const onResize = () => {
    try {
      controller.handleResize();
    } catch {
      // ignore
    }
  };
  if (stdout && typeof stdout.on === "function") {
    stdout.on("resize", onResize);
  }

  const onData = (chunk) => {
    if (done) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""), "utf8");
    if (buf.length === 0) return;

    // Ctrl+C → exit multi
    if (buf.includes(0x03)) {
      controller.exit();
      return;
    }
    // Ctrl+Q → exit multi
    if (buf.includes(0x11)) {
      controller.handleKey({ name: "q", ctrl: true, sequence: "" });
      terminalFocused = false;
      return;
    }
    // Ctrl+W → cycle focus (chat chrome ↔ agent panes)
    if (buf.includes(0x17)) {
      const ids = controller.getAgentIds();
      if (ids.length === 0) return;
      if (!terminalFocused) {
        controller.focusAgent(ids[0]);
        terminalFocused = true;
      } else {
        const current = controller.getFocused();
        const idx = current ? ids.indexOf(current) : -1;
        if (idx >= 0 && idx < ids.length - 1) {
          controller.focusAgent(ids[idx + 1]);
        } else {
          terminalFocused = false;
          controller.focusAgent(ids[0]);
        }
      }
      controller.renderAll();
      return;
    }

    if (terminalFocused) {
      controller.sendInput(buf.toString("utf8"));
    }
  };

  stdin.on("data", onData);

  try {
    await finished;
    return { ok: true };
  } finally {
    stdin.removeListener("data", onData);
    if (stdout && typeof stdout.off === "function") {
      stdout.off("resize", onResize);
    } else if (stdout && typeof stdout.removeListener === "function") {
      stdout.removeListener("resize", onResize);
    }
    try {
      if (controller.isActive()) controller.exit();
    } catch {
      // ignore
    }
    try {
      if (typeof stdin.setRawMode === "function" && stdin.isTTY) {
        stdin.setRawMode(wasRaw);
      }
    } catch {
      // ignore
    }
    restoreStdinAfterHandoff(stdin);
  }
}

module.exports = {
  runMultiWindowHandoff,
};
