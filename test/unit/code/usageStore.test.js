const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getUsageFilePath,
  appendUsageRecord,
  summarizeSessionUsage,
  formatSessionUsageStatus,
} = require("../../../src/code/usageStore");
const { runSingleCommand } = require("../../../src/code/repl");

describe("ucode usage store", () => {
  let workspaceRoot = "";

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-usage-store-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("appendUsageRecord writes one jsonl row with all fields", () => {
    const outcome = appendUsageRecord(workspaceRoot, {
      sessionId: "sess-1",
      model: "gpt-test",
      provider: "openai",
      turns: 2,
      input: 130,
      output: 25,
      cacheRead: 30,
      cacheCreation: 0,
    });

    expect(outcome.ok).toBe(true);
    const filePath = getUsageFilePath(workspaceRoot);
    expect(outcome.filePath).toBe(filePath);
    expect(filePath.endsWith(path.join(".ufoo", "agent", "ucode", "usage.jsonl"))).toBe(true);

    const rows = fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "sess-1",
      model: "gpt-test",
      provider: "openai",
      turns: 2,
      input: 130,
      output: 25,
      cacheRead: 30,
      cacheCreation: 0,
    });
    expect(typeof rows[0].ts).toBe("string");
    expect(rows[0].ts).not.toBe("");
  });

  test("appendUsageRecord stays silent when the write fails", () => {
    // A file where a directory should be makes mkdir/append fail with ENOTDIR.
    const fileRoot = path.join(workspaceRoot, "not-a-dir");
    fs.writeFileSync(fileRoot, "x", "utf8");

    let outcome;
    expect(() => {
      outcome = appendUsageRecord(fileRoot, { sessionId: "sess-1", input: 1 });
    }).not.toThrow();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).not.toBe("");
  });

  test("summarizeSessionUsage aggregates rows for one session only", () => {
    appendUsageRecord(workspaceRoot, {
      sessionId: "sess-a",
      turns: 1,
      input: 100,
      output: 10,
      cacheRead: 20,
      cacheCreation: 5,
    });
    appendUsageRecord(workspaceRoot, {
      sessionId: "sess-a",
      turns: 2,
      input: 200,
      output: 30,
      cacheRead: 60,
      cacheCreation: 15,
    });
    appendUsageRecord(workspaceRoot, {
      sessionId: "sess-b",
      turns: 9,
      input: 999,
      output: 99,
      cacheRead: 9,
      cacheCreation: 9,
    });

    const summary = summarizeSessionUsage({ workspaceRoot, sessionId: "sess-a" });
    expect(summary).toEqual({
      records: 2,
      turns: 3,
      input: 300,
      output: 40,
      cacheRead: 80,
      cacheCreation: 20,
    });

    const empty = summarizeSessionUsage({ workspaceRoot, sessionId: "sess-missing" });
    expect(empty.records).toBe(0);
    expect(empty.input).toBe(0);
  });

  test("summarizeSessionUsage tolerates a missing file and corrupt lines", () => {
    expect(summarizeSessionUsage({ workspaceRoot, sessionId: "sess-a" }).records).toBe(0);

    const filePath = getUsageFilePath(workspaceRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "not-json\n", "utf8");
    appendUsageRecord(workspaceRoot, { sessionId: "sess-a", input: 3 });
    const summary = summarizeSessionUsage({ workspaceRoot, sessionId: "sess-a" });
    expect(summary.records).toBe(1);
    expect(summary.input).toBe(3);
  });
});

describe("ucode repl status command", () => {
  test("runSingleCommand parses status command variants", () => {
    expect(runSingleCommand("status", process.cwd())).toEqual({ kind: "status" });
    expect(runSingleCommand("/status", process.cwd())).toEqual({ kind: "status" });
  });

  test("help output lists the status command", () => {
    const result = runSingleCommand("help", process.cwd());
    expect(result.kind).toBe("help");
    expect(result.output).toContain("/status");
  });

  test("formatSessionUsageStatus shows totals and the cache hit rate", () => {
    const output = formatSessionUsageStatus({
      input: 100,
      output: 25,
      cacheRead: 300,
      cacheCreation: 50,
    });
    expect(output).toContain("input=100");
    expect(output).toContain("output=25");
    expect(output).toContain("cache_read=300");
    expect(output).toContain("cache_creation=50");
    // 300 / (300 + 100) = 75%
    expect(output).toContain("75.0%");
  });

  test("formatSessionUsageStatus handles an empty summary", () => {
    const output = formatSessionUsageStatus({});
    expect(output).toContain("input=0");
    expect(output).toContain("0.0%");
  });
});
