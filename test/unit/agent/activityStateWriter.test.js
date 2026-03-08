const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeActivityState } = require("../../../src/agent/activityStateWriter");

describe("activityStateWriter", () => {
  let root;
  let agentsFile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-activity-state-writer-"));
    agentsFile = path.join(root, "all-agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: {
        "codex:1": {
          activity_state: "ready",
          activity_since: "2026-03-07T00:00:00.000Z",
        },
      },
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readState() {
    const parsed = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    return parsed.agents["codex:1"];
  }

  test("writes new state and updates since timestamp", () => {
    const changed = writeActivityState(agentsFile, "codex:1", "working");
    expect(changed).toBe(true);
    const row = readState();
    expect(row.activity_state).toBe("working");
    expect(typeof row.activity_since).toBe("string");
  });

  test("returns false when state is unchanged", () => {
    const changed = writeActivityState(agentsFile, "codex:1", "ready");
    expect(changed).toBe(false);
  });

  test("does not downgrade waiting_input to idle without force", () => {
    writeActivityState(agentsFile, "codex:1", "waiting_input");
    const changed = writeActivityState(agentsFile, "codex:1", "idle");
    expect(changed).toBe(false);
    expect(readState().activity_state).toBe("waiting_input");
  });

  test("does not downgrade working to idle without force", () => {
    writeActivityState(agentsFile, "codex:1", "working");
    const changed = writeActivityState(agentsFile, "codex:1", "idle");
    expect(changed).toBe(false);
    expect(readState().activity_state).toBe("working");
  });

  test("allows downgrade with force flag", () => {
    writeActivityState(agentsFile, "codex:1", "waiting_input");
    const changed = writeActivityState(agentsFile, "codex:1", "idle", { force: true });
    expect(changed).toBe(true);
    expect(readState().activity_state).toBe("idle");
  });

  test("allows working to idle downgrade with force", () => {
    writeActivityState(agentsFile, "codex:1", "working");
    const changed = writeActivityState(agentsFile, "codex:1", "idle", { force: true });
    expect(changed).toBe(true);
    expect(readState().activity_state).toBe("idle");
  });
});
