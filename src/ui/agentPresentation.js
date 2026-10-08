"use strict";

// Shared presentation adapters: standalone ucode and embedded SDK/native agents.
const fmt = require("./format");
const { buildContextMeter } = require("../agents/runtime/context/contextWindow");

function toolStatus(name = "tool") {
  const aliases = { Read: "read", Write: "write", Edit: "edit", Bash: "bash", TodoWrite: "plan_graph", plan: "plan_graph" };
  const key = aliases[name] || String(name).toLowerCase();
  return `${fmt.TOOL_LABELS[key] || `Calling ${name}`}…`;
}

function statusForAgentPhase(event = {}) {
  switch (event.type) {
    case "request_start": case "requesting": return "Waiting for model…";
    case "thinking": return "Thinking…";
    case "text_delta": return "Generating response…";
    case "tool_request": return toolStatus(event.name || "tool");
    case "compacting": return "Compacting context…";
    case "retry": return `Retrying request${event.attempt ? ` (${event.attempt}/${event.max_retries || "?"})` : ""}…`;
    case "authenticating": return "Authenticating…";
    case "cancelling": return "cancelling…";
    case "applying_reply": return "applying reply…";
    default: return "";
  }
}

function contextMeterForUsage(usage = {}, model = "", provider = "") {
  if (usage.contextMeter?.label) return usage.contextMeter;
  return buildContextMeter({ model, usage: {
    input: usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? 0,
    cacheRead: usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cacheRead ?? 0,
    cacheCreation: usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheCreation ?? 0,
    inputIncludesCache: provider === "claude-cli" || provider === "anthropic" ? false : true,
  } });
}

function planLinesFromItems(items = []) {
  return (Array.isArray(items) ? items : []).filter(Boolean).map((item) => {
    const status = String(item.status || "");
    const mark = item.completed || ["completed", "succeeded"].includes(status) ? "✓"
      : ["in_progress", "running"].includes(status) ? "→"
      : ["failed", "blocked"].includes(status) ? "✗" : "○";
    return `${mark} ${item.text || item.content || item.title || item.step || ""}`;
  });
}

function buildPlanSetPayload(executionState, options = {}) {
  try {
    const { buildPlanUiProjection } = require("../code/context/planProjection");
    const projection = buildPlanUiProjection(executionState, {
      cols: Number(options.cols) > 0 ? Number(options.cols) : 80,
      activityMessage: String(options.activityMessage || ""),
    });
    if (!projection || !projection.visible) {
      return {
        summary: "",
        lines: [],
        hash: projection && projection.hash || "",
        visible: false,
        idle_hint: String((projection && projection.idleHint) || ""),
        status_line: "",
        band_mode: String((projection && projection.bandMode) || ""),
      };
    }
    let lines = Array.isArray(projection.bandLines) ? projection.bandLines.slice() : [];
    const md = String(projection.roadmapMarkdown || "").trim();
    if (md) {
      try {
        const rendered = fmt.renderLogLinesWithMarkdownAnsi(md, { inCodeBlock: false });
        if (Array.isArray(rendered) && rendered.length > 0) {
          lines = rendered.map((line) => String(line || ""));
        }
      } catch {
        // keep bandLines
      }
    }
    const summary = String(
      projection.statusLine
      || projection.activityStatusLine
      || lines[0]
      || ""
    ).trim();
    return {
      summary,
      text: summary,
      lines,
      hash: projection.hash || "",
      visible: true,
      idle_hint: String(projection.idleHint || ""),
      status_line: String(projection.statusLine || projection.activityStatusLine || ""),
      activity_status_line: String(projection.activityStatusLine || ""),
      band_mode: String(projection.bandMode || ""),
    };
  } catch {
    return {
      summary: "",
      lines: [],
      hash: "",
      visible: false,
      idle_hint: "",
      status_line: "",
      band_mode: "",
    };
  }
}


module.exports = { toolStatus, statusForAgentPhase, contextMeterForUsage, planLinesFromItems, buildPlanSetPayload };
