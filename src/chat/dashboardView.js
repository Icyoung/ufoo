const { clampAgentWindowWithSelection } = require("./agentDirectory");

const DEFAULT_MODE_OPTIONS = ["auto", "host", "terminal", "tmux", "internal"];

function providerLabel(value) {
  if (value === "claude-cli") return "claude";
  if (value === "ucode" || value === "ufoo" || value === "ufoo-code") return "ucode";
  return "codex";
}

function ensureAtPrefix(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  return text.startsWith("@") ? text : `@${text}`;
}

function activityMarker(state = "") {
  const normalized = String(state || "").trim().toLowerCase();
  if (normalized === "working") return "*";
  if (normalized === "waiting_input") return "?";
  if (normalized === "blocked") return "!";
  return "";
}

function withActivityMarker(label = "", state = "") {
  const marker = activityMarker(state);
  if (!marker) return label;
  return `${marker}${label}`;
}

function buildSummaryLine(options = {}) {
  const {
    activeAgents = [],
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    launchMode = "terminal",
    agentProvider = "codex-cli",
    cronTasks = [],
    loopSummary = null,
  } = options;
  const agents = activeAgents.length > 0
    ? activeAgents.slice(0, 3)
      .map((id) => withActivityMarker(ensureAtPrefix(getAgentLabel(id)), getAgentState(id)))
      .join(", ")
      + (activeAgents.length > 3 ? ` +${activeAgents.length - 3}` : "")
    : "none";
  let line = `{gray-fg}Agents:{/gray-fg} {cyan-fg}${agents}{/cyan-fg}`
    + `  {gray-fg}Mode:{/gray-fg} {cyan-fg}${launchMode}{/cyan-fg}`
    + `  {gray-fg}Agent:{/gray-fg} {cyan-fg}${providerLabel(agentProvider)}{/cyan-fg}`
    + `  {gray-fg}Cron:{/gray-fg} {cyan-fg}${Array.isArray(cronTasks) ? cronTasks.length : 0}{/cyan-fg}`;
  const loopPart = formatLoopSummary(loopSummary);
  if (loopPart) {
    line += `  {gray-fg}Loop:{/gray-fg} {cyan-fg}${loopPart}{/cyan-fg}`;
  }
  return line;
}

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
    parts.push(`cache${cacheReadTokens}/${cacheCreationTokens}`);
  }
  if (toolDistribution) {
    parts.push(toolDistribution);
  }
  if (terminalReason) {
    parts.push(terminalReason);
  }
  return parts.join(" ");
}

function buildProjectRailLine(options = {}) {
  const {
    projects = [],
    selectedProjectIndex = -1,
    projectListWindowStart = 0,
    maxProjectWindow = 5,
    activeProjectRoot = "",
    projectsFocused = false,
    globalScope = "",
    dashboardHint = "",
  } = options;
  const rows = Array.isArray(projects) ? projects : [];
  let windowStart = projectListWindowStart;
  if (rows.length === 0) {
    return {
      hasProjects: false,
      line: " {gray-fg}Projects:{/gray-fg} {cyan-fg}none{/cyan-fg}",
      windowStart,
    };
  }

  const activeRoot = String(activeProjectRoot || "");
  const fallbackIndex = rows.findIndex((row) => String((row || {}).project_root || "") === activeRoot);
  const normalizedSelectedIndex = Number.isFinite(selectedProjectIndex)
    ? Math.trunc(selectedProjectIndex)
    : -1;
  const safeSelectedIndex = normalizedSelectedIndex >= 0 && normalizedSelectedIndex < rows.length
    ? normalizedSelectedIndex
    : (fallbackIndex >= 0 ? fallbackIndex : 0);

  windowStart = clampAgentWindowWithSelection({
    activeCount: rows.length,
    maxWindow: Math.max(1, maxProjectWindow),
    windowStart,
    selectionIndex: safeSelectedIndex,
  });

  const maxItems = Math.max(1, Math.min(Math.max(1, maxProjectWindow), rows.length));
  const start = windowStart;
  const end = start + maxItems;
  const visibleRows = rows.slice(start, end);
  const projectParts = visibleRows.map((row, i) => {
    const absoluteIndex = start + i;
    const name = String((row && row.project_name) || (row && row.project_root) || "-");
    const rowRoot = String((row && row.project_root) || "");
    const isActiveProject = globalScope !== "controller" && Boolean(activeRoot && rowRoot === activeRoot);
    const isSelected = absoluteIndex === safeSelectedIndex;
    if (projectsFocused && isSelected) {
      return `{inverse}${name}{/inverse}`;
    }
    if (isActiveProject) {
      return `{bold}{cyan-fg}${name}{/cyan-fg}{/bold}`;
    }
    return `{cyan-fg}${name}{/cyan-fg}`;
  });

  const leftMore = start > 0 ? "{gray-fg}<{/gray-fg} " : "";
  const rightMore = end < rows.length ? " {gray-fg}>{/gray-fg}" : "";
  const hintPart = dashboardHint ? `{|}{gray-fg}${dashboardHint}{/gray-fg}` : "";
  return {
    hasProjects: true,
    line: ` {gray-fg}Projects:{/gray-fg} ${leftMore}${projectParts.join("  ")}${rightMore}${hintPart}`,
    windowStart,
  };
}

