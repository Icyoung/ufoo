"use strict";

// Shared presentation adapters: standalone ucode and embedded SDK/native agents.
const fmt = require("./format");
const { buildContextMeter } = require("../agents/runtime/context/contextWindow");

function toolStatus(name = "tool") {
  const aliases = {
    Read: "read",
    Write: "write",
    Edit: "edit",
    MultiEdit: "multiedit",
    NotebookEdit: "notebookedit",
    Bash: "bash",
    Grep: "grep",
    Glob: "glob",
    WebSearch: "web_search",
    WebFetch: "web_fetch",
    Agent: "agent",
    Task: "task",
    TodoWrite: "plan_graph",
    plan: "plan_graph",
    update_plan: "plan_graph",
    run_command: "bash",
    view_file: "read",
    write_to_file: "write",
    replace_file_content: "edit",
    multi_replace_file_content: "multiedit",
    grep_search: "grep",
    find_by_name: "glob",
    list_dir: "glob",
    search_web: "web_search",
  };
  const raw = String(name || "tool").trim();
  const stripped = raw.replace(/^mcp__[^_]+(?:_[^_]+)*__/i, "").replace(/^[a-z0-9_-]+\./i, "");
  const key = aliases[raw] || aliases[stripped] || stripped.toLowerCase();
  const friendly = fmt.TOOL_LABELS[key] || `Calling ${fmt.formatToolDisplayName(raw)}`;
  return `${friendly}…`;
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
  const limitTokens = Number(usage.context_window ?? usage.contextWindow);
  return buildContextMeter({
    model,
    ...(Number.isFinite(limitTokens) && limitTokens > 0 ? { limitTokens } : {}),
    usage: {
      input: usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? 0,
      cacheRead: usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cacheRead ?? 0,
      cacheCreation: usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheCreation ?? 0,
      inputIncludesCache: provider === "claude-cli" || provider === "anthropic" ? false : true,
    },
  });
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsiPlain(text = "") {
  return String(text || "").replace(ANSI_RE, "");
}

function normalizePlanItemStatus(rawStatus = "", completed = false) {
  if (completed === true) return "completed";
  const value = String(rawStatus || "").trim().toLowerCase();
  if (["completed", "succeeded", "done", "success"].includes(value)) return "completed";
  if (["in_progress", "running", "active", "waiting_llm", "waiting_approval", "working"].includes(value)) return "in_progress";
  if (["failed", "error", "blocked"].includes(value)) return "failed";
  if (["skipped", "cancelled", "canceled"].includes(value)) return "skipped";
  return "pending";
}

function formatConciseDisplayTitle(raw = "") {
  const clean = stripAnsiPlain(raw).replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= 96) return clean;
  try {
    const { deriveConcisePlanTitle } = require("../code/context/planGraph");
    return deriveConcisePlanTitle(clean, 80);
  } catch {
    return `${clean.slice(0, 79).trim()}…`;
  }
}

function normalizePlanItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((item, idx) => {
      if (typeof item === "string") {
        const clean = formatConciseDisplayTitle(item);
        return clean ? { id: `step-${idx + 1}`, title: clean, status: "pending" } : null;
      }
      const title = formatConciseDisplayTitle(
        item.title || item.content || item.text || item.step || item.objective || ""
      );
      if (!title) return null;
      return {
        ...(item.id ? { id: String(item.id) } : {}),
        title,
        status: normalizePlanItemStatus(item.status || item.kind, item.completed === true),
      };
    })
    .filter(Boolean);
}

