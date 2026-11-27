"use strict";

/**
 * Translates Agent Client Protocol (ACP) `session/update` notifications into
 * ufoo's normalized internal thread event stream (`text_delta`, `thinking_delta`,
 * `tool_call`, `tool_result`, `plan`).
 */

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  if (typeof content.text === "string") return content.text;
  if (typeof content.output === "string") return content.output;
  if (Array.isArray(content)) {
    return content.map(extractContentText).filter(Boolean).join("\n");
  }
  if (content.content) return extractContentText(content.content);
  return "";
}

function normalizeAcpToolArgs(update = {}, name = "") {
  const rawInput = update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
    ? { ...update.rawInput }
    : {};
  if (Array.isArray(update.locations) && update.locations.length > 0 && !rawInput.locations) {
    rawInput.locations = update.locations;
  }
  // Normalize PascalCase parameter names used by Antigravity / ACP built-in tools
  if (!rawInput.command && typeof rawInput.CommandLine === "string") {
    rawInput.command = rawInput.CommandLine;
  }
  if (!rawInput.path) {
    const candidatePath = rawInput.TargetFile
      || rawInput.AbsolutePath
      || rawInput.Path
      || rawInput.DirectoryPath
      || rawInput.SearchPath
      || (Array.isArray(update.locations) && update.locations[0]?.path)
      || "";
    if (typeof candidatePath === "string" && candidatePath.trim()) {
      rawInput.path = candidatePath.trim();
    }
  }
  if (!rawInput.query && typeof (rawInput.Query || rawInput.Pattern) === "string") {
    rawInput.query = rawInput.Query || rawInput.Pattern;
  }
  if (
    update.title
    && String(update.title).trim() !== String(name).trim()
    && !rawInput.command
    && !rawInput.path
    && !rawInput.query
    && !rawInput.title
  ) {
    rawInput.title = String(update.title).trim();
  }
  return rawInput;
}

function normalizeAcpUsage(usage = null) {
  if (!usage || typeof usage !== "object") return null;
  const toInt = (val) => {
    const n = Number(val);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  const inputTokens = toInt(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.input);
  const outputTokens = toInt(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.output);
  const cacheRead = toInt(
    usage.cache_read_tokens
      ?? usage.cachedReadTokens
      ?? usage.cache_read_input_tokens
      ?? usage.cached_input_tokens
      ?? usage.cacheRead
  );
  const cacheCreate = toInt(
    usage.cache_creation_tokens
      ?? usage.cachedWriteTokens
      ?? usage.cache_creation_input_tokens
      ?? usage.cacheCreation
  );
  const thinkingTokens = toInt(usage.thinking_tokens ?? usage.thoughtTokens ?? usage.reasoning_tokens);
  const totalTokens = toInt(usage.total_tokens ?? usage.totalTokens);
  const contextWindow = toInt(usage.context_window ?? usage.contextWindow ?? usage.size);

  const normalized = {};
  if (inputTokens !== undefined) normalized.input_tokens = inputTokens;
  if (outputTokens !== undefined) normalized.output_tokens = outputTokens;
  if (cacheRead !== undefined) normalized.cache_read_tokens = cacheRead;
  if (cacheCreate !== undefined) normalized.cache_creation_tokens = cacheCreate;
  if (thinkingTokens !== undefined) normalized.thinking_tokens = thinkingTokens;
  if (totalTokens !== undefined) normalized.total_tokens = totalTokens;
  if (contextWindow !== undefined && contextWindow > 0) normalized.context_window = contextWindow;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function translateAcpSessionUpdate(params = {}) {
  const update = params.update && typeof params.update === "object" ? params.update : params;
  const kind = String(update.sessionUpdate || update.type || "").trim();
  const events = [];

  if (kind === "agent_message_chunk") {
    const delta = extractContentText(update.content ?? update.text ?? update.delta);
    if (delta) {
      events.push({ type: "text_delta", delta });
    }
    return events;
  }

  if (kind === "agent_thought_chunk") {
    const delta = extractContentText(update.content ?? update.text ?? update.delta);
    if (delta) {
      events.push({ type: "thinking_delta", delta });
    }
    return events;
  }

  if (kind === "tool_call") {
    const toolCallId = String(update.toolCallId || update.id || `acp-tool-${Date.now()}`);
    const name = String(update.name || update.title || update.kind || "tool");
    const args = normalizeAcpToolArgs(update, name);
    events.push({
      type: "tool_call",
      toolCallId,
      name,
      ...(update.title && String(update.title).trim() !== name ? { title: String(update.title).trim() } : {}),
      args,
    });
    return events;
  }

  if (kind === "tool_call_update") {
    const toolCallId = String(update.toolCallId || update.id || "");
    const status = String(update.status || "").trim().toLowerCase();
    if (status === "completed" || status === "failed" || status === "cancelled") {
      const output = extractContentText(update.rawOutput ?? update.content)
        || (update.rawOutput && typeof update.rawOutput === "object" ? JSON.stringify(update.rawOutput) : "");
      const rawExit = update.rawOutput && typeof update.rawOutput === "object"
        ? (update.rawOutput.exit_code ?? update.rawOutput.exitCode)
        : undefined;
      const exitCode = Number.isFinite(Number(rawExit)) ? Number(rawExit) : undefined;
      events.push({
        type: "tool_result",
        toolCallId,
        output,
        ...(exitCode !== undefined ? { exitCode } : {}),
        is_error: status === "failed" || status === "cancelled" || (exitCode !== undefined && exitCode !== 0),
      });
    } else if (update.title || update.status) {
      events.push({
        type: "phase",
        phase: {
          type: "tool_progress",
          toolCallId,
          title: String(update.title || ""),
          status: status || "in_progress",
        },
      });
    }
    return events;
  }

  if (kind === "usage_update") {
    const used = Number(update.used);
    const size = Number(update.size);
    if (Number.isFinite(used) && used >= 0) {
      events.push({
        type: "usage",
        usage: {
          input_tokens: Math.floor(used),
          total_tokens: Math.floor(used),
          ...(Number.isFinite(size) && size > 0 ? { context_window: Math.floor(size) } : {}),
        },
      });
    }
    return events;
  }

  if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
    events.push({
      type: "config_options",
      configOptions: update.configOptions,
    });
    return events;
  }

  if (kind === "plan" && Array.isArray(update.entries)) {
    events.push({
      type: "plan",
      entries: update.entries.map((entry) => ({
        content: String(entry.content || entry.title || ""),
        status: String(entry.status || "pending"),
        priority: String(entry.priority || "medium"),
      })),
    });
    return events;
  }

  return events;
}

module.exports = {
  extractContentText,
  normalizeAcpToolArgs,
  normalizeAcpUsage,
  translateAcpSessionUpdate,
};
