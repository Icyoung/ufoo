const fs = require("fs");
const os = require("os");
const path = require("path");
const { createActivityStatePublisher } = require("../../../src/agent/activityStatePublisher");

function makeTmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-pub-"));
  const ufooDir = path.join(root, ".ufoo");
  const agentDir = path.join(ufooDir, "agent");
  const busDir = path.join(ufooDir, "bus");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(busDir, "queues"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "events"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "offsets"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "daemon"), { recursive: true });
  fs.mkdirSync(path.join(busDir, "daemon", "counts"), { recursive: true });
  const agentsFile = path.join(agentDir, "all-agents.json");
  return { root, agentsFile };
}

function writeAgents(agentsFile, agents) {
  fs.writeFileSync(agentsFile, JSON.stringify({
    created_at: "2026-03-08T00:00:00.000Z",
    agents,
  }, null, 2));
}

describe("activityStatePublisher", () => {
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

  test("publish writes state and deduplicates", () => {
    writeAgents(agentsFile, {
      "codex:abc": { status: "active", activity_state: "starting" },
    });

    const pub = createActivityStatePublisher({
      agentsFile,
      subscriber: "codex:abc",
      projectRoot: tmpDir,
    });

    const first = pub.publish("working");
    expect(first).toBe(true);

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents["codex:abc"].activity_state).toBe("working");

    // Same state → deduplicated
    const second = pub.publish("working");
    expect(second).toBe(false);
  });

  test("publish with force=false respects priority", () => {
    writeAgents(agentsFile, {
      "codex:abc": { status: "active", activity_state: "working" },
    });

    const pub = createActivityStatePublisher({
      agentsFile,
      subscriber: "codex:abc",
      projectRoot: tmpDir,
      force: false,
    });

    // idle should NOT overwrite working when force=false
    const changed = pub.publish("idle");
    expect(changed).toBe(false);

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents["codex:abc"].activity_state).toBe("working");
  });

  test("publish with force=true overwrites priority states", () => {
    writeAgents(agentsFile, {
      "codex:abc": { status: "active", activity_state: "working" },
    });

    const pub = createActivityStatePublisher({
      agentsFile,
      subscriber: "codex:abc",
      projectRoot: tmpDir,
      force: true,
    });

    const changed = pub.publish("idle");
    expect(changed).toBe(true);

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents["codex:abc"].activity_state).toBe("idle");
  });

  test("getLastState tracks published state", () => {
    writeAgents(agentsFile, {
      "codex:abc": { status: "active", activity_state: "starting" },
    });

    const pub = createActivityStatePublisher({
      agentsFile,
      subscriber: "codex:abc",
      projectRoot: tmpDir,
    });

    expect(pub.getLastState()).toBe("");
    pub.publish("ready");
    expect(pub.getLastState()).toBe("ready");
    pub.publish("working");
    expect(pub.getLastState()).toBe("working");
  });
});
