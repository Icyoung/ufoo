const fs = require("fs");
const os = require("os");
const path = require("path");

const EventBus = require("../../../src/bus");
const DecisionsManager = require("../../../src/context/decisions");
const { upsertProjectRuntime } = require("../../../src/projects/registry");
const { readBusSummaryHandler } = require("../../../src/tools/handlers/readBusSummary");
const { readPromptHistoryHandler } = require("../../../src/tools/handlers/readPromptHistory");
const { readOpenDecisionsHandler } = require("../../../src/tools/handlers/readOpenDecisions");
const { listAgentsHandler } = require("../../../src/tools/handlers/listAgents");
const { readProjectRegistryHandler } = require("../../../src/tools/handlers/readProjectRegistry");

describe("tier0 tool handlers", () => {
  let projectRoot;
  let runtimeDir;
  let eventBus;
  let sender;
  let receiver;
  let logSpy;
  let errorSpy;

  beforeEach(async () => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-tools-tier0-"));
    runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-tools-runtime-"));
    eventBus = new EventBus(projectRoot);
    await eventBus.init();
    sender = await eventBus.join("sender", "codex", "sender");
    receiver = await eventBus.join("receiver", "claude-code", "receiver");
    await eventBus.send(receiver, "Continue fixing daemon reconnection edge case", sender, { silent: true });
    await eventBus.send(receiver, "Review previous reconnect patch and add tests", sender, { silent: true });

    const manager = new DecisionsManager(projectRoot);
    fs.mkdirSync(manager.decisionsDir, { recursive: true });
    fs.writeFileSync(path.join(manager.decisionsDir, "0001-open.md"), "---\nstatus: open\n---\n# Open\n", "utf8");
    fs.writeFileSync(path.join(manager.decisionsDir, "0002-resolved.md"), "---\nstatus: resolved\n---\n# Done\n", "utf8");

    upsertProjectRuntime({
      projectRoot,
      projectName: "ufoo",
      status: "running",
      lastSeen: new Date().toISOString(),
    }, { runtimeDir });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  test("read_bus_summary returns aggregate controller summary", () => {
    const result = readBusSummaryHandler({ projectRoot });

    expect(result.project_root).toBe(projectRoot);
    expect(result.summary).toEqual(expect.objectContaining({
      active_count: 2,
      unread_total: 2,
      decisions_open: 1,
    }));
    expect(result.active_agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sender, nickname: "sender" }),
      expect.objectContaining({ id: receiver, nickname: "receiver" }),
    ]));
  });

  test("list_agents returns active agent metadata", () => {
    const result = listAgentsHandler({ projectRoot });

    expect(result.count).toBe(2);
    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: sender }),
      expect.objectContaining({ id: receiver }),
    ]));
  });

  test("read_open_decisions filters open entries only", () => {
    const result = readOpenDecisionsHandler({ projectRoot }, { limit: 10 });

    expect(result.count).toBe(1);
    expect(result.decisions).toEqual([
      expect.objectContaining({
        status: "open",
        title: "Open",
      }),
    ]);
  });

  test("read_prompt_history summarizes recent prompts for active agents", () => {
    const result = readPromptHistoryHandler({ projectRoot }, { per_agent_limit: 2, max_files: 1 });

    expect(result.scanned_files).toBe(1);
    expect(result.matched_events).toBe(2);
    expect(result.per_agent).toEqual([
      expect.objectContaining({
        agent_id: receiver,
        sample_count: 2,
        total_count: 2,
      }),
    ]);
    expect(result.per_agent[0].samples.map((item) => item.prompt)).toEqual(
      expect.arrayContaining([
        "Continue fixing daemon reconnection edge case",
        "Review previous reconnect patch and add tests",
      ])
    );
  });

  test("read_project_registry returns runtime rows", () => {
    const result = readProjectRegistryHandler({}, { validate: false, cleanup_tmp: false, runtimeDir });
    const canonicalRoot = fs.realpathSync(projectRoot);

    expect(result.count).toBe(1);
    expect(result.projects).toEqual([
      expect.objectContaining({
        project_root: canonicalRoot,
        project_name: "ufoo",
      }),
    ]);
  });
});
