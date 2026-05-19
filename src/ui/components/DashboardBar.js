"use strict";

/**
 * DashboardBar — the bottom 1-2 rows in chat showing the current dashboard
 * mode (projects rail in global mode + one of agents/mode/provider/cron).
 * Renders directly with ink primitives instead of going through
 * computeDashboardContent (which emits blessed-tag strings) so we don't
 * have to translate "{cyan-fg}…{/cyan-fg}" at render time.
 *
 * The agents window math (clamping the visible slice around the selection
 * cursor) is reused from src/chat/agentDirectory.js so the two TUIs scroll
 * the strip the same way.
 */

const { clampAgentWindowWithSelection } = require("../../chat/agentDirectory");
const { providerLabel } = require("../../chat/dashboardView");
const { displayCellWidth, planProjectsRail } = require("../format");

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
  return marker ? `${marker}${label}` : label;
}

function formatToolDistribution(items = []) {
  const tools = Array.isArray(items) ? items : [];
  if (tools.length === 0) return "";
  const visible = tools.slice(0, 2).map((item) => `${item.name}x${item.count}`);
  if (tools.length > 2) visible.push(`+${tools.length - 2}`);
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
  if (rounds <= 0 && toolCalls <= 0 && totalTokens <= 0 && !terminalReason && !toolDistribution) return "";
  const parts = [`r${rounds}`, `tc${toolCalls}`, `tok${totalTokens}`];
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    parts.push(`cache${cacheReadTokens}/${cacheCreationTokens}`);
  }
  if (toolDistribution) parts.push(toolDistribution);
  if (terminalReason) parts.push(terminalReason);
  return parts.join(" ");
}

function projectName(row) {
  return String(
    (row && (row.project_name || row.label || row.id || row.project_root || row.root)) || "-"
  );
}

function projectRoot(row) {
  return String((row && (row.project_root || row.root)) || "");
}

function buildSummaryRow(options = {}) {
  const {
    activeAgents = [],
    activeAgentId = "",
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    launchMode = "terminal",
    agentProvider = "codex-cli",
    cronTasks = [],
    loopSummary = null,
  } = options;
  const visibleAgentIds = activeAgents.slice(0, 3);
  const agentItems = visibleAgentIds.map((id) => {
    const active = Boolean(activeAgentId && id === activeAgentId);
    return {
      label: withActivityMarker(ensureAtPrefix(getAgentLabel(id)), getAgentState(id)),
      selected: false,
      active,
    };
  });
  const agents = activeAgents.length > 0
    ? agentItems.map((item) => item.label).join(", ") + (activeAgents.length > 3 ? ` +${activeAgents.length - 3}` : "")
    : "none";
  const parts = [
    { label: "Agents", value: agents },
    { label: "Mode", value: launchMode },
    { label: "Agent", value: providerLabel(agentProvider) },
    { label: "Cron", value: String(Array.isArray(cronTasks) ? cronTasks.length : 0) },
  ];
  const loopPart = formatLoopSummary(loopSummary);
  if (loopPart) parts.push({ label: "Loop", value: loopPart });
  return {
    kind: "summary",
    agentItems,
    agentExtraCount: Math.max(0, activeAgents.length - visibleAgentIds.length),
    parts,
  };
}

function buildProjectRow(options = {}) {
  const {
    projects = [],
    selectedProjectIndex = -1,
    projectListWindowStart = 0,
    maxProjectWindow = 5,
    maxWidth = 80,
    activeProjectRoot = "",
    focused = false,
    globalScope = "controller",
  } = options;
  const rows = Array.isArray(projects) ? projects : [];
  if (rows.length === 0) {
    return {
      kind: "chips",
      caption: "Projects",
      items: [],
      emptyLabel: "none",
      hint: options.dashHints && options.dashHints.projectsEmpty
        ? options.dashHints.projectsEmpty
        : "Run ufoo chat or ufoo daemon start in project directories",
      windowStart: projectListWindowStart,
    };
  }
  const fallbackIndex = rows.findIndex((row) => projectRoot(row) === String(activeProjectRoot || ""));
  const selected = selectedProjectIndex >= 0 && selectedProjectIndex < rows.length
    ? selectedProjectIndex
    : (fallbackIndex >= 0 ? fallbackIndex : 0);
  const requestedHint = focused ? (globalScope === "controller" ? "Enter→project" : "Esc→global") : "";
  const availableAfterCaption = Math.max(
    1,
    Math.floor(Number(maxWidth) || 80) - displayCellWidth("Projects: ")
  );
  const hintWidth = requestedHint ? displayCellWidth(` · ${requestedHint}`) : 0;
  const minFocusedChipWidth = focused ? 4 : 1;
  const canShowHint = requestedHint && availableAfterCaption - hintWidth >= minFocusedChipWidth;
  const hint = canShowHint ? requestedHint : "";
  const railBudget = Math.max(1, availableAfterCaption - (hint ? hintWidth : 0));
  const planned = planProjectsRail({
    labels: rows.map(projectName),
    selectedIndex: focused ? selected : -1,
    windowStart: projectListWindowStart || 0,
    maxCells: railBudget,
  });
  return {
    kind: "chips",
    caption: "Projects",
    leftMore: planned.leftMore,
    rightMore: planned.rightMore,
    windowStart: planned.windowStart,
    hint,
    items: planned.items.map((item) => {
      const idx = item.absoluteIndex;
      const row = rows[idx];
      const root = projectRoot(row);
      return {
        label: item.label,
        selected: focused && idx === selected,
        active: Boolean(activeProjectRoot && root === activeProjectRoot),
      };
    }),
  };
}