function parsePlanItemsFromLines(lines = []) {
  const cleaned = (Array.isArray(lines) ? lines : [])
    .map((line) => stripAnsiPlain(line).trim())
    .filter(Boolean);
  if (cleaned.length === 0) return [];
  const hasRunningTaskLoop = cleaned.some((line) => /^TaskLoop\s+(?:writing|running|starting|working)\b/i.test(line));
  const parsed = [];
  for (const line of cleaned) {
    if (/^Plan\b(?:\s*·|\s*\()/i.test(line)) continue;
    if (/^TaskLoop\b/i.test(line)) continue;
    if (/^…\s*\+\d+\s+more\b/i.test(line)) continue;
    if (/^graphId=/i.test(line)) continue;
    const upcomingMatch = line.match(/^接下来\s*·\s*(.+)$/);
    if (upcomingMatch) {
      for (const part of upcomingMatch[1].split(/\s*·\s*/)) {
        const title = part.trim();
        if (title) parsed.push({ title, status: "pending" });
      }
      continue;
    }
    const markMatch = line.match(/^(?:[├└─\s]*)(✓|✔|→|▶|●|◐|○|✗|✘|⊘)\s+(?:\d+\s+)?(.+)$/);
    if (markMatch) {
      const mark = markMatch[1];
      const title = markMatch[2].trim();
      if (!title) continue;
      let status = "pending";
      if (mark === "✓" || mark === "✔") status = "completed";
      else if (mark === "→" || mark === "▶" || mark === "●" || mark === "◐") status = "in_progress";
      else if (mark === "✗" || mark === "✘") status = hasRunningTaskLoop ? "in_progress" : "failed";
      else if (mark === "⊘") status = "skipped";
      parsed.push({ title, status });
    }
  }
  if (hasRunningTaskLoop && parsed.length > 0 && !parsed.some((item) => item.status === "in_progress")) {
    const firstPending = parsed.find((item) => item.status === "pending");
    if (firstPending) firstPending.status = "in_progress";
  }
  return parsed;
}

function planLinesFromItems(items = []) {
  return normalizePlanItems(items).map((item) => {
    const mark = item.status === "completed" ? "✓"
      : item.status === "in_progress" ? "→"
      : item.status === "failed" ? "✗"
      : item.status === "skipped" ? "⊘"
      : "○";
    return `${mark} ${item.title}`;
  });
}

function isProgressedRawStatus(raw = "") {
  const value = String(raw || "").trim().toLowerCase();
  return [
    "running",
    "waiting_llm",
    "waiting_approval",
    "in_progress",
    "active",
    "working",
    "succeeded",
    "completed",
    "done",
    "success",
  ].includes(value);
}

function extractStructuredPlanItems(planGraph = {}, projection = null, executionState = null, options = {}) {
  const { buildPlanDag } = require("../code/context/planProjection");
  const { listActiveWritingTaskRuns } = require("../code/runtime/taskRun");
  const isTerminal = options.isTerminal === true;
  const dag = (projection && projection.dag && Array.isArray(projection.dag.nodes) && projection.dag.nodes.length > 0)
    ? projection.dag
    : buildPlanDag(planGraph);
  const activeRunNodeIds = new Set(
    (executionState ? listActiveWritingTaskRuns(executionState) : [])
      .map((run) => String(run && run.parentNodeId || "").trim())
      .filter(Boolean)
  );
  const focusNodeId = projection && projection.focus && (
    projection.focus.taskRunId
    || ["running", "waiting_llm", "waiting_approval", "in_progress"].includes(String(projection.focus.status || "").toLowerCase())
  )
    ? String(projection.focus.nodeId || "").trim()
    : "";

  const orderedNodes = Array.isArray(dag?.waves) && dag.waves.length > 0
    ? dag.waves.flat()
    : (Array.isArray(dag?.nodes) ? dag.nodes : []);

  const rawNodes = Array.isArray(planGraph?.nodes) ? planGraph.nodes : [];
  const rawById = new Map(rawNodes.filter(Boolean).map((n) => [String(n.id || "").trim(), n]));
  const parentIdsWithChildren = new Set(
    rawNodes
      .map((n) => String(n && n.parentTaskId || "").trim())
      .filter(Boolean)
  );
  const isStartedTaskNode = (id) => {
    const raw = rawById.get(id);
    if (!raw) return false;
    const execKind = raw.execution && typeof raw.execution === "object"
      ? String(raw.execution.kind || "").trim().toLowerCase()
      : String(raw.execution || "").trim().toLowerCase();
    return execKind === "aggregate"
      || Number(raw.attempt) > 0
      || parentIdsWithChildren.has(id);
  };

  const mapNodeList = (list) => list.map((node, idx) => {
    const id = String(node.id || "").trim();
    const rawStatus = String(node.status || node.kind || "").trim().toLowerCase();
    let status = normalizePlanItemStatus(node.status || node.kind);
    if (!isTerminal && rawStatus === "blocked") {
      // Downstream tasks that have never started should stay `pending` rather than
      // flashing red when an upstream task hits a transient internal tool error.
      // A started/expanded task whose own child tool failed stays `in_progress` while
      // the model is still recovering it, and only becomes `failed` once explicitly
      // failed, moved past, or when the plan terminates.
      if (!isStartedTaskNode(id)) {
        status = "pending";
      } else {
        const movedOn = list.slice(idx + 1).some((later) => {
          const laterId = String(later && later.id || "").trim();
          return (laterId && activeRunNodeIds.has(laterId))
            || isProgressedRawStatus(later && (later.status || later.kind));
        });
        if (!movedOn) {
          status = "in_progress";
        }
      }
    }
    if (status === "pending" && (activeRunNodeIds.has(id) || (focusNodeId && focusNodeId === id))) {
      status = "in_progress";
    }
    return {
      ...(id ? { id } : {}),
      title: formatConciseDisplayTitle(node.title || id),
      status,
    };
  }).filter((item) => item.title);

  if (orderedNodes.length > 0) {
    return mapNodeList(orderedNodes);
  }

  const treeTasks = Array.isArray(projection?.tree)
    ? projection.tree.filter((row) => row && row.type === "task")
    : [];
  return mapNodeList(treeTasks);
}

function buildPlanSetPayload(executionState, options = {}) {
  try {
    const { buildPlanUiProjection } = require("../code/context/planProjection");
    const projection = buildPlanUiProjection(executionState, {
      cols: Number(options.cols) > 0 ? Number(options.cols) : 80,
      activityMessage: String(options.activityMessage || ""),
    });
    const rawPg = executionState && typeof executionState === "object" && executionState.planGraph && typeof executionState.planGraph === "object"
      ? executionState.planGraph
      : {};
    if (!projection || !projection.visible) {
      let completedPlan = null;
      const archivedPlans = executionState && Array.isArray(executionState.archivedPlans)
        ? executionState.archivedPlans
        : [];
      const latestArchived = archivedPlans.length > 0 ? archivedPlans[archivedPlans.length - 1] : null;
      if (
        latestArchived
        && latestArchived.graphId
        && ["graph_terminal", "cancel_graph"].includes(String(latestArchived.archiveReason || ""))
      ) {
        const archivedItems = extractStructuredPlanItems(latestArchived, null, null, { isTerminal: true });
        if (archivedItems.length > 0) {
          completedPlan = {
            plan_id: String(latestArchived.graphId || ""),
            objective: stripAnsiPlain(latestArchived.objective || "").trim(),
            reason: String(latestArchived.archiveReason || ""),
            items: archivedItems,
          };
        }
      }
      return {
        summary: "",
        lines: [],
        items: [],
        plan_id: "",
        objective: "",
        ...(completedPlan ? { completed_plan: completedPlan } : {}),
        hash: projection && projection.hash || "",
        visible: false,
        idle_hint: String((projection && projection.idleHint) || ""),
        status_line: "",
        band_mode: String((projection && projection.bandMode) || ""),
      };
    }
    const resolvedPg = (projection.planGraph && projection.planGraph.graphId)
      ? projection.planGraph
      : rawPg;
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
    const items = extractStructuredPlanItems(resolvedPg, projection, executionState, { isTerminal: false });
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
      items,
      plan_id: String(projection.graphId || resolvedPg.graphId || ""),
      objective: stripAnsiPlain(projection.objective || resolvedPg.objective || "").trim(),
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
      items: [],
      plan_id: "",
      objective: "",
      hash: "",
      visible: false,
      idle_hint: "",
      status_line: "",
      band_mode: "",
    };
  }
}


module.exports = {
  toolStatus,
  statusForAgentPhase,
  contextMeterForUsage,
  normalizePlanItems,
  parsePlanItemsFromLines,
  planLinesFromItems,
  buildPlanSetPayload,
};