function buildDashboardDetailLine(options = {}) {
  const {
    globalMode = false,
    dashboardView = "agents",
    activeAgents = [],
    selectedAgentIndex = -1,
    agentListWindowStart = 0,
    maxAgentWindow = 4,
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    selectedModeIndex = 0,
    selectedProviderIndex = 0,
    selectedResumeIndex = 0,
    selectedCronIndex = -1,
    cronTasks = [],
    providerOptions = [],
    resumeOptions = [],
    dashHints = {},
    modeOptions = DEFAULT_MODE_OPTIONS,
  } = options;

  let content = " ";
  let windowStart = agentListWindowStart;

  if (dashboardView === "mode") {
    const modeParts = modeOptions.map((mode, i) => {
      if (i === selectedModeIndex) {
        return `{inverse}${mode}{/inverse}`;
      }
      return `{cyan-fg}${mode}{/cyan-fg}`;
    });
    content += `{gray-fg}Mode:{/gray-fg} ${modeParts.join("  ")}`;
    content += `  {gray-fg}│ ${dashHints.mode || ""}{/gray-fg}`;
    return { content, windowStart };
  }

  if (dashboardView === "provider") {
    const providerParts = providerOptions.map((opt, i) => {
      if (i === selectedProviderIndex) {
        return `{inverse}${opt.label}{/inverse}`;
      }
      return `{cyan-fg}${opt.label}{/cyan-fg}`;
    });
    content += `{gray-fg}Agent:{/gray-fg} ${providerParts.join("  ")}`;
    content += `  {gray-fg}│ ${dashHints.provider || ""}{/gray-fg}`;
    return { content, windowStart };
  }

  if (dashboardView === "resume") {
    const resumeParts = resumeOptions.map((opt, i) => {
      if (i === selectedResumeIndex) {
        return `{inverse}${opt.label}{/inverse}`;
      }
      return `{cyan-fg}${opt.label}{/cyan-fg}`;
    });
    content += `{gray-fg}Resume:{/gray-fg} ${resumeParts.join("  ")}`;
    content += `  {gray-fg}│ ${dashHints.resume || ""}{/gray-fg}`;
    return { content, windowStart };
  }

  if (dashboardView === "cron") {
    const items = Array.isArray(cronTasks) ? cronTasks : [];
    const summary = items.length > 0
      ? items.map((item, index) => {
        const label = item.label || item.summary || item.id || "";
        if (!label) return "";
        return index === selectedCronIndex
          ? `{inverse}${label}{/inverse}`
          : `{cyan-fg}${label}{/cyan-fg}`;
      }).filter(Boolean).join(", ")
      : "{cyan-fg}none{/cyan-fg}";
    content += `{gray-fg}Cron:{/gray-fg} ${summary}`;
    content += `  {gray-fg}│ ${dashHints.cron || ""}{/gray-fg}`;
    return { content, windowStart };
  }

  if (activeAgents.length > 0) {
    windowStart = clampAgentWindowWithSelection({
      activeCount: activeAgents.length,
      maxWindow: maxAgentWindow,
      windowStart,
      selectionIndex: selectedAgentIndex,
    });
    const maxItems = Math.max(1, Math.min(maxAgentWindow, activeAgents.length));
    const start = windowStart;
    const end = start + maxItems;
    const visibleAgents = activeAgents.slice(start, end);
    const agentParts = visibleAgents.map((agent, i) => {
      const absoluteIndex = start + i;
      const label = withActivityMarker(
        ensureAtPrefix(getAgentLabel(agent)),
        getAgentState(agent)
      );
      if (absoluteIndex === selectedAgentIndex) {
        return `{inverse}${label}{/inverse}`;
      }
      return `{cyan-fg}${label}{/cyan-fg}`;
    });
    const leftMore = start > 0 ? "{gray-fg}<{/gray-fg} " : "";
    const rightMore = end < activeAgents.length ? " {gray-fg}>{/gray-fg}" : "";
    content += `{gray-fg}Agents:{/gray-fg} ${leftMore}${agentParts.join("  ")}${rightMore}`;
    const agentsHint = globalMode
      ? (dashHints.agentsGlobal || dashHints.agents || "")
      : (dashHints.agents || "");
    content += `  {gray-fg}│ ${agentsHint}{/gray-fg}`;
  } else {
    content += "{gray-fg}Agents:{/gray-fg} {cyan-fg}none{/cyan-fg}";
    content += `  {gray-fg}│ ${dashHints.agentsEmpty || ""}{/gray-fg}`;
  }
  return { content, windowStart };
}