function buildDetailRow(options = {}) {
  const {
    dashboardView = "agents",
    globalMode = false,
    activeAgents = [],
    activeAgentId = "",
    selectedAgentIndex = -1,
    agentListWindowStart = 0,
    maxAgentWindow = 4,
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    selectedModeIndex = 0,
    selectedProviderIndex = 0,
    selectedCronIndex = -1,
    modeOptions = [],
    providerOptions = [],
    cronTasks = [],
    loopSummary = null,
    dashHints = {},
    focused = false,
  } = options;

  if (dashboardView === "mode") {
    return {
      kind: "chips",
      caption: "Mode",
      hint: dashHints.mode || "",
      items: (modeOptions || []).map((label, i) => ({ label, selected: focused && i === selectedModeIndex })),
    };
  }
  if (dashboardView === "provider") {
    return {
      kind: "chips",
      caption: "Agent",
      hint: dashHints.provider || "",
      items: (providerOptions || []).map((opt, i) => ({ label: opt.label || opt, selected: focused && i === selectedProviderIndex })),
    };
  }
  if (dashboardView === "cron") {
    const items = Array.isArray(cronTasks) ? cronTasks : [];
    return {
      kind: "chips",
      caption: "Cron",
      hint: dashHints.cron || "",
      emptyLabel: "none",
      items: items.map((item, i) => ({
        label: item.label || item.summary || item.id || "",
        selected: focused && i === selectedCronIndex,
      })).filter((item) => item.label),
    };
  }

  if (!activeAgents.length) {
    return {
      kind: "chips",
      caption: "Agents",
      emptyLabel: "none",
      hint: dashHints.agentsEmpty || "",
      items: [],
      windowStart: agentListWindowStart,
    };
  }
  const maxItems = Math.max(1, Math.min(maxAgentWindow || 4, activeAgents.length));
  const windowStart = clampAgentWindowWithSelection({
    activeCount: activeAgents.length,
    maxWindow: maxItems,
    windowStart: agentListWindowStart || 0,
    selectionIndex: selectedAgentIndex,
  });
  const visible = activeAgents.slice(windowStart, windowStart + maxItems);
  return {
    kind: "chips",
    caption: "Agents",
    leftMore: windowStart > 0,
    rightMore: windowStart + maxItems < activeAgents.length,
    windowStart,
    hint: globalMode ? (dashHints.agentsGlobal || dashHints.agents || "") : (dashHints.agents || ""),
    items: visible.map((agentId, i) => {
      const active = Boolean(activeAgentId && agentId === activeAgentId);
      return {
        label: withActivityMarker(ensureAtPrefix(getAgentLabel(agentId)), getAgentState(agentId)),
        selected: focused && (windowStart + i) === selectedAgentIndex,
        ...(active ? { active: true } : {}),
      };
    }),
  };
}

function buildDashboardRows(options = {}) {
  const {
    globalMode = false,
    globalScope = "controller",
    focusMode = "input",
    dashboardView = "agents",
    projects = [],
    dashHints = {},
  } = options;
  const focused = focusMode === "dashboard";
  if (globalMode) {
    const projectsFocused = focused && dashboardView === "projects";
    const projectRow = buildProjectRow({
      ...options,
      focused: projectsFocused,
      globalScope,
    });
    if (!focused || projectsFocused) {
      return [projectRow, buildSummaryRow(options)];
    }
    return [projectRow, buildDetailRow({ ...options, focused })];
  }
  if (focused) return [buildDetailRow({ ...options, focused })];
  return [buildSummaryRow(options)];
}

