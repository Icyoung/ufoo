"use strict";

function formatToolDistribution(items = []) {
  const tools = Array.isArray(items) ? items : [];
  if (tools.length === 0) return "";
  const visible = tools.slice(0, 2).map((item) => `${item.name}x${item.count}`);
  if (tools.length > 2) {
    visible.push(`+${tools.length - 2}`);
  }
  return visible.join(",");
}

function formatLoopSummary(loopSummary) {
  if (!loopSummary || typeof loopSummary !== "object") return "";
  const rounds = Number(loopSummary.rounds) || 0;
  const toolCalls = Number(loopSummary.tool_calls) || 0;
  const totalTokens = Number(loopSummary.total_tokens) || 0;
  const inputTokens = Number(loopSummary.input_tokens) || 0;
  const cacheReadTokens = Number(loopSummary.cache_read_tokens) || 0;
  const cacheCreationTokens = Number(loopSummary.cache_creation_tokens) || 0;
  const terminalReason = String(loopSummary.terminal_reason || "").trim();
  const toolDistribution = formatToolDistribution(loopSummary.tools);

  if (rounds <= 0 && toolCalls <= 0 && totalTokens <= 0 && !terminalReason && !toolDistribution) {
    return "";
  }

  const parts = [
    `r${rounds}`,
    `tc${toolCalls}`,
    `tok${totalTokens}`,
  ];
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    let cachePart = `cache${cacheReadTokens}/${cacheCreationTokens}`;
    if (cacheReadTokens > 0) {
      const hitRate = Math.round((cacheReadTokens / (cacheReadTokens + inputTokens)) * 100);
      cachePart += `(${hitRate}%)`;
    }
    parts.push(cachePart);
  }
  if (toolDistribution) {
    parts.push(toolDistribution);
  }
  if (terminalReason) {
    parts.push(terminalReason);
  }
  return parts.join(" ");
}

module.exports = { formatLoopSummary };
