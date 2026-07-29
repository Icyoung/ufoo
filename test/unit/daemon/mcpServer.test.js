"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildToolList,
  createUfooMcpServer,
} = require("../../../src/runtime/daemon/mcpServer");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

const tempProjects = [];

function makeTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-test-"));
  tempProjects.push(projectRoot);
  const paths = getUfooPaths(projectRoot);
  fs.mkdirSync(paths.busQueuesDir, { recursive: true });
  fs.mkdirSync(paths.busEventsDir, { recursive: true });
  fs.mkdirSync(paths.busLogsDir, { recursive: true });
  fs.mkdirSync(paths.busOffsetsDir, { recursive: true });
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.writeFileSync(paths.agentsFile, JSON.stringify({
    created_at: new Date().toISOString(),
    agents: {},
  }, null, 2));
  return projectRoot;
}

describe("ufoo global MCP server", () => {
  afterAll(() => {
    for (const projectRoot of tempProjects) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("lists only global bridge tools and selected shared tools", () => {
    const tools = buildToolList();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("ufoo_mcp_status");
    expect(names).toContain("register_agent");
    expect(names).toContain("wait_for_message");
    expect(names).toContain("read_project_registry");
    expect(names).toContain("dispatch_message");
    expect(names).not.toContain("launch_agent");
    expect(names).not.toContain("close_agent");
    expect(names).not.toContain("manage_cron");
    expect(tools.find((tool) => tool.name === "register_agent").description)
      .toContain("no wrapper-provided UFOO_SUBSCRIBER_ID");
    expect(tools.find((tool) => tool.name === "wait_for_message").inputSchema)
      .toMatchObject({
        required: ["project_root", "subscriber", "agent_handle"],
        properties: {
          after_seq: { minimum: 0 },
          timeout_seconds: { minimum: 1, maximum: 600 },
        },
      });
  });

  test("handles initialize and tools/list JSON-RPC requests", async () => {
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
    });

    const init = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" },
    });
    expect(init.result.serverInfo.name).toBe("ufoo-global-mcp");
    expect(init.result.capabilities.tools).toEqual({ listChanged: false });

    const listed = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listed.result.tools.some((tool) => tool.name === "register_agent")).toBe(true);
  });

  test("routes project-scoped tools through the configured ProjectRuntimeGateway", async () => {
    const call = jest.fn(async (projectRoot, operation, args) => ({
      ok: true,
      project_root: projectRoot,
      operation,
      subscriber: args.subscriber,
    }));
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
      projectRuntimeGateway: { call, cancel: () => false },
    });

    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: "gateway-call",
      method: "tools/call",
      params: {
        name: "heartbeat_agent",
        arguments: {
          project_root: "/tmp/gateway-project",
          subscriber: "codex:gateway",
          agent_handle: "gateway-handle",
        },
      },
    });

    expect(response.result.structuredContent).toMatchObject({
      ok: true,
      operation: "heartbeat_agent",
      subscriber: "codex:gateway",
    });
    expect(call).toHaveBeenCalledWith(
      "/tmp/gateway-project",
      "heartbeat_agent",
      expect.objectContaining({ subscriber: "codex:gateway" }),
      expect.objectContaining({ toolCallId: "gateway-call" })
    );
  });

  test("registers, heartbeats, polls, reports, and unregisters an MCP agent", async () => {
    const projectRoot = makeTempProject();
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
    });

    const registered = await server.handleRequest({
      jsonrpc: "2.0",
      id: "register",
      method: "tools/call",
      params: {
        name: "register_agent",
        arguments: {
          project_root: projectRoot,
          agent_type: "codex",
          session_id: "mcp123",
          nickname: "mcp-one",
        },
      },
    });
    const registerPayload = registered.result.structuredContent;
    expect(registerPayload.ok).toBe(true);
    expect(registerPayload.subscriber).toBe("codex:mcp123");
    expect(registerPayload.nickname).toBe("mcp-one");
    expect(registerPayload.agent_handle).toEqual(expect.any(String));
    expect(registerPayload.lease_expires_at).toEqual(expect.any(String));
    const agentHandle = registerPayload.agent_handle;
    const storedRegistry = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));
    expect(storedRegistry.agents["codex:mcp123"].mcp_agent_handle_hash)
      .toEqual(expect.any(String));
    expect(JSON.stringify(storedRegistry)).not.toContain(agentHandle);

    const heartbeat = await server.handleRequest({
      jsonrpc: "2.0",
      id: "heartbeat",
      method: "tools/call",
      params: {
        name: "heartbeat_agent",
        arguments: {
          project_root: projectRoot,
          subscriber: "codex:mcp123",
          agent_handle: agentHandle,
        },
      },
    });
    expect(heartbeat.result.structuredContent.ok).toBe(true);

    const inbox = await server.handleRequest({
      jsonrpc: "2.0",
      id: "poll",
      method: "tools/call",
      params: {
        name: "poll_inbox",
        arguments: {
          project_root: projectRoot,
          subscriber: "codex:mcp123",
          agent_handle: agentHandle,
        },
      },
    });
    expect(inbox.result.structuredContent).toMatchObject({
      ok: true,
      count: 0,
      messages: [],
    });

    const report = await server.handleRequest({
      jsonrpc: "2.0",
      id: "report",
      method: "tools/call",
      params: {
        name: "report_agent_status",
        arguments: {
          project_root: projectRoot,
          subscriber: "codex:mcp123",
          agent_handle: agentHandle,
          task_id: "task-a",
          phase: "done",
          summary: "done",
        },
      },
    });
    const reportPayload = report.result.structuredContent;
    expect(reportPayload.status).toBe("queued");
    expect(reportPayload.report.agent_id).toBe("codex:mcp123");
    expect(fs.existsSync(getUfooPaths(projectRoot).busDir)).toBe(true);
    expect(fs.readFileSync(
      path.join(getUfooPaths(projectRoot).busDir, "control", "report", "pending.jsonl"),
      "utf8"
    )).toContain("agent_report");

    const unregistered = await server.handleRequest({
      jsonrpc: "2.0",
      id: "unregister",
      method: "tools/call",
      params: {
        name: "unregister_agent",
        arguments: {
          project_root: projectRoot,
          subscriber: "codex:mcp123",
          agent_handle: agentHandle,
        },
      },
    });
    expect(unregistered.result.structuredContent.ok).toBe(true);
  });

  test("recovers a client instance with the same subscriber and rotates its handle", async () => {
    const projectRoot = makeTempProject();
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
    });
    const register = (id) => server.handleRequest({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "register_agent",
        arguments: {
          project_root: projectRoot,
          agent_type: "cursor",
          client_instance_id: "cursor-window-1",
        },
      },
    });

    const first = (await register("register-first")).result.structuredContent;
    const second = (await register("register-second")).result.structuredContent;
    expect(second).toMatchObject({
      subscriber: first.subscriber,
      client_instance_id: "cursor-window-1",
      recovered: true,
    });
    expect(second.agent_handle).not.toBe(first.agent_handle);

    const staleHandle = await server.handleRequest({
      jsonrpc: "2.0",
      id: "stale-handle",
      method: "tools/call",
      params: {
        name: "heartbeat_agent",
        arguments: {
          project_root: projectRoot,
          subscriber: first.subscriber,
          agent_handle: first.agent_handle,
        },
      },
    });
    expect(staleHandle.error.data.code).toBe("invalid_agent_handle");

    const currentHandle = await server.handleRequest({
      jsonrpc: "2.0",
      id: "current-handle",
      method: "tools/call",
      params: {
        name: "heartbeat_agent",
        arguments: {
          project_root: projectRoot,
          subscriber: second.subscriber,
          agent_handle: second.agent_handle,
        },
      },
    });
    expect(currentHandle.result.structuredContent.lease_expires_at)
      .toEqual(expect.any(String));
  });

  test("wait_for_message returns a timeout cursor without periodic model work", async () => {
    const projectRoot = makeTempProject();
    let now = 0;
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
      waitPollIntervalMs: 100,
      waitNow: () => now,
      waitSleep: async (ms) => {
        now += ms;
      },
    });

    const registered = await server.handleRequest({
      jsonrpc: "2.0",
      id: "register-timeout",
      method: "tools/call",
      params: {
        name: "register_agent",
        arguments: {
          project_root: projectRoot,
          agent_type: "codex",
          session_id: "wait-timeout",
        },
      },
    });
    const registration = registered.result.structuredContent;
    const subscriber = registration.subscriber;
    const agentHandle = registration.agent_handle;

    const waited = await server.handleRequest({
      jsonrpc: "2.0",
      id: "wait-timeout",
      method: "tools/call",
      params: {
        name: "wait_for_message",
        arguments: {
          project_root: projectRoot,
          subscriber,
          agent_handle: agentHandle,
          after_seq: 7,
          timeout_seconds: 1,
        },
      },
    });

    expect(waited.result.structuredContent).toMatchObject({
      ok: true,
      subscriber,
      status: "timeout",
      timed_out: true,
      count: 0,
      messages: [],
      after_seq: 7,
      last_seq: 7,
      waited_ms: 1000,
    });
  });

  test("cancels a pending wait_for_message tool call", async () => {
    const projectRoot = makeTempProject();
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
      waitPollIntervalMs: 5000,
    });

    const registered = await server.handleRequest({
      jsonrpc: "2.0",
      id: "register-cancel",
      method: "tools/call",
      params: {
        name: "register_agent",
        arguments: {
          project_root: projectRoot,
          agent_type: "codex",
          session_id: "wait-cancel",
        },
      },
    });
    const registration = registered.result.structuredContent;
    const subscriber = registration.subscriber;
    const agentHandle = registration.agent_handle;

    const pending = server.handleRequest({
      jsonrpc: "2.0",
      id: "wait-cancel",
      method: "tools/call",
      params: {
        name: "wait_for_message",
        arguments: {
          project_root: projectRoot,
          subscriber,
          agent_handle: agentHandle,
          timeout_seconds: 600,
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await server.handleRequest({
      jsonrpc: "2.0",
      id: "wait-duplicate",
      method: "tools/call",
      params: {
        name: "wait_for_message",
        arguments: {
          project_root: projectRoot,
          subscriber,
          agent_handle: agentHandle,
          timeout_seconds: 1,
        },
      },
    });
    expect(duplicate.error.message).toContain("wait_for_message is already running");

    await server.handleRequest({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "wait-cancel" },
    });

    await expect(pending).resolves.toMatchObject({
      error: {
        data: { code: "request_cancelled" },
      },
    });

    await server.handleRequest({
      jsonrpc: "2.0",
      id: "message-after-cancel",
      method: "tools/call",
      params: {
        name: "dispatch_message",
        arguments: {
          project_root: projectRoot,
          subscriber,
          agent_handle: agentHandle,
          target: subscriber,
          message: "wake after cancellation",
        },
      },
    });
    const rearmed = await server.handleRequest({
      jsonrpc: "2.0",
      id: "wait-after-cancel",
      method: "tools/call",
      params: {
        name: "wait_for_message",
        arguments: {
          project_root: projectRoot,
          subscriber,
          agent_handle: agentHandle,
          timeout_seconds: 1,
        },
      },
    });
    expect(rearmed.result.structuredContent).toMatchObject({
      status: "message",
      count: 1,
    });
  });
});
