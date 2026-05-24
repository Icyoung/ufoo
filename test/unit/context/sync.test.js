const fs = require("fs");
const os = require("os");
const path = require("path");

const SyncManager = require("../../../src/coordination/context/sync");
const { runCtxCommand } = require("../../../src/app/cli/ctxCoreCommands");

describe("context sync", () => {
  let projectRoot;
  let consoleLogSpy;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-sync-test-"));
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("writes a sync entry with structured fields", () => {
    const manager = new SyncManager(projectRoot);
    const entry = manager.write({
      from: "codex-1",
      for: "codex-3",
      message: "Implemented assistant-call prompt loop",
      decision: "0071",
      file: "src/runtime/daemon/promptLoop.js",
      tests: "test/unit/daemon/promptLoop.test.js",
      verification: "npm test -- test/unit/daemon/promptLoop.test.js",
      risk: "low",
      next: "wire assistant_call schema",
    });

    const syncFile = path.join(projectRoot, ".ufoo", "context", "sync.jsonl");
    const lines = fs.readFileSync(syncFile, "utf8").trim().split("\n");
    const saved = JSON.parse(lines[0]);

    expect(lines).toHaveLength(1);
    expect(saved.type).toBe("sync");
    expect(saved.from).toBe("codex-1");
    expect(saved.for).toBe("codex-3");
    expect(saved.message).toBe("Implemented assistant-call prompt loop");
    expect(saved.decision).toBe("0071");
    expect(saved.file).toBe("src/runtime/daemon/promptLoop.js");
    expect(saved.tests).toBe("test/unit/daemon/promptLoop.test.js");
    expect(saved.verification).toBe("npm test -- test/unit/daemon/promptLoop.test.js");
    expect(saved.risk).toBe("low");
    expect(saved.next).toBe("wire assistant_call schema");
    expect(saved.ts).toBe(entry.ts);
  });

  test("lists newest entries and skips malformed lines", () => {
    const manager = new SyncManager(projectRoot);
    const contextDir = path.join(projectRoot, ".ufoo", "context");
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(
      path.join(contextDir, "sync.jsonl"),
      [
        '{"ts":"2026-02-12T10:00:00.000Z","type":"sync","from":"codex-1","for":"codex-3","message":"old"}',
        "not-json",
        '{"ts":"2026-02-12T10:05:00.000Z","type":"sync","from":"codex-2","for":"codex-3","message":"new"}',
      ].join("\n"),
      "utf8"
    );

    const listed = manager.list({ for: "codex-3", num: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0].message).toBe("new");
  });

  test("supports ctx sync write/list command path", async () => {
    await runCtxCommand(
      "sync",
      [
        "write",
        "--for",
        "codex-3",
        "--from",
        "codex-2",
        "--decision",
        "0072",
        "validated",
        "assistant",
        "integration",
      ],
      { cwd: projectRoot }
    );

    const syncFile = path.join(projectRoot, ".ufoo", "context", "sync.jsonl");
    const rows = fs.readFileSync(syncFile, "utf8").trim().split("\n");
    const row = JSON.parse(rows[0]);
    expect(row.for).toBe("codex-3");
    expect(row.from).toBe("codex-2");
    expect(row.decision).toBe("0072");
    expect(row.message).toBe("validated assistant integration");

    await runCtxCommand("sync", ["list", "-n", "1", "--for", "codex-3"], {
      cwd: projectRoot,
    });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("=== Sync (1 shown, 1 matched) ===")
    );
  });
});
