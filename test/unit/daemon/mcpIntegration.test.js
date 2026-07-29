"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createUfooMcpServer,
} = require("../../../src/runtime/daemon/mcpServer");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

const tempProjects = [];

function makeTempProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-e2e-"));
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

function call(server, id, name, args) {
  return server.handleRequest({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

describe("MCP external integration (Phase 6)", () => {
  afterAll(() => {
    for (const p of tempProjects) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  });

  test("two external agents collaborate via MCP bridge without wrappers", async () => {
    const projectRoot = makeTempProject();
    const server = createUfooMcpServer({
      autoStart: false,
      validateProjectRoot: false,
      waitPollIntervalMs: 50,
    });

    // Agent A registers (simulating raw claude)
    const regA = await call(server, 1, "register_agent", {
      project_root: projectRoot,
      agent_type: "claude",
      nickname: "claude-ext",
    });
    const a = regA.result.structuredContent;
    expect(a.ok).toBe(true);
    expect(a.agent_type).toBe("claude-code");
    const subA = a.subscriber;
    const handleA = a.agent_handle;

    // Agent B registers (simulating raw codex)
    const regB = await call(server, 2, "register_agent", {
      project_root: projectRoot,
      agent_type: "codex",
      nickname: "codex-ext",
    });
    const b = regB.result.structuredContent;
    expect(b.ok).toBe(true);
    const subB = b.subscriber;
    const handleB = b.agent_handle;

    // Both appear in bus summary
    const summary = await call(server, 3, "read_bus_summary", {
      project_root: projectRoot,
    });
    const agents = summary.result.structuredContent.active_agents || [];
    expect(agents.some((ag) => ag.id === subA)).toBe(true);
    expect(agents.some((ag) => ag.id === subB)).toBe(true);

    const forged = await call(server, "forged-handle", "dispatch_message", {
      project_root: projectRoot,
      subscriber: subB,
      agent_handle: handleA,
      target: subA,
      message: "forged",
    });
    expect(forged.error.data.code).toBe("invalid_agent_handle");

    // Agent A publishes activity
    const actRes = await call(server, 4, "publish_activity_state", {
      project_root: projectRoot,
      subscriber: subA,
      agent_handle: handleA,
      activity_state: "working",
      detail: "reviewing auth module",
    });
    expect(actRes.result.structuredContent.activity_state).toBe("working");

    // Agent B keeps one MCP tool call pending (Codex App receive path).
    const waiting = call(server, 5, "wait_for_message", {
      project_root: projectRoot,
      subscriber: subB,
      agent_handle: handleB,
      after_seq: 0,
      timeout_seconds: 10,
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Agent A sends a message; the pending tool call returns and wakes Agent B.
    await call(server, 6, "dispatch_message", {
      project_root: projectRoot,
      subscriber: subA,
      agent_handle: handleA,
      source: subA,
      target: subB,
      message: "Please review the auth module.",
    });

    const inbox = await waiting;
    const inboxData = inbox.result.structuredContent;
    expect(inboxData.status).toBe("message");
    expect(inboxData.timed_out).toBe(false);
    expect(inboxData.count).toBeGreaterThan(0);
    expect(inboxData.messages[0].data.message).toContain("auth module");
    expect(inboxData.last_seq).toBeGreaterThan(0);

    // Agent B acks only the returned batch, preserving later arrivals.
    const ack = await call(server, 7, "ack_bus", {
      project_root: projectRoot,
      subscriber: subB,
      agent_handle: handleB,
      through_seq: inboxData.last_seq,
    });
    expect(ack.result.structuredContent.ok).toBe(true);
    expect(ack.result.structuredContent.through_seq).toBe(inboxData.last_seq);

    // After ack, inbox is empty
    const inbox2 = await call(server, 8, "poll_inbox", {
      project_root: projectRoot,
      subscriber: subB,
      agent_handle: handleB,
    });
    expect(inbox2.result.structuredContent.count).toBe(0);

    // Agent B submits a report
    const report = await call(server, 9, "report_agent_status", {
      project_root: projectRoot,
      subscriber: subB,
      agent_handle: handleB,
      task_id: "review-auth",
      phase: "done",
      summary: "Auth module looks good",
    });
    expect(report.result.structuredContent.status).toBe("queued");

    // Agent A updates metadata
    const meta = await call(server, 10, "update_agent_metadata", {
      project_root: projectRoot,
      subscriber: subA,
      agent_handle: handleA,
      nickname: "claude-reviewer",
      metadata: { role: "reviewer" },
    });
    expect(meta.result.structuredContent.nickname).toBe("claude-reviewer");
    expect(meta.result.structuredContent.metadata.role).toBe("reviewer");

    // Both unregister
    const unA = await call(server, 11, "unregister_agent", {
      project_root: projectRoot, subscriber: subA, agent_handle: handleA,
    });
    const unB = await call(server, 12, "unregister_agent", {
      project_root: projectRoot, subscriber: subB, agent_handle: handleB,
    });
    expect(unA.result.structuredContent.ok).toBe(true);
    expect(unB.result.structuredContent.ok).toBe(true);
  });
});
