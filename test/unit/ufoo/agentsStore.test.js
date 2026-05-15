const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  normalizeAgentsData,
  saveAgentsData,
  loadAgentsData,
} = require("../../../src/ufoo/agentsStore");
const { getRegistryLogPath } = require("../../../src/ufoo/agentRegistryDiagnostics");

describe("agentsStore normalizeAgentsData", () => {
  test("heals double-prefixed subscriber id and leaked nickname object", () => {
    const result = normalizeAgentsData({
      agents: {
        "codex:codex:abc123": {
          agent_type: "codex",
          nickname: {
            parentPid: 12345,
            launchMode: "terminal",
            tmuxPane: "",
            tty: "/dev/ttys001",
          },
          status: "active",
          joined_at: "2026-02-12T00:00:00.000Z",
          last_seen: "2026-02-12T00:00:01.000Z",
        },
      },
    });

    expect(result.agents["codex:abc123"]).toMatchObject({
      agent_type: "codex",
      nickname: "",
      launch_mode: "terminal",
      tty: "/dev/ttys001",
      pid: 12345,
    });
    expect(result.agents["codex:codex:abc123"]).toBeUndefined();
  });

  test("heals underscore-prefixed corruption variant", () => {
    const result = normalizeAgentsData({
      agents: {
        "codex:codex_abc123": {
          status: "active",
        },
      },
    });

    expect(result.agents["codex:abc123"]).toMatchObject({ status: "active" });
    expect(result.agents["codex:codex_abc123"]).toBeUndefined();
  });

  test("deduplicates healed collisions by preferring active/newer", () => {
    const result = normalizeAgentsData({
      agents: {
        "codex:abc123": {
          status: "inactive",
          last_seen: "2026-02-12T00:00:00.000Z",
        },
        "codex:codex:abc123": {
          status: "active",
          last_seen: "2026-02-12T00:00:01.000Z",
        },
      },
    });

    expect(result.agents["codex:abc123"]).toMatchObject({
      status: "active",
      last_seen: "2026-02-12T00:00:01.000Z",
    });
  });
});

describe("agentsStore saveAgentsData external activity fields", () => {
  test("keeps newer disk activity state when in-memory snapshot is stale", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agents-store-"));
    const filePath = path.join(dir, "all-agents.json");

    fs.writeFileSync(filePath, JSON.stringify({
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "codex:abc123": {
          status: "active",
          activity_state: "working",
          activity_since: "2026-03-08T00:10:00.000Z",
        },
      },
    }, null, 2));

    const staleMemory = loadAgentsData(filePath);
    staleMemory.agents["codex:abc123"].activity_state = "starting";
    staleMemory.agents["codex:abc123"].activity_since = "2026-03-08T00:01:00.000Z";
    saveAgentsData(filePath, staleMemory);

    const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(after.agents["codex:abc123"].activity_state).toBe("working");
    expect(after.agents["codex:abc123"].activity_since).toBe("2026-03-08T00:10:00.000Z");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("keeps newer in-memory activity state when it has newer timestamp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agents-store-"));
    const filePath = path.join(dir, "all-agents.json");

    fs.writeFileSync(filePath, JSON.stringify({
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "codex:abc123": {
          status: "active",
          activity_state: "working",
          activity_since: "2026-03-08T00:01:00.000Z",
        },
      },
    }, null, 2));

    const freshMemory = loadAgentsData(filePath);
    freshMemory.agents["codex:abc123"].activity_state = "blocked";
    freshMemory.agents["codex:abc123"].activity_since = "2026-03-08T00:10:00.000Z";
    saveAgentsData(filePath, freshMemory);

    const after = JSON.parse(fs.readFileSync(filePath, "utf8"));
    expect(after.agents["codex:abc123"].activity_state).toBe("blocked");
    expect(after.agents["codex:abc123"].activity_since).toBe("2026-03-08T00:10:00.000Z");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("agentsStore diagnostics", () => {
  test("records unreadable all-agents registry loads", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agents-store-"));
    const filePath = path.join(dir, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not json", "utf8");

    const loaded = loadAgentsData(filePath);

    expect(loaded.agents).toEqual({});
    const logPath = getRegistryLogPath(filePath);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    expect(lines.map((line) => line.event)).toEqual(
      expect.arrayContaining(["read_json_failed", "load_agents_empty"])
    );
    expect(lines.find((line) => line.event === "read_json_failed")).toMatchObject({
      source: "bus.utils.readJSON",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("records save attempts that would drop existing disk agents", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agents-store-"));
    const filePath = path.join(dir, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "codex:keep": { status: "active" },
        "codex:drop": { status: "active" },
      },
    }, null, 2));

    saveAgentsData(filePath, {
      created_at: "2026-03-08T00:00:00.000Z",
      agents: {
        "codex:keep": { status: "active" },
      },
    }, { source: "test.drop" });

    const logPath = getRegistryLogPath(filePath);
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    const dropLine = lines.find((line) => line.event === "save_agents_dropping_disk_entries");
    expect(dropLine).toMatchObject({
      source: "test.drop",
      dropped_ids: ["codex:drop"],
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
