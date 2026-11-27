"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { readAgentHistory, readAgentHistoryHandler } = require("../../../src/tools/handlers/readAgentHistory");
const { executeControllerTool } = require("../../../src/agents/controller/controllerToolExecutor");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function writeFixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agent-history-"));
  const paths = getUfooPaths(root);
  fs.mkdirSync(paths.busEventsDir, { recursive: true });
  fs.mkdirSync(paths.groupsDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });

  fs.writeFileSync(paths.agentsFile, JSON.stringify({
    agents: {
      "codex:arch0001": {
        nickname: "architect",
        display_nickname: "architect",
        status: "active",
        activity_state: "ready",
        group_id: "build-lane-demo",
        group_template_alias: "build-lane",
      },
      "codex:bldr0002": {
        nickname: "builder",
        display_nickname: "builder",
        status: "active",
        activity_state: "ready",
        group_id: "build-lane-demo",
        group_template_alias: "build-lane",
      },
    },
  }, null, 2));

  fs.writeFileSync(path.join(paths.groupsDir, "build-lane-demo.json"), JSON.stringify({
    group_id: "build-lane-demo",
    template_alias: "build-lane",
    template_name: "Build Lane",
    status: "running",
    members: [
      { nickname: "architect", subscriber_id: "codex:arch0001", role: "architect" },
      { nickname: "builder", subscriber_id: "codex:bldr0002", role: "builder" },
      { nickname: "reviewer", subscriber_id: "codex:revw0003", previous_subscriber_id: "codex:revw0000", role: "reviewer" },
    ],
  }, null, 2));

  const events = [
    {
      seq: 1,
      timestamp: "2026-11-27T01:00:00.000Z",
      event: "agent_joined",
      publisher: "codex:revw0003",
      data: { agent_id: "codex:revw0003", nickname: "reviewer" },
    },
    {
      seq: 2,
      timestamp: "2026-11-27T01:00:01.000Z",
      event: "message",
      publisher: "ufoo-agent",
      target: "codex:arch0001",
      data: { message: "Design the auth token refresh contract for F04" },
    },
    {
      seq: 3,
      timestamp: "2026-11-27T01:00:02.000Z",
      event: "agent_surface",
      publisher: "codex:arch0001",
      data: {
        subscriber: "codex:arch0001",
        surface: { type: "task_started", message: "Design the auth token refresh contract for F04", publisher: "ufoo-agent", queueSequence: 2 },
      },
    },
    {
      seq: 4,
      timestamp: "2026-11-27T01:00:03.000Z",
      event: "agent_surface",
      publisher: "codex:arch0001",
      data: {
        subscriber: "codex:arch0001",
        surface: { type: "tool_call", name: "read", args: { path: "src/auth.js" } },
      },
    },
    {
      seq: 5,
      timestamp: "2026-11-27T01:00:04.000Z",
      event: "agent_surface",
      publisher: "codex:arch0001",
      data: {
        subscriber: "codex:arch0001",
        surface: { type: "text_delta", delta: "F04 plan: refresh window is 300s with single-flight lock." },
      },
    },
    {
      seq: 6,
      timestamp: "2026-11-27T01:00:05.000Z",
      event: "agent_surface",
      publisher: "codex:arch0001",
      data: {
        subscriber: "codex:arch0001",
        surface: { type: "task_completed", finalText: "F04 plan: refresh window is 300s with single-flight lock." },
      },
    },
    {
      seq: 7,
      timestamp: "2026-11-27T01:00:06.000Z",
      event: "message",
      publisher: "codex:arch0001",
      target: "codex:bldr0002",
      data: { message: "Implement F04 single-flight refresh with Bearer secret-token-1234567890 redacted" },
    },
    {
      seq: 8,
      timestamp: "2026-11-27T01:00:07.000Z",
      event: "message",
      publisher: "codex:bldr0002",
      target: "ufoo-agent",
      data: { message: JSON.stringify({ stream: true, delta: "ignored stream frame" }) },
    },
    {
      seq: 9,
      timestamp: "2026-11-27T01:00:08.000Z",
      event: "agent_surface",
      publisher: "codex:revw0003",
      data: {
        subscriber: "codex:revw0003",
        surface: { type: "task_completed", finalText: "Archived reviewer verdict: PASS on F04 single-flight lock." },
      },
    },
  ];

  fs.writeFileSync(
    path.join(paths.busEventsDir, "2026-11-27.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  return root;
}

describe("read_agent_history tool", () => {
  let root;
  beforeEach(() => { root = writeFixtureProject(); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test("reads project-wide chronological history with resolved nicknames, stream filtering, and secret redaction", () => {
    const res = readAgentHistory(root, {});
    expect(res.ok).toBe(true);
    expect(res.entries.some((e) => e.text.includes("ignored stream frame"))).toBe(false);
    // Dedupes task_started against queueSequence=2 bus message
    expect(res.entries.filter((e) => e.text.includes("Design the auth token refresh contract"))).toHaveLength(1);
    const archReply = res.entries.find((e) => e.role === "assistant" && e.agent_label === "architect");
    expect(archReply.text).toContain("300s with single-flight lock");
    const redactedMsg = res.entries.find((e) => e.sender_label === "architect" && e.target_label === "builder");
    expect(redactedMsg.text).not.toContain("secret-token-1234567890");
    expect(redactedMsg.text).toContain("Bearer [REDACTED]");
    // Archived reviewer resolved by nickname, not raw ID
    const revEntry = res.entries.find((e) => e.agent_id === "codex:revw0003");
    expect(revEntry).toMatchObject({ agent_label: "reviewer", text: expect.stringContaining("PASS on F04") });
  });

  test("filters by agent nickname, group reference, keyword query, include_tools, and pagination", () => {
    const byNick = readAgentHistory(root, { agent: "reviewer" });
    expect(byNick.count).toBe(1);
    expect(byNick.entries[0].agent_label).toBe("reviewer");

    const byGroup = readAgentHistory(root, { agent: "group:build-lane" });
    expect(byGroup.count).toBeGreaterThanOrEqual(4);

    const byQuery = readAgentHistory(root, { query: "single-flight" });
    expect(byQuery.count).toBe(3);

    const withTools = readAgentHistory(root, { agent: "architect", include_tools: true });
    expect(withTools.entries.some((e) => e.role === "tool" && e.tool_name === "read")).toBe(true);

    const page1 = readAgentHistory(root, { limit: 2 });
    expect(page1.count).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.next_before_seq).toBe(page1.entries[0].seq);

    const page2 = readAgentHistory(root, { limit: 2, before_seq: page1.next_before_seq });
    expect(page2.count).toBe(2);
    expect(page2.entries.every((e) => e.seq < page1.next_before_seq)).toBe(true);
  });

  test("executes cleanly via controller tool executor", async () => {
    const res = await executeControllerTool(
      { projectRoot: root, subscriber: "ufoo-agent" },
      { name: "read_agent_history", arguments: { agent: "architect", max_chars: 120 } }
    );
    expect(res.ok).toBe(true);
    expect(res.result.count).toBeGreaterThanOrEqual(2);
    expect(readAgentHistoryHandler({ projectRoot: root }, { agent: "architect" }).ok).toBe(true);
  });
});
