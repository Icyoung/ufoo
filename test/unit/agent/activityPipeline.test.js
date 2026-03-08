/**
 * End-to-end test for activity_state visibility in the dashboard.
 * Simulates: ptyRunner writes → daemon saveBusData preserves → buildStatus reads → dashboardView renders
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { saveAgentsData, loadAgentsData } = require("../../../src/ufoo/agentsStore");
const { writeActivityState } = require("../../../src/agent/activityStateWriter");
const { buildStatus } = require("../../../src/daemon/status");
const { computeDashboardContent } = require("../../../src/chat/dashboardView");
const { buildAgentMaps } = require("../../../src/chat/agentDirectory");

function makeTmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-e2e-activity-"));
  const ufooDir = path.join(root, ".ufoo");
  const agentDir = path.join(ufooDir, "agent");
  const busDir = path.join(ufooDir, "bus");
  const contextDir = path.join(ufooDir, "context");
  const decisionsDir = path.join(contextDir, "decisions");
  const reportsDir = path.join(ufooDir, "reports");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(busDir, { recursive: true });
  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(path.join(busDir, "queues"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "offsets"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "daemon"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "daemon", "counts"), { recursive: true });
  const agentsFile = path.join(agentDir, "all-agents.json");
  return { root, agentsFile };
}

describe("activity_state end-to-end pipeline", () => {
  let tmpDir;
  let agentsFile;

  beforeEach(() => {
    const proj = makeTmpProject();
    tmpDir = proj.root;
    agentsFile = proj.agentsFile;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("Step 1: writeActivityState writes to disk", () => {
    // Setup: agent joined with starting state
    fs.writeFileSync(agentsFile, JSON.stringify({
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "claude-code:abc123": {
          agent_type: "claude-code",
          nickname: "builder",
          status: "active",
          activity_state: "starting",
          activity_since: "2026-03-08T00:00:00.000Z",
          joined_at: "2026-03-08T00:00:00.000Z",
          last_seen: "2026-03-08T00:00:00.000Z",
        },
      },
    }, null, 2));

    // ptyRunner marks working
    const changed = writeActivityState(agentsFile, "claude-code:abc123", "working", {
      since: Date.now(),
      force: true,
    });
    expect(changed).toBe(true);

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents["claude-code:abc123"].activity_state).toBe("working");
  });

  test("Step 2: daemon saveBusData does NOT overwrite newer disk activity_state", () => {
    // Disk has working state (written by ptyRunner)
    fs.writeFileSync(agentsFile, JSON.stringify({
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "claude-code:abc123": {
          agent_type: "claude-code",
          nickname: "builder",
          status: "active",
          activity_state: "working",
          activity_since: "2026-03-08T00:05:00.000Z",
          joined_at: "2026-03-08T00:00:00.000Z",
          last_seen: "2026-03-08T00:05:00.000Z",
        },
      },
    }, null, 2));

    // Daemon's in-memory busData has stale starting state from join()
    const daemonMemory = {
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "claude-code:abc123": {
          agent_type: "claude-code",
          nickname: "builder",
          status: "active",
          activity_state: "starting",
          activity_since: "2026-03-08T00:00:00.000Z",
          joined_at: "2026-03-08T00:00:00.000Z",
          last_seen: "2026-03-08T00:05:01.000Z",
        },
      },
    };

    // Daemon saves its in-memory state (e.g. after sending message)
    saveAgentsData(agentsFile, daemonMemory);

    // activity_state should still be "working" (disk was newer)
    const after = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(after.agents["claude-code:abc123"].activity_state).toBe("working");
    expect(after.agents["claude-code:abc123"].activity_since).toBe("2026-03-08T00:05:00.000Z");
  });

  test("Step 3: buildStatus includes activity_state in active_meta", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "claude-code:abc123": {
          agent_type: "claude-code",
          nickname: "builder",
          status: "active",
          activity_state: "working",
          activity_since: "2026-03-08T00:05:00.000Z",
          joined_at: "2026-03-08T00:00:00.000Z",
          last_seen: new Date().toISOString(),
          pid: process.pid,
        },
      },
    }, null, 2));

    const status = buildStatus(tmpDir);
    expect(status.active_meta).toHaveLength(1);
    expect(status.active_meta[0].activity_state).toBe("working");
    expect(status.active_meta[0].activity_since).toBe("2026-03-08T00:05:00.000Z");
  });

  test("Step 4: buildAgentMaps preserves activity_state in metaMap", () => {
    const metaList = [
      {
        id: "claude-code:abc123",
        nickname: "builder",
        display: "builder",
        launch_mode: "internal-pty",
        activity_state: "working",
        activity_since: "2026-03-08T00:05:00.000Z",
      },
    ];

    const maps = buildAgentMaps(["claude-code:abc123"], metaList);
    const meta = maps.metaMap.get("claude-code:abc123");
    expect(meta).toBeDefined();
    expect(meta.activity_state).toBe("working");
  });

  test("Step 5: dashboardView renders activity prefix in summary line", () => {
    const result = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["claude-code:abc123"],
      getAgentLabel: () => "builder",
      getAgentState: () => "working",
    });
    expect(result.content).toContain("*@builder");
  });

  test("Step 5b: dashboardView renders ? for waiting_input", () => {
    const result = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["claude-code:abc123"],
      getAgentLabel: () => "builder",
      getAgentState: () => "waiting_input",
    });
    expect(result.content).toContain("?@builder");
  });

  test("Step 5c: dashboardView renders ! for blocked", () => {
    const result = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["claude-code:abc123"],
      getAgentLabel: () => "builder",
      getAgentState: () => "blocked",
    });
    expect(result.content).toContain("!@builder");
  });

  test("Step 5d: dashboardView detail line renders prefix in dashboard mode", () => {
    const result = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "agents",
      activeAgents: ["claude-code:abc123"],
      selectedAgentIndex: 0,
      getAgentLabel: () => "builder",
      getAgentState: () => "blocked",
    });
    expect(result.content).toContain("!@builder");
  });

  test("Step 5e: no prefix for idle/ready/starting", () => {
    for (const state of ["idle", "ready", "starting", ""]) {
      const result = computeDashboardContent({
        focusMode: "input",
        activeAgents: ["claude-code:abc123"],
        getAgentLabel: () => "builder",
        getAgentState: () => state,
      });
      expect(result.content).toContain("@builder");
      expect(result.content).not.toMatch(/[*?!]@builder/);
    }
  });

  test("Full pipeline: ptyRunner write → daemon overwrite → buildStatus → dashboard render", () => {
    // 1. Agent joins (daemon sets starting in-memory)
    const daemonMemory = {
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "claude-code:abc123": {
          agent_type: "claude-code",
          nickname: "builder",
          status: "active",
          activity_state: "starting",
          activity_since: "2026-03-08T00:00:00.000Z",
          joined_at: "2026-03-08T00:00:00.000Z",
          last_seen: "2026-03-08T00:00:00.000Z",
          pid: process.pid,
        },
      },
    };
    saveAgentsData(agentsFile, daemonMemory);

    // 2. ptyRunner detects ready then working
    writeActivityState(agentsFile, "claude-code:abc123", "ready", { force: true });
    writeActivityState(agentsFile, "claude-code:abc123", "working", { since: Date.now(), force: true });

    // 3. Daemon does a saveBusData (e.g. heartbeat, message send)
    daemonMemory.agents["claude-code:abc123"].last_seen = new Date().toISOString();
    saveAgentsData(agentsFile, daemonMemory);

    // 4. buildStatus reads from disk
    const status = buildStatus(tmpDir);
    expect(status.active_meta.length).toBe(1);
    expect(status.active_meta[0].activity_state).toBe("working");

    // 5. Chat builds meta map
    const maps = buildAgentMaps(status.active, status.active_meta);
    const meta = maps.metaMap.get("claude-code:abc123");
    expect(meta.activity_state).toBe("working");

    // 6. Dashboard renders
    const dashboard = computeDashboardContent({
      focusMode: "input",
      activeAgents: status.active,
      getAgentLabel: (id) => maps.labelMap.get(id) || id,
      getAgentState: (id) => {
        const m = maps.metaMap.get(id);
        return m && typeof m.activity_state === "string" ? m.activity_state : "";
      },
    });
    expect(dashboard.content).toContain("*@builder");
  });
});
