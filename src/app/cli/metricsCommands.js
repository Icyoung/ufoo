"use strict";

const fs = require("fs");
const { readAgentPerformance } = require("../../coordination/history/agentTrace");

const ratio = (n, d) => n != null && d ? n / d : null;
const display = value => value == null ? "unknown" : Number(value).toFixed(1);
const duration = value => value == null ? "unknown" : `${display(value)}ms`;
const percentage = value => value == null ? "unknown" : `${display(value * 100)}%`;

function comparePerformance(current, baseline) {
  if (baseline?.version !== 1 || !baseline.summary?.latency || !baseline.summary?.usage || !Number.isFinite(baseline.summary.runs)) {
    throw new Error("baseline must be a ufoo metrics --json report (version 1)");
  }
  const values = report => ({
    completedOfFinished: report.summary.completedOfFinished,
    modelCallsPerRun: ratio(report.summary.counts.modelCalls || 0, report.summary.runs),
    toolErrorsPerRun: ratio(report.summary.counts.toolErrors || 0, report.summary.runs),
    elapsedP50Ms: report.summary.latency.elapsedMs?.p50 ?? null,
    elapsedP95Ms: report.summary.latency.elapsedMs?.p95 ?? null,
    firstTextP50Ms: report.summary.latency.firstTextMs?.p50 ?? null,
    inputTokensPerObservedRun: report.coverage?.runsWithCompleteUsage === report.summary.runs ? ratio(report.summary.usage.input?.sum, report.summary.usage.input?.samples) : null,
    outputTokensPerObservedRun: report.coverage?.runsWithCompleteUsage === report.summary.runs ? ratio(report.summary.usage.output?.sum, report.summary.usage.output?.samples) : null,
    cacheHitRate: report.coverage?.runsWithCompleteCache === report.summary.runs ? report.summary.cache?.hitRate ?? null : null,
    acceptedOfReviewed: report.delegations?.acceptedOfReviewed ?? null,
  });
  const before = values(baseline), after = values(current);
  const metrics = Object.fromEntries(Object.keys(after).map(key => {
    const a = before[key], b = after[key];
    return [key, { before: a, after: b, delta: a == null || b == null ? null : b - a,
      changeRatio: a == null || b == null || a === 0 ? null : (b - a) / Math.abs(a) }];
  }));
  return { baselineRuns: baseline.summary.runs, currentRuns: current.summary.runs,
    incomplete: Boolean(current.incomplete || baseline.incomplete), metrics,
    note: "Observed samples may contain different tasks; these deltas are not a causal or quality verdict." };
}

function runMetricsCommand(taskId, options = {}) {
  const report = readAgentPerformance(options.project || process.cwd(), { task_id: options.task || taskId || "",
    agent_id: options.agent, session_id: options.session, since: options.since, until: options.until,
    provider: options.provider, model: options.model, limit: options.limit });
  if (options.baseline) {
    if (fs.statSync(options.baseline).size > 16 * 1024 * 1024) throw new Error("baseline exceeds 16 MiB");
    report.comparison = comparePerformance(report, JSON.parse(fs.readFileSync(options.baseline, "utf8")));
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    const summary = report.summary;
    console.log(`Agent performance: ${summary.runs} observed runs${report.incomplete ? " (partial evidence)" : ""}`);
    console.log(`Execution: ${summary.outcomes.completed} completed, ${summary.outcomes.failed} failed, ${summary.outcomes.cancelled} cancelled; completed/finished ${percentage(summary.completedOfFinished)}`);
    console.log(`Latency: p50 ${duration(summary.latency.elapsedMs.p50)}, p95 ${duration(summary.latency.elapsedMs.p95)}; first text p50 ${duration(summary.latency.firstTextMs.p50)} (${summary.latency.firstTextMs.samples} samples)`);
    console.log(`Models: ${summary.counts.modelCalls || 0} API attempts, ${summary.counts.sdkTurns || 0} SDK turns, ${summary.counts.modelFailures || 0} failures, ${summary.counts.modelRetries || 0} retries`);
    console.log(`Usage: input ${display(summary.usage.input.sum)}, output ${display(summary.usage.output.sum)}; compaction input ${display(summary.compactionUsage.input.sum)}, output ${display(summary.compactionUsage.output.sum)}`);
    console.log(`Cache: ${percentage(summary.cache.hitRate)} hit; read ${display(summary.cache.cachedTokens)}/${display(summary.cache.promptTokens)} prompt tokens, written ${display(summary.usage.cacheCreation.sum)} (${summary.cache.samples}/${summary.cache.usageSamples} usage samples)`);
    console.log(`Tools: ${summary.counts.toolCalls || 0} executed, ${summary.counts.toolErrors || 0} errors, ${summary.counts.toolRejections || 0} rejected, ${summary.counts.repeatedToolCalls || 0} repeated arguments`);
    console.log(`Delegation: ${report.delegations.accepted} accepted, ${report.delegations.rejected} rejected, ${report.delegations.awaitingAcceptance} awaiting acceptance`);
    for (const cohort of report.cohorts) console.log(`  ${cohort.provider}/${cohort.model} ${cohort.thinkingLevel} ${cohort.executionKind} ${cohort.requestKind} v${cohort.runtimeVersion} engine=${cohort.engineFingerprint.slice(0, 8)}: ${cohort.runs} runs, p50 ${duration(cohort.latency.elapsedMs.p50)}, cache ${percentage(cohort.cache.hitRate)}`);
    if (report.comparison) {
      for (const [name, value] of Object.entries(report.comparison.metrics)) console.log(`  ${name}: ${display(value.before)} -> ${display(value.after)} (delta ${display(value.delta)})`);
      console.log(report.comparison.note);
    }
    if (report.warnings.length) console.log(`Warnings: ${report.warnings.map(w => w.code).join(", ")}; --json includes source details`);
    console.log(`Configuration coverage: ${report.coverage.runsWithConfiguration}/${summary.runs}; complete usage coverage: ${report.coverage.runsWithCompleteUsage}/${summary.runs}; complete cache coverage: ${report.coverage.runsWithCompleteCache}/${summary.runs}`);
  }
  return report;
}

module.exports = { runMetricsCommand, comparePerformance };
