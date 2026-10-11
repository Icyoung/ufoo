"use strict";

const fs = require("fs"), os = require("os"), path = require("path");
const { runMetricsCommand, comparePerformance } = require("../../../src/app/cli/metricsCommands");
const { summarizeAgentPerformance } = require("../../../src/coordination/history/agentPerformance");
const metricsTool = require("../../../src/tools/tier0/readAgentMetrics");

describe("offline performance queries", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-metrics-test-")); jest.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  test("CLI and MCP share read-only metrics without initializing a missing project", () => {
    const report = runMetricsCommand("", { project: root, json: true });
    expect(JSON.parse(console.log.mock.calls[0][0])).toMatchObject({ summary: { runs: 0 } });
    expect(metricsTool.handler({ projectRoot: root }, {}).summary).toEqual(report.summary);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(metricsTool.handler({ projectRoot: root }, { until: "invalid" })).toMatchObject({ ok: false, code: "invalid_arguments" });
  });
  test("baseline comparisons retain unknowns and flag incomplete samples", () => {
    const before = summarizeAgentPerformance([]);
    const after = summarizeAgentPerformance([{ type: "task.started", taskRunId: "run", time: "2026-10-11T00:00:00Z" },
      { type: "task.completed", taskRunId: "run", time: "2026-10-11T00:00:01Z" }], [], [], { warnings: [{ code: "source_tail_truncated" }] });
    const result = comparePerformance(after, before);
    expect(result.incomplete).toBe(true);
    expect(result.metrics.elapsedP50Ms).toEqual({ before: null, after: 1000, delta: null, changeRatio: null });
    expect(result.metrics.inputTokensPerObservedRun.after).toBeNull();
    expect(() => comparePerformance(after, {})).toThrow("baseline must");
    const baseline = path.join(root, "baseline.json");
    fs.writeFileSync(baseline, JSON.stringify(before));
    expect(runMetricsCommand("", { project: root, baseline, json: true }).comparison.baselineRuns).toBe(0);
  });
  test("shows cache hits in CLI and compares only complete paired usage", () => {
    const journal = path.join(root, ".ufoo/agent/main/runtimes/main/events.jsonl");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    const events = [{ type: "task.started", taskRunId: "run", time: "2026-10-11T00:00:00Z" },
      { type: "model.started", taskRunId: "run", time: "2026-10-11T00:00:00Z" },
      { type: "model.completed", taskRunId: "run", time: "2026-10-11T00:00:01Z", usage: { input: 1000, cacheRead: 800, inputIncludesCache: true } },
      { type: "task.completed", taskRunId: "run", time: "2026-10-11T00:00:01Z" }];
    fs.writeFileSync(journal, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const report = runMetricsCommand("", { project: root });
    expect(console.log.mock.calls.flat().join("\n")).toContain("Cache: 80.0% hit");
    expect(metricsTool.handler({ projectRoot: root }, {}).summary.cache).toEqual(report.summary.cache);
    expect(comparePerformance(report, report).metrics.cacheHitRate).toMatchObject({ before: 0.8, after: 0.8, delta: 0 });
    expect(comparePerformance({ ...report, coverage: { ...report.coverage, runsWithCompleteCache: 0 } }, report).metrics.cacheHitRate.after).toBeNull();
  });
});