function computeDashboardContent(options = {}) {
  const {
    globalMode = false,
    globalScope = "controller",
    focusMode = "input",
    dashboardView = "agents",
    activeAgents = [],
    projects = [],
    selectedProjectIndex = -1,
    projectListWindowStart = 0,
    maxProjectWindow = 5,
    activeProjectRoot = "",
    selectedAgentIndex = -1,
    agentListWindowStart = 0,
    maxAgentWindow = 4,
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    launchMode = "terminal",
    agentProvider = "codex-cli",
    selectedModeIndex = 0,
    selectedProviderIndex = 0,
    selectedResumeIndex = 0,
    selectedCronIndex = -1,
    cronTasks = [],
    loopSummary = null,
    pendingReports = 0,
    providerOptions = [],
    resumeOptions = [],
    dashHints = {},
    modeOptions = DEFAULT_MODE_OPTIONS,
  } = options;

  if (globalMode) {
    const projectsFocused = focusMode === "dashboard" && dashboardView === "projects";
    let dashboardHint = "";
    if (projectsFocused) {
      dashboardHint = globalScope === "controller" ? "Enter\u2192project" : "Esc\u2192global";
    }
    const rail = buildProjectRailLine({
      projects,
      selectedProjectIndex,
      projectListWindowStart,
      maxProjectWindow,
      activeProjectRoot,
      projectsFocused,
      globalScope,
      dashboardHint,
    });
    if (!rail.hasProjects) {
      const line2 = ` {gray-fg}${dashHints.projectsEmpty || "Run ufoo chat/daemon in projects to populate registry"}{/gray-fg}`;
      return {
        content: `${rail.line}\n${line2}`,
        windowStart: rail.windowStart,
      };
    }

    if (focusMode !== "dashboard" || projectsFocused) {
      const line2 = buildSummaryLine({
        activeAgents,
        getAgentLabel,
        getAgentState,
        launchMode,
        agentProvider,
        cronTasks,
        loopSummary,
      });
      return {
        content: `${rail.line}\n ${line2}`,
        windowStart: rail.windowStart,
      };
    }

    const detail = buildDashboardDetailLine({
      globalMode,
      dashboardView,
      activeAgents,
      selectedAgentIndex,
      agentListWindowStart,
      maxAgentWindow,
      getAgentLabel,
      getAgentState,
      selectedModeIndex,
      selectedProviderIndex,
      selectedResumeIndex,
      selectedCronIndex,
      cronTasks,
      providerOptions,
      resumeOptions,
      dashHints,
      modeOptions,
    });
    return {
      content: `${rail.line}\n${detail.content}`,
      windowStart: detail.windowStart,
    };
  }

  if (focusMode === "dashboard") {
    return buildDashboardDetailLine({
      globalMode,
      dashboardView,
      activeAgents,
      selectedAgentIndex,
      agentListWindowStart,
      maxAgentWindow,
      getAgentLabel,
      getAgentState,
      selectedModeIndex,
      selectedProviderIndex,
      selectedResumeIndex,
      selectedCronIndex,
      cronTasks,
      providerOptions,
      resumeOptions,
      dashHints,
      modeOptions,
    });
  }

  let content = " ";
  content += buildSummaryLine({
    activeAgents,
    getAgentLabel,
    getAgentState,
    launchMode,
    agentProvider,
    cronTasks,
    loopSummary,
  });

  return { content, windowStart: agentListWindowStart };
}

module.exports = {
  computeDashboardContent,
  providerLabel,
};
