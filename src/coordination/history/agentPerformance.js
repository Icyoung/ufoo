"use strict";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const number = value => value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const difference = (end, start) => end !== null && start !== null && end >= start ? end - start : null;
const rate = (a, b) => b ? a / b : null;

function distribution(values) {
  const sorted = values.filter(value => value !== null && Number.isFinite(value)).sort((a, b) => a - b);
  const percentile = fraction => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { samples: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const value = { input: number(usage.input ?? usage.input_tokens ?? usage.prompt_tokens),
    output: number(usage.output ?? usage.output_tokens ?? usage.completion_tokens),
    cacheRead: number(usage.cacheRead ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens
      ?? usage.input_tokens_details?.cached_tokens ?? usage.input_token_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    cacheCreation: number(usage.cacheCreation ?? usage.cache_creation_tokens ?? usage.cache_creation_input_tokens
      ?? usage.input_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_write_tokens) };
  if (!Object.values(value).some(v => v !== null)) return null;
  value.inputIncludesCache = typeof usage.inputIncludesCache === "boolean" ? usage.inputIncludesCache
    : usage.prompt_tokens != null || usage.input_tokens_details || usage.input_token_details || usage.cached_input_tokens != null ? true
    : usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null ? false : null;
  return value;
}

function cacheObservation(samples, configuration, provider) {
  const transport = configuration?.transport || "";
  const includesCache = transport.startsWith("openai") ? true : transport.startsWith("anthropic") ? false
    : ["openai", "codex", "codex-cli", "kimi", "grok", "grok-build"].includes(provider) ? true
    : ["claude", "claude-code", "anthropic"].includes(provider) ? false : null;
  const pairs = samples.flatMap(usage => {
    if (usage.input === null || usage.cacheRead === null) return [];
    const inclusive = usage.inputIncludesCache ?? includesCache;
    if (inclusive === null || !inclusive && usage.cacheCreation === null) return [];
    const prompt = inclusive ? usage.input : usage.input + usage.cacheRead + usage.cacheCreation;
    return usage.cacheRead <= prompt ? [{ cached: usage.cacheRead, prompt }] : [];
  });
  const cachedTokens = pairs.length ? pairs.reduce((sum, pair) => sum + pair.cached, 0) : null;
  const promptTokens = pairs.length ? pairs.reduce((sum, pair) => sum + pair.prompt, 0) : null;
  return { samples: pairs.length, usageSamples: samples.length, cachedTokens, promptTokens, hitRate: rate(cachedTokens, promptTokens) };
}

function aggregateCache(runs, scope) {
  const sum = key => {
    const values = runs.map(run => run[scope][key]).filter(value => value !== null);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const cachedTokens = sum("cachedTokens"), promptTokens = sum("promptTokens");
  return { samples: sum("samples") || 0, usageSamples: sum("usageSamples") || 0,
    cachedTokens, promptTokens, hitRate: rate(cachedTokens, promptTokens) };
}

function aggregate(runs) {
  const outcomes = Object.fromEntries(["completed", "failed", "cancelled", "interrupted", "running", "waiting_user", "queued", "unknown"].map(key => [key, runs.filter(r => r.status === key).length]));
  const finished = Object.entries(outcomes).filter(([key]) => terminal.has(key)).reduce((sum, [, count]) => sum + count, 0);
  const counts = {};
  for (const run of runs) for (const [key, value] of Object.entries(run.counts)) counts[key] = (counts[key] || 0) + value;
  const latency = {};
  for (const key of ["elapsedMs", "activeMs", "queueMs", "firstTextMs", "firstThinkingMs", "modelMs", "toolMs", "compactionMs", "waitingUserMs", "idleMs"]) latency[key] = distribution(runs.map(r => r.timings[key]));
  const tokenTotals = {};
  for (const scope of ["usage", "compactionUsage"]) {
    tokenTotals[scope] = {};
    for (const key of ["input", "output", "cacheRead", "cacheCreation"]) {
      const observed = runs.map(r => r[scope][key]).filter(v => v !== null);
      tokenTotals[scope][key] = { samples: observed.length, sum: observed.length ? observed.reduce((a, b) => a + b, 0) : null };
    }
  }
  return { runs: runs.length, outcomes, completedOfFinished: rate(outcomes.completed, finished), finished,
    counts, latency, ...tokenTotals, finalTextCharacters: distribution(runs.map(r => r.finalTextCharacters)),
    cache: aggregateCache(runs, "cache"), compactionCache: aggregateCache(runs, "compactionCache"),
    signals: Object.fromEntries([...new Set(runs.flatMap(r => r.signals))].map(key => [key, runs.filter(r => r.signals.includes(key)).length])) };
}

/** Derived observations, never a quality grade or lifecycle authority. */
function summarizeAgentPerformance(events, tasks = [], queues = [], options = {}) {
  const now = options.now ?? Date.now();
  const parseBound = key => {
    if (!options[key]) return null;
    const parsed = time(options[key]);
    if (parsed === null) throw new Error(`${key} must be an ISO timestamp`);
    return parsed;
  };
  const since = parseBound("since"), until = parseBound("until");
  if (since !== null && until !== null && since > until) throw new Error("since must not be after until");
  const runs = new Map();
  const reportsByTask = new Map();
  const enqueuedBySequence = new Map();
  for (const event of events.filter(e => e.type === "queue.enqueued")) enqueuedBySequence.set(`${event.agentId}:${event.busSequence}`, time(event.time));
  for (const event of events.filter(e => e.type?.startsWith("report."))) {
    const key = `${event.taskId}:${event.agentId}`;
    if (!reportsByTask.has(key)) reportsByTask.set(key, []);
    reportsByTask.get(key).push(event);
  }
  let uncorrelatedEvents = 0;
  for (const event of events) {
    const type = event.type || "";
    if (!/^(?:task\.|request.accepted|run.config|model\.|tool\.|message.delta|thinking.delta|context.compaction|loop\.|interaction\.)/.test(type)) continue;
    if (!event.taskRunId) { uncorrelatedEvents += 1; continue; }
    let run = runs.get(event.taskRunId);
    if (!run) {
      run = { taskRunId: event.taskRunId, taskId: event.taskId || event.taskRunId, agentId: event.agentId || "", sessionId: event.sessionId || "",
        parentTaskRunId: event.parentTaskRunId || null, traceId: event.traceId || null, status: "unknown", configuration: null,
        accepted: null, enqueued: null, started: null, ended: null, lastActivity: null, firstText: null, firstThinking: null,
        activeStart: null, pausedAt: null, activeMs: 0, waitingUserMs: 0, attempts: new Set(), tools: new Map(),
        usageSamples: [], modelOutcomes: 0, compactionUsageSamples: [], terminalUsage: null, finalTextCharacters: null, streamedCharacters: 0,
        counts: { modelCalls: 0, sdkTurns: 0, modelFailures: 0, toolCalls: 0, toolErrors: 0, toolExceptions: 0, toolRejections: 0, unresolvedTools: 0,
          repeatedToolCalls: 0, loopWarnings: 0, loopStops: 0, modelRetries: 0, compactionAttempts: 0, compactions: 0, compactionFailures: 0 },
        modelDurations: [], modelStarts: new Map(), toolDurations: [], compactionDurations: [], fingerprints: new Map(), errorCodes: {} };
      runs.set(event.taskRunId, run);
    }
    run.agentId ||= event.agentId || "";
    run.sessionId ||= event.sessionId || "";
    const timestamp = time(event.time);
    if (timestamp !== null) run.lastActivity = Math.max(run.lastActivity ?? timestamp, timestamp);
    if (event.attemptId) run.attempts.add(event.attemptId);
    if (type === "run.config") run.configuration = event.configuration || null;
    if (type === "request.accepted") { run.accepted ??= timestamp; if (run.started === null) run.status = "queued"; }
    if (type === "task.started") {
      run.started ??= timestamp;
      if (event.queueSequence != null) run.enqueued ??= enqueuedBySequence.get(`${run.agentId}:${event.queueSequence}`) ?? null;
      // SDK/native presentation can repeat the same committed lifecycle.
      if (run.activeStart === null) run.activeStart = timestamp;
      if (run.pausedAt !== null) { run.waitingUserMs += difference(timestamp, run.pausedAt) || 0; run.pausedAt = null; }
      run.status = "running";
    }
    if (type === "task.paused" || /^task\.(completed|failed|cancelled|interrupted)$/.test(type)) {
      if (run.activeStart !== null) { run.activeMs += difference(timestamp, run.activeStart) || 0; run.activeStart = null; }
      run.status = type === "task.paused" ? "waiting_user" : type.slice(5);
      if (type === "task.paused") run.pausedAt ??= timestamp;
      else run.ended = timestamp;
      run.terminalUsage = normalizedUsage(event.usage) || run.terminalUsage;
      if (number(event.finalTextCharacters) !== null) run.finalTextCharacters = event.finalTextCharacters;
    }
    if (type === "message.delta" && event.textCharacters > 0) { run.firstText ??= timestamp; run.streamedCharacters += event.textCharacters; }
    if (type === "thinking.delta" && event.textCharacters > 0) run.firstThinking ??= timestamp;
    if (type === "model.started") {
      run.counts[event.modelScope === "sdk-turn" ? "sdkTurns" : "modelCalls"] += 1;
      run.provider ||= event.provider || ""; run.model ||= event.model || "";
      run.modelStarts.set(event.turnId || event.modelScope || "api-call", timestamp);
    }
    if (["model.completed", "model.failed"].includes(type)) {
      run.modelOutcomes += 1;
      const key = event.turnId || event.modelScope || "api-call";
      const duration = number(event.durationMs) ?? difference(timestamp, run.modelStarts.get(key) ?? null);
      if (duration !== null) run.modelDurations.push(duration);
      run.modelStarts.delete(key);
      if (type === "model.failed") run.counts.modelFailures += 1;
      else { const usage = normalizedUsage(event.usage); if (usage) run.usageSamples.push(usage); }
    }
    if (type === "model.retry") run.counts.modelRetries += 1;
    if (type === "loop.warning") run.counts.loopWarnings += 1;
    if (type === "loop.stopped") run.counts.loopStops += 1;
    if (["tool.started", "tool.completed", "tool.failed", "tool.rejected"].includes(type)) {
      const id = event.toolCallId || event.id;
      const tool = run.tools.get(id) || { started: false, ended: false, outcome: null, startedAt: null, name: event.toolName || "" };
      tool.name ||= event.toolName || "";
      if (type === "tool.started" && !tool.started) {
        tool.started = true; tool.startedAt = timestamp; run.counts.toolCalls += 1;
        if (event.argumentFingerprint) {
          const key = `${tool.name}:${event.argumentFingerprint}`;
          if (run.fingerprints.has(key)) run.counts.repeatedToolCalls += 1;
          run.fingerprints.set(key, (run.fingerprints.get(key) || 0) + 1);
        }
      } else if (type !== "tool.started" && !tool.ended) {
        tool.ended = true;
        tool.outcome = type === "tool.failed" ? "unknown" : type === "tool.rejected" ? "rejected" : event.ok === false ? "error" : "ok";
        if (tool.outcome === "error") run.counts.toolErrors += 1;
        if (type === "tool.failed") run.counts.toolExceptions += 1;
        if (tool.outcome === "rejected") run.counts.toolRejections += 1;
        const duration = number(event.durationMs) ?? difference(timestamp, tool.startedAt);
        if (duration !== null) run.toolDurations.push(duration);
      }
      run.tools.set(id, tool);
    }
    if (type === "context.compaction.started") run.counts.compactionAttempts += 1;
    if (type === "context.compaction.completed") {
      run.counts.compactions += 1;
      const usage = normalizedUsage(event.usage);
      if (usage) run.compactionUsageSamples.push(usage);
    }
    if (type === "context.compaction.failed") run.counts.compactionFailures += 1;
    if (["context.compaction.completed", "context.compaction.failed"].includes(type) && number(event.durationMs) !== null) run.compactionDurations.push(event.durationMs);
    const code = event.code || event.resultCode;
    if (code && (type.endsWith("failed") || type === "tool.rejected" || type === "model.retry" || event.ok === false)) run.errorCodes[code] = (run.errorCodes[code] || 0) + 1;
  }
  const rows = [];
  for (const run of runs.values()) {
    const anchor = run.started ?? run.accepted ?? run.lastActivity;
    const config = run.configuration;
    const provider = config?.provider || run.provider || "unknown", model = config?.model || run.model || "unknown";
    if (since !== null && (anchor === null || anchor < since) || until !== null && (anchor === null || anchor >= until)) continue;
    if (options.provider && provider !== options.provider || options.model && model !== options.model) continue;
    const end = run.ended ?? now;
    const paired = [...run.tools.values()];
    run.counts.unresolvedTools = paired.filter(t => !t.ended || t.outcome === "unknown").length;
    const modelStarts = run.counts.modelCalls + run.counts.sdkTurns;
    // Terminal native usage is an accumulator with zero defaults. Do not use
    // it to invent token counts when observed model calls omitted usage.
    const usage = run.usageSamples.length ? run.usageSamples : !modelStarts && !run.modelOutcomes && run.terminalUsage ? [run.terminalUsage] : [];
    const cache = cacheObservation(usage, config, provider);
    const usageComplete = modelStarts ? run.usageSamples.length === modelStarts : !run.modelOutcomes && usage.length > 0;
    const sumUsage = samples => Object.fromEntries(["input", "output", "cacheRead", "cacheCreation"].map(key => {
      const values = samples.map(u => u[key]).filter(v => v !== null);
      return [key, values.length ? values.reduce((a, b) => a + b, 0) : null];
    }));
    const signals = [];
    if (run.counts.toolErrors) signals.push("tool_errors");
    if (run.counts.unresolvedTools) signals.push("unresolved_tools");
    if (run.counts.toolRejections) signals.push("rejected_tool_calls");
    if (run.counts.repeatedToolCalls) signals.push("repeated_tool_arguments");
    if (run.counts.loopStops) signals.push("loop_guard_stopped");
    if (run.counts.compactionFailures) signals.push("compaction_failed");
    const idleMs = terminal.has(run.status) ? null : difference(now, run.lastActivity);
    if (run.status === "running" && idleMs > (options.idleThresholdMs || 300000)) signals.push("running_without_recent_events");
    const reports = reportsByTask.get(`${run.taskId}:${run.agentId}`) || [];
    const reportLengths = reports.map(r => number(r.reportCharacters)).filter(v => v !== null);
    if (reportLengths.some(value => value > 600)) signals.push("long_report");
    const lifecycleComplete = run.started !== null && (terminal.has(run.status) ? run.ended !== null : true);
    const durations = values => values.length ? values.reduce((a, b) => a + b, 0) : null;
    rows.push({ taskRunId: run.taskRunId, taskId: run.taskId, agentId: run.agentId, sessionId: run.sessionId,
      parentTaskRunId: run.parentTaskRunId, traceId: run.traceId, status: run.status, provider, model,
      startedAt: run.started !== null ? new Date(run.started).toISOString() : null,
      endedAt: run.ended !== null ? new Date(run.ended).toISOString() : null,
      configuration: config, attempts: run.attempts.size || null, counts: run.counts, usage: sumUsage(usage), compactionUsage: sumUsage(run.compactionUsageSamples),
      cache, compactionCache: cacheObservation(run.compactionUsageSamples, config, provider),
      queueTimingSource: run.enqueued !== null ? "bus.sequence" : run.accepted !== null ? "request.accepted" : "unknown",
      finalTextCharacters: run.finalTextCharacters, streamedCharacters: run.streamedCharacters,
      reportCharacters: distribution(reportLengths), errorCodes: run.errorCodes, signals,
      coverage: { configuration: Boolean(config), lifecycle: lifecycleComplete, usage: usage.length > 0,
        usageComplete, cache: cache.samples > 0, cacheComplete: usageComplete && cache.samples === usage.length,
        toolFingerprints: run.counts.toolCalls ? [...run.fingerprints.values()].reduce((a, b) => a + b, 0) : 0 },
      timings: { elapsedMs: lifecycleComplete ? difference(end, run.started) : null,
        activeMs: lifecycleComplete ? run.activeMs + (run.activeStart !== null ? difference(end, run.activeStart) || 0 : 0) : null,
        queueMs: difference(run.started, run.enqueued ?? run.accepted), firstTextMs: difference(run.firstText, run.started),
        firstThinkingMs: difference(run.firstThinking, run.started), modelMs: durations(run.modelDurations), toolMs: durations(run.toolDurations),
        compactionMs: durations(run.compactionDurations), waitingUserMs: run.waitingUserMs + (run.pausedAt !== null ? difference(end, run.pausedAt) || 0 : 0), idleMs } });
  }
  rows.sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")) || a.taskRunId.localeCompare(b.taskRunId));
  const groups = new Map();
  for (const run of rows) {
    const cohort = { provider: run.provider, model: run.model, thinkingLevel: run.configuration?.thinkingLevel || "unknown",
      engineFingerprint: run.configuration?.engineFingerprint || "unknown",
      requestKind: run.configuration?.requestKind || "unknown",
      runtimeVersion: run.configuration?.runtimeVersion || "unknown", executionKind: run.configuration?.executionKind || (run.counts.sdkTurns ? "sdk" : "native") };
    const key = JSON.stringify(cohort);
    if (!groups.has(key)) groups.set(key, { cohort, runs: [] });
    groups.get(key).runs.push(run);
  }
  const taskIds = new Set(rows.flatMap(run => [run.taskId, run.taskRunId]));
  const selectedTasks = tasks.filter(task => (since === null && until === null && !options.provider && !options.model) || [task.taskId, task.taskRunId, task.id].some(id => id && taskIds.has(id)));
  const delegated = selectedTasks.filter(task => task.taskId && task.workerId);
  const accepted = delegated.filter(t => t.status === "accepted").length, rejected = delegated.filter(t => t.status === "rejected").length;
  const reported = delegated.filter(t => ["done", "error"].includes(t.report?.phase)).length;
  const warnings = [...(options.warnings || [])];
  if (groups.size > 100) warnings.push({ code: "performance_cohort_limit", total: groups.size, read: 100 });
  if (uncorrelatedEvents) warnings.push({ code: "performance_uncorrelated_events", count: uncorrelatedEvents });
  const partialRuns = rows.filter(r => !r.coverage.lifecycle).length;
  if (partialRuns) warnings.push({ code: "performance_partial_lifecycle", count: partialRuns });
  const limit = options.includeRuns === false ? 0 : Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 20)));
  return { version: 1, generatedAt: new Date(now).toISOString(), window: { since: options.since || null, until: options.until || null, selection: "run-start; until exclusive" },
    summary: aggregate(rows), cohorts: [...groups.values()].sort((a, b) => b.runs.length - a.runs.length).slice(0, 100).map(g => ({ ...g.cohort, ...aggregate(g.runs) })),
    delegations: { tasks: delegated.length, accepted, rejected, reported, awaitingAcceptance: delegated.filter(t => t.status === "reported").length,
      failed: delegated.filter(t => t.status === "failed").length, deliveryUncertain: delegated.filter(t => t.status === "delivery_uncertain").length,
      acceptedOfReviewed: rate(accepted, accepted + rejected), acceptedOfReported: rate(accepted, reported),
      reportToAcceptanceMs: distribution(delegated.map(task => difference(time(task.acceptance?.time), time(task.report?.ts)))) },
    queues: queues.map(q => ({ ...q, ageMs: difference(now, time(q.enqueuedAt)) })).slice(-100),
    coverage: { runsWithConfiguration: rows.filter(r => r.coverage.configuration).length, runsWithUsage: rows.filter(r => r.coverage.usage).length,
      runsWithCompleteUsage: rows.filter(r => r.coverage.usageComplete).length,
      runsWithCache: rows.filter(r => r.coverage.cache).length, runsWithCompleteCache: rows.filter(r => r.coverage.cacheComplete).length,
      partialRuns, uncorrelatedEvents, retainedRuns: Math.min(rows.length, limit), runLimit: limit },
    runs: limit ? rows.slice(-limit) : [], incomplete: warnings.length > 0, warnings };
}

module.exports = { summarizeAgentPerformance, distribution };
