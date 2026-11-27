"use strict";

const { PassThrough } = require("stream");
const { JsonRpcStdioConnection } = require("../../../src/agents/acp/jsonRpcStdio");
const { createUfooAcpServer } = require("../../../src/agents/acp/acpServer");
const { createAcpThreadProvider } = require("../../../src/agents/providers/acpThreadProvider");
const { translateAcpSessionUpdate } = require("../../../src/agents/providers/acpEventTranslator");
const {
  listConfiguredAcpAgents,
  detectInstalledAcpAgents,
  resolveAcpAgentSpec,
} = require("../../../src/agents/providers/acpRegistry");
const {
  normalizeInternalAgentType,
  isAcpAgentType,
  extractAcpAgentId,
} = require("../../../src/runtime/contracts/agentMode");

function createPairedStreams() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  return {
    clientInput: serverToClient,
    clientOutput: clientToServer,
    serverInput: clientToServer,
    serverOutput: serverToClient,
  };
}

describe("ACP Client, Server, Registry, and AgentMode", () => {
  test("agentMode recognizes and normalizes acp:* types", () => {
    expect(isAcpAgentType("acp:gemini")).toBe(true);
    expect(isAcpAgentType("acp-opencode")).toBe(true);
    expect(isAcpAgentType("codex")).toBe(false);
    expect(normalizeInternalAgentType("acp:gemini")).toBe("acp-gemini");
    expect(normalizeInternalAgentType("acp-kimi")).toBe("acp-kimi");
    expect(extractAcpAgentId("acp:gemini")).toBe("gemini");
    expect(extractAcpAgentId("acp-goose")).toBe("goose");
  });

  test("acpRegistry merges builtin presets and custom config agents", () => {
    const config = {
      acpAgents: [
        { id: "myagent", label: "My Custom ACP", command: "/usr/local/bin/myagent", args: ["--acp"] },
      ],
    };
    const all = listConfiguredAcpAgents(process.cwd(), { config });
    expect(all.some((a) => a.id === "gemini" && a.agentType === "acp:gemini")).toBe(true);
    expect(all.some((a) => a.id === "myagent" && a.source === "custom")).toBe(true);

    const detected = detectInstalledAcpAgents(process.cwd(), {
      config,
      isExecutable: (cmd) => cmd === "gemini" || cmd === "/usr/local/bin/myagent",
    });
    expect(detected.find((a) => a.id === "gemini").available).toBe(true);
    expect(detected.find((a) => a.id === "opencode").available).toBe(false);
    expect(detected.find((a) => a.id === "myagent").available).toBe(true);
    expect(resolveAcpAgentSpec("acp:myagent", process.cwd(), { config }).command).toBe("/usr/local/bin/myagent");
  });

  test("acpEventTranslator normalizes ACP session/update notifications", () => {
    expect(translateAcpSessionUpdate({
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
    })).toEqual([{ type: "text_delta", delta: "Hello " }]);

    expect(translateAcpSessionUpdate({
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } },
    })).toEqual([{ type: "thinking_delta", delta: "Thinking..." }]);

    expect(translateAcpSessionUpdate({
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", rawInput: { path: "a.js" } },
    })).toEqual([{ type: "tool_call", toolCallId: "t1", name: "read_file", args: { path: "a.js" } }]);

    expect(translateAcpSessionUpdate({
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "ok" },
    })).toEqual([{ type: "tool_result", toolCallId: "t1", output: "ok", is_error: false }]);
  });

  test("end-to-end loopback: AcpThreadProvider <-> UfooAcpServer with streaming and MCP servers", async () => {
    const streams = createPairedStreams();
    let capturedMcpServers = null;

    const server = createUfooAcpServer({
      projectRoot: process.cwd(),
      agent: "ucode",
      input: streams.serverInput,
      output: streams.serverOutput,
      threadFactory: ({ mcpServers }) => {
        capturedMcpServers = mcpServers;
        return {
          async *runStreamed(input) {
            yield { type: "thinking_delta", delta: "plan..." };
            yield { type: "tool_call", toolCallId: "tc-1", name: "bash", args: { cmd: "ls" } };
            yield { type: "tool_result", toolCallId: "tc-1", output: "README.md", is_error: false };
            yield { type: "text_delta", delta: `Echo: ${input}` };
          },
          async close() {},
        };
      },
    });

    const injectedMcp = [{ name: "ufoo", type: "http", url: "http://127.0.0.1:47631/mcp", headers: [] }];
    const provider = createAcpThreadProvider({
      agentId: "gemini",
      cwd: process.cwd(),
      mcpServers: injectedMcp,
      connectionFactory: () => new JsonRpcStdioConnection({
        input: streams.clientInput,
        output: streams.clientOutput,
      }),
    });

    const thread = provider.startThread();
    const collected = [];
    for await (const evt of thread.runStreamed("fix bug")) {
      collected.push(evt);
    }

    expect(capturedMcpServers).toEqual(injectedMcp);
    expect(thread.id).toMatch(/^ufoo-acp-/);
    expect(collected.map((e) => e.type)).toEqual([
      "thread_started",
      "turn_started",
      "thinking_delta",
      "tool_call",
      "tool_result",
      "text_delta",
      "turn_completed",
    ]);
    expect(collected[5].delta).toBe("Echo: fix bug");
    expect(collected[6].finalText).toBe("Echo: fix bug");

    await thread.close();
    await server.close();
  });

  test("AcpThreadProvider handles session/request_permission according to permissionMode", async () => {
    const streams = createPairedStreams();
    const serverConn = new JsonRpcStdioConnection({
      input: streams.serverInput,
      output: streams.serverOutput,
    });

    serverConn.onRequest("initialize", async () => ({ protocolVersion: 1 }));
    serverConn.onRequest("session/new", async () => ({ sessionId: "s-perm" }));
    serverConn.onRequest("session/prompt", async () => {
      const editResp = await serverConn.sendRequest("session/request_permission", {
        sessionId: "s-perm",
        toolCall: { kind: "edit", title: "Edit app.ts" },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      const execResp = await serverConn.sendRequest("session/request_permission", {
        sessionId: "s-perm",
        toolCall: { kind: "execute", title: "Run rm -rf" },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      serverConn.sendNotification("session/update", {
        sessionId: "s-perm",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `edit=${editResp.outcome.optionId},exec=${execResp.outcome.optionId}`,
          },
        },
      });
      return { stopReason: "end_turn" };
    });

    const permissionCallback = jest.fn(async () => ({ allow: false }));
    const provider = createAcpThreadProvider({
      agentId: "opencode",
      cwd: process.cwd(),
      permissionMode: "auto_edit",
      onPermissionRequest: permissionCallback,
      connectionFactory: () => new JsonRpcStdioConnection({
        input: streams.clientInput,
        output: streams.clientOutput,
      }),
    });

    const thread = provider.startThread();
    const events = [];
    for await (const evt of thread.runStreamed("run ops")) {
      events.push(evt);
    }

    // auto_edit auto-approves edit, delegates exec to interactive callback (which denied it)
    expect(permissionCallback).toHaveBeenCalledTimes(1);
    expect(permissionCallback.mock.calls[0][0].risk).toBe("exec");
    expect(events.find((e) => e.type === "text_delta").delta).toBe("edit=allow,exec=deny");

    await thread.close();
    serverConn.close();
  });

  test("JsonRpcStdioConnection decodes multi-byte UTF-8 characters split across chunks without corruption", async () => {
    const streams = createPairedStreams();
    const received = [];
    const receiver = new JsonRpcStdioConnection({
      input: streams.clientInput,
      output: streams.clientOutput,
    });
    receiver.onNotification("session/update", (params) => {
      received.push(params.text);
    });

    const frame = Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { text: "你好中文🚀测试" },
    })}\n`, "utf8");
    // Deliberately slice right through the middle of multi-byte UTF-8 sequences
    for (let i = 0; i < frame.length; i += 2) {
      streams.serverOutput.write(frame.subarray(i, i + 2));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual(["你好中文🚀测试"]);
    receiver.close();
  });

  test("ACP fs/write_text_file enforces supervised approval and blocks symlink / prefix escapes", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { resolveSafeAcpWorkspacePath } = require("../../../src/agents/providers/acpThreadProvider");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-acp-fs-"));
    const workspace = path.join(tmp, "repo");
    const sibling = path.join(tmp, "repo-evil");
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "secret.txt"), "top-secret", "utf8");
    fs.symlinkSync(sibling, path.join(workspace, "escape-link"));

    try {
      expect(() => resolveSafeAcpWorkspacePath(workspace, path.join(sibling, "secret.txt")))
        .toThrow(/outside workspace root/i);
      expect(() => resolveSafeAcpWorkspacePath(workspace, "escape-link/secret.txt"))
        .toThrow(/outside workspace root/i);
      expect(() => resolveSafeAcpWorkspacePath(workspace, "escape-link/new-file.txt"))
        .toThrow(/outside workspace root/i);

      const streams = createPairedStreams();
      const serverConn = new JsonRpcStdioConnection({
        input: streams.serverInput,
        output: streams.serverOutput,
      });
      serverConn.onRequest("initialize", async () => ({ protocolVersion: 1 }));
      serverConn.onRequest("session/new", async () => ({ sessionId: "s-fs" }));
      let writeErr = "";
      serverConn.onRequest("session/prompt", async () => {
        try {
          await serverConn.sendRequest("fs/write_text_file", { path: "blocked.txt", content: "nope" });
        } catch (err) {
          writeErr = err.message;
        }
        return { stopReason: "end_turn" };
      });

      const provider = createAcpThreadProvider({
        agentId: "opencode",
        cwd: workspace,
        permissionMode: "supervised",
        connectionFactory: () => new JsonRpcStdioConnection({
          input: streams.clientInput,
          output: streams.clientOutput,
        }),
      });
      const thread = provider.startThread();
      for await (const _evt of thread.runStreamed("try write")) { /* drain */ }
      expect(writeErr).toMatch(/Permission denied/i);
      expect(fs.existsSync(path.join(workspace, "blocked.txt"))).toBe(false);

      await thread.close();
      serverConn.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("createUfooAcpServer session/new works with the real default native coding thread", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-acp-real-new-"));
    const streams = createPairedStreams();
    const server = createUfooAcpServer({
      projectRoot: tmp,
      agent: "ucode",
      input: streams.serverInput,
      output: streams.serverOutput,
    });
    const client = new JsonRpcStdioConnection({
      input: streams.clientInput,
      output: streams.clientOutput,
    });
    try {
      const init = await client.sendRequest("initialize", { protocolVersion: 1 });
      expect(init.agentInfo.name).toBe("ucode");
      const created = await client.sendRequest("session/new", { cwd: tmp });
      expect(created.sessionId).toMatch(/^ufoo-acp-/);
    } finally {
      client.close();
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
