const fs = require("fs");
const os = require("os");
const path = require("path");
const { dispatchMessages } = require("../../../src/runtime/daemon");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function readJsonl(file) {
  return fs.readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("daemon dispatchMessages", () => {
  let projectRoot;

  beforeEach(() => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-dispatch-"));
    projectRoot = path.join(parent, "ufoo");
    const paths = getUfooPaths(projectRoot);
    fs.mkdirSync(paths.busDir, { recursive: true });
    fs.mkdirSync(paths.busEventsDir, { recursive: true });
    fs.mkdirSync(path.join(paths.busDir, "queues"), { recursive: true });
    fs.mkdirSync(path.join(paths.busDir, "offsets"), { recursive: true });
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.mkdirSync(paths.runDir, { recursive: true });
    fs.writeFileSync(
      paths.agentsFile,
      JSON.stringify({
        agents: {
          "ufoo-agent": {
            agent_type: "ufoo-agent",
            nickname: "ufoo-agent",
            status: "active",
          },
          "codex:qa123": {
            agent_type: "codex",
            nickname: "ufoo-qa",
            status: "active",
          },
        },
      }, null, 2),
      "utf8"
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("resolves project-prefixed agent nicknames before sending", async () => {
    const paths = getUfooPaths(projectRoot);

    await dispatchMessages(projectRoot, [{
      target: "qa",
      message: "review current diff",
      injection_mode: "immediate",
      source: "ufoo-agent",
    }]);

    const eventFiles = fs.readdirSync(paths.busEventsDir).filter((name) => name.endsWith(".jsonl"));
    expect(eventFiles).toHaveLength(1);
    const events = readJsonl(path.join(paths.busEventsDir, eventFiles[0]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      publisher: "ufoo-agent",
      target: "codex:qa123",
      data: {
        message: "review current diff",
        source: "ufoo-agent",
      },
    });

    const pendingFile = path.join(paths.busDir, "queues", "codex_qa123", "pending.jsonl");
    const pending = readJsonl(pendingFile);
    expect(pending[0].target).toBe("codex:qa123");
  });

  test("logs dispatch failures instead of swallowing them silently", async () => {
    const paths = getUfooPaths(projectRoot);

    await dispatchMessages(projectRoot, [{
      target: "missing-agent",
      message: "work",
      injection_mode: "immediate",
    }]);

    const log = fs.readFileSync(paths.ufooDaemonLog, "utf8");
    expect(log).toContain("dispatch failed target=\"missing-agent\"");
    expect(log).toContain("Target \"missing-agent\" not found");
  });
});
