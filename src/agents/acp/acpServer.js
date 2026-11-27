"use strict";

const { randomUUID } = require("crypto");
const { JsonRpcStdioConnection } = require("./jsonRpcStdio");
const { createInternalCodingThread } = require("../../code/internalThread");

const ACP_PROTOCOL_VERSION = 1;

/**
 * Exposes ufoo (`ucode` or project `main` agent) as a standard ACP Server
 * over JSON-RPC 2.0 stdio so external editors (Zed, JetBrains, Neovim, T3 Code)
 * can plug ufoo in directly.
 */
function createUfooAcpServer(options = {}) {
  const defaultProjectRoot = String(options.projectRoot || process.cwd());
  const agentKind = String(options.agent || "ucode").trim().toLowerCase();
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const conn = new JsonRpcStdioConnection({ input, output });

  const sessions = new Map();

  const defaultThreadFactory = ({ cwd, sessionId, resume = false }) => {
    if (agentKind === "ucode" || options.useNativeThread) {
      return createInternalCodingThread({
        workspaceRoot: cwd || defaultProjectRoot,
        sessionId: sessionId || undefined,
        resume: Boolean(resume),
      });
    }
    // Project main/native fallback uses shared native coding thread with workspace root
    return createInternalCodingThread({
      workspaceRoot: cwd || defaultProjectRoot,
      sessionId: sessionId || undefined,
      resume: Boolean(resume),
    });
  };
  const threadFactory = typeof options.threadFactory === "function"
    ? options.threadFactory
    : defaultThreadFactory;

  conn.onRequest("initialize", async () => ({
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentInfo: {
      name: agentKind === "ucode" ? "ucode" : "ufoo",
      title: agentKind === "ucode" ? "ufoo ucode" : "ufoo Multi-Agent Orchestrator",
      version: require("../../../package.json").version,
    },
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
      },
    },
  }));

  conn.onRequest("session/new", async (params = {}) => {
    const cwd = String(params.cwd || defaultProjectRoot);
    const sessionId = `ufoo-acp-${randomUUID().slice(0, 8)}`;
    const thread = threadFactory({
      cwd,
      sessionId,
      resume: false,
      mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
    });
    sessions.set(sessionId, {
      sessionId,
      cwd,
      thread,
      abortController: null,
    });
    return { sessionId };
  });

  conn.onRequest("session/load", async (params = {}) => {
    const sessionId = String(params.sessionId || "").trim();
    if (!sessionId) throw new Error("sessionId is required");
    if (!sessions.has(sessionId)) {
      const cwd = String(params.cwd || defaultProjectRoot);
      const thread = threadFactory({
        cwd,
        sessionId,
        resume: true,
        mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
      });
      sessions.set(sessionId, {
        sessionId,
        cwd,
        thread,
        abortController: null,
      });
    }
    return {};
  });

  conn.onNotification("session/cancel", (params = {}) => {
    const sessionId = String(params.sessionId || "").trim();
    const entry = sessions.get(sessionId);
    if (entry && entry.abortController) {
      entry.abortController.abort(new Error("cancelled by ACP client"));
    }
  });

  conn.onRequest("session/prompt", async (params = {}) => {
    const sessionId = String(params.sessionId || "").trim();
    const entry = sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Unknown ACP session: ${sessionId}`);
    }
    const promptBlocks = Array.isArray(params.prompt) ? params.prompt : [];
    const inputText = promptBlocks
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block.text === "string") return block.text;
        if (block && block.resource && typeof block.resource.text === "string") return block.resource.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");

    const controller = new AbortController();
    entry.abortController = controller;

    let stopReason = "end_turn";
    try {
      for await (const evt of entry.thread.runStreamed(inputText, { signal: controller.signal })) {
        if (!evt || typeof evt !== "object") continue;
        if (evt.type === "text_delta" && evt.delta) {
          conn.sendNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: String(evt.delta) },
            },
          });
        } else if (evt.type === "thinking_delta" && evt.delta) {
          conn.sendNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: String(evt.delta) },
            },
          });
        } else if (evt.type === "tool_call") {
          conn.sendNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: String(evt.toolCallId || `tool-${Date.now()}`),
              title: String(evt.name || "tool"),
              kind: "other",
              status: "in_progress",
              rawInput: evt.args || {},
            },
          });
        } else if (evt.type === "tool_result") {
          conn.sendNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: String(evt.toolCallId || ""),
              status: evt.is_error ? "failed" : "completed",
              rawOutput: typeof evt.output === "string" ? evt.output : JSON.stringify(evt.output ?? ""),
            },
          });
        } else if (evt.type === "plan" && Array.isArray(evt.entries)) {
          conn.sendNotification("session/update", {
            sessionId,
            update: {
              sessionUpdate: "plan",
              entries: evt.entries,
            },
          });
        }
      }
    } catch (err) {
      if (err?.code === "cancelled" || controller.signal.aborted) {
        stopReason = "cancelled";
      } else {
        throw err;
      }
    } finally {
      entry.abortController = null;
    }

    return { stopReason };
  });

  async function close() {
    conn.close();
    for (const entry of sessions.values()) {
      try {
        await entry.thread?.close?.();
      } catch {
        // ignore
      }
    }
    sessions.clear();
  }

  return {
    conn,
    sessions,
    close,
  };
}

async function runUfooAcpServer(options = {}) {
  // Redirect console.log to stderr so stdout stays strictly JSON-RPC 2.0 frames.
  const originalLog = console.log;
  console.log = (...args) => console.error(...args);
  const server = createUfooAcpServer(options);
  await new Promise((resolve) => {
    server.conn.once("close", resolve);
  });
  await server.close();
  console.log = originalLog;
}

module.exports = {
  createUfooAcpServer,
  runUfooAcpServer,
};
