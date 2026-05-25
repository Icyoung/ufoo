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
    const names = buildToolList().map((tool) => tool.name);
    expect(names).toContain("ufoo_mcp_status");
    expect(names).toContain("register_agent");
    expect(names).toContain("read_project_registry");
    expect(names).toContain("dispatch_message");
    expect(names).not.toContain("launch_agent");
    expect(names).not.toContain("close_agent");
    expect(names).not.toContain("manage_cron");
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

    const heartbeat = await server.handleRequest({
      jsonrpc: "2.0",
      id: "heartbeat",
      method: "tools/call",
      params: {
        name: "heartbeat_agent",
        arguments: {
          project_root: projectRoot,
          subscriber: "codex:mcp123",
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
        },
      },
    });
    expect(unregistered.result.structuredContent.ok).toBe(true);
  });
});