function createDashboardBar({ React, ink }) {
  const { Box, Text } = ink;
  const h = React.createElement;

  const sep = (key) =>
    h(Text, { key, color: "gray", wrap: "truncate" }, "  ");

  const renderItem = (item, key) =>
    h(Text, {
      key,
      color: item.selected || item.active ? undefined : "cyan",
      inverse: item.selected,
      bold: Boolean(item.active),
      wrap: "truncate",
    }, item.label);

  const renderHint = (hint) =>
    hint ? h(Text, { color: "gray", wrap: "truncate" }, ` · ${hint}`) : null;

  const ChipsRow = ({ caption, items, hint, leftMore, rightMore, emptyLabel }) =>
    h(Box, { width: "100%", flexWrap: "nowrap" },
      h(Text, { color: "gray", wrap: "truncate" }, `${caption}: `),
      leftMore ? h(Text, { color: "gray", wrap: "truncate" }, "< ") : null,
      items.length === 0 && emptyLabel ? h(Text, { color: "cyan", wrap: "truncate" }, emptyLabel) : null,
      ...items.map((item, idx) => h(React.Fragment, { key: idx },
        idx > 0 ? sep(`s-${idx}`) : null,
        renderItem(item, `c-${idx}`),
      )),
      rightMore ? h(Text, { color: "gray", wrap: "truncate" }, " >") : null,
      renderHint(hint),
    );

  const SummaryRow = ({ parts, agentItems = [], agentExtraCount = 0 }) =>
    h(Box, { width: "100%", flexWrap: "nowrap" },
      ...parts.map((part, idx) => {
        const isAgents = part.label === "Agents" && agentItems.length > 0;
        return h(React.Fragment, { key: part.label },
          idx > 0 ? h(Text, { color: "gray", wrap: "truncate" }, "  ") : null,
          h(Text, { color: "gray", wrap: "truncate" }, `${part.label}: `),
          isAgents
            ? h(React.Fragment, { key: "agents-summary" },
              ...agentItems.map((item, itemIdx) => h(React.Fragment, { key: `agent-${itemIdx}` },
                itemIdx > 0 ? h(Text, { color: "gray", wrap: "truncate" }, ", ") : null,
                renderItem(item, `agent-value-${itemIdx}`),
              )),
              agentExtraCount > 0 ? h(Text, { color: "cyan", wrap: "truncate" }, ` +${agentExtraCount}`) : null,
            )
            : h(Text, { color: "cyan", wrap: "truncate" }, part.value),
        );
      }),
    );

  return function DashboardBar({
    dashboardView = "agents",
    focusMode = "input",
    globalMode = false,
    globalScope = "controller",
    activeAgents = [],
    activeAgentId = "",
    selectedAgentIndex = -1,
    agentListWindowStart = 0,
    maxAgentWindow = 4,
    projectListWindowStart = 0,
    maxProjectWindow = 5,
    maxWidth = 80,
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    launchMode = "terminal",
    agentProvider = "codex-cli",
    modeOptions = [],
    selectedModeIndex = 0,
    providerOptions = [],
    selectedProviderIndex = 0,
    cronTasks = [],
    loopSummary = null,
    selectedCronIndex = -1,
    projects = [],
    selectedProjectIndex = -1,
    activeProjectRoot = "",
    dashHints = {},
  }) {
    const rows = buildDashboardRows({
      dashboardView,
      focusMode,
      globalMode,
      globalScope,
      activeAgents,
      activeAgentId,
      selectedAgentIndex,
      agentListWindowStart,
      maxAgentWindow,
      projectListWindowStart,
      maxProjectWindow,
      maxWidth,
      getAgentLabel,
      getAgentState,
      launchMode,
      agentProvider,
      modeOptions,
      selectedModeIndex,
      providerOptions,
      selectedProviderIndex,
      cronTasks,
      loopSummary,
      selectedCronIndex,
      projects,
      selectedProjectIndex,
      activeProjectRoot,
      dashHints,
    }).map((row, idx) => {
      if (row.kind === "summary") {
        return h(Box, { key: `dr-${idx}`, width: "100%", flexWrap: "nowrap" }, h(SummaryRow, row));
      }
      if (row.kind === "message") {
        return h(Box, { key: `dr-${idx}`, width: "100%", flexWrap: "nowrap" },
          h(Text, { color: "gray", wrap: "truncate" }, row.text));
      }
      return h(Box, { key: `dr-${idx}`, width: "100%", flexWrap: "nowrap" }, h(ChipsRow, row));
    });

    if (rows.length === 1) return h(Box, { width: "100%" }, rows[0]);
    return h(Box, { flexDirection: "column", width: "100%", flexWrap: "nowrap" }, ...rows);
  };
}

module.exports = { createDashboardBar, buildDashboardRows, formatLoopSummary };
