"use strict";

/**
 * DashboardBar — the bottom 1-2 rows in chat showing the current dashboard
 * mode (projects rail in global mode + one of agents/mode/provider/cron).
 * Each row is laid out inside a hard cell budget so narrow terminals never
 * spill content onto the next line: chips are dropped into "<…>" overflow
 * markers, the trailing hint is sacrificed first, and Loop summary fields
 * are progressively trimmed. The final row is folded into a single
 * <Text wrap="truncate"> so ink truncates predictably regardless of the
 * inline color spans.
 */

const chalk = require("chalk");

const { clampAgentWindowWithSelection } = require("../../app/chat/agentDirectory");
const { providerLabel } = require("../../app/chat/dashboardView");
const { displayCellWidth, planProjectsRail } = require("../format");

const CHIP_SEP = "  ";
const CHIP_SEP_WIDTH = displayCellWidth(CHIP_SEP);
const SUMMARY_GAP = "  ";
const SUMMARY_GAP_WIDTH = displayCellWidth(SUMMARY_GAP);
const HINT_PREFIX = " · ";
const HINT_PREFIX_WIDTH = displayCellWidth(HINT_PREFIX);

function truncateToCells(text = "", cells = 0) {
  const limit = Math.max(0, Math.floor(Number(cells) || 0));
  const value = String(text || "");
  if (limit <= 0) return "";
  if (displayCellWidth(value) <= limit) return value;
  if (limit <= 1) return "…";
  let out = "";
  let used = 0;
  const body = limit - 1;
  for (const ch of value) {
    const w = displayCellWidth(ch);
    if (used + w > body) break;
    out += ch;
    used += w;
  }
  return `${out || value.slice(0, 1)}…`;
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
  const inputTokens = Number(loopSummary.input_tokens) || 0;
  const cacheReadTokens = Number(loopSummary.cache_read_tokens) || 0;
  const cacheCreationTokens = Number(loopSummary.cache_creation_tokens) || 0;
  const terminalReason = String(loopSummary.terminal_reason || "").trim();
  const toolDistribution = formatToolDistribution(loopSummary.tools);
  if (rounds <= 0 && toolCalls <= 0 && totalTokens <= 0 && !terminalReason && !toolDistribution) return "";
  const parts = [`r${rounds}`, `tc${toolCalls}`, `tok${totalTokens}`];
  if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
    let cachePart = `cache${cacheReadTokens}/${cacheCreationTokens}`;
    if (cacheReadTokens > 0) {
      const hitRate = Math.round((cacheReadTokens / (cacheReadTokens + inputTokens)) * 100);
      cachePart += `(${hitRate}%)`;
    }
    parts.push(cachePart);
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

/**
 * Generic chip row planner. Returns the visible slice that fits inside
 * `maxWidth` (caption + chips + optional `< / >` overflow markers + optional
 * trailing hint). Hint is dropped first when budget is tight; chips are
 * windowed around `selectedIndex`. Empty rail (no items) is handled by the
 * caller via `emptyLabel`.
 */
function planChipsRow({
  caption,
  labels,
  selectedIndex = -1,
  windowStart = 0,
  hint = "",
  maxWidth = 80,
  reserveHintWhenFocused = false,
} = {}) {
  const items = Array.isArray(labels) ? labels.map(String) : [];
  const totalBudget = Math.max(1, Math.floor(Number(maxWidth) || 80));
  const captionText = `${caption}: `;
  const captionWidth = displayCellWidth(captionText);
  const railBudget = Math.max(1, totalBudget - captionWidth);
  const hintText = String(hint || "");
  const hintWidth = hintText ? HINT_PREFIX_WIDTH + displayCellWidth(hintText) : 0;
  const minChipCells = reserveHintWhenFocused ? 4 : 1;
  const canShowHint = hintText && railBudget - hintWidth >= minChipCells;
  const finalHint = canShowHint ? hintText : "";
  const railOnlyBudget = Math.max(1, railBudget - (finalHint ? hintWidth : 0));
  const planned = planProjectsRail({
    labels: items,
    selectedIndex,
    windowStart: windowStart || 0,
    maxCells: railOnlyBudget,
  });
  return {
    captionText,
    visible: planned.items,
    leftMore: planned.leftMore,
    rightMore: planned.rightMore,
    windowStart: planned.windowStart,
    hint: finalHint,
  };
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
  // agentItems carries the full active list so the renderer can greedy-fit
  // chips into whatever cell budget the terminal gives us. The legacy
  // 3-chip + "+N more" form is preserved on `parts[0].value` for callers
  // that consume the plain text (chat history, banner, tests).
  const allItems = activeAgents.map((id) => {
    const active = Boolean(activeAgentId && id === activeAgentId);
    return {
      label: withActivityMarker(ensureAtPrefix(getAgentLabel(id)), getAgentState(id)),
      selected: false,
      active,
    };
  });
  const agentItems = allItems;
  const visibleForText = allItems.slice(0, 3);
  const agents = activeAgents.length > 0
    ? visibleForText.map((item) => item.label).join(", ")
      + (activeAgents.length > 3 ? ` +${activeAgents.length - 3}` : "")
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
    agentExtraCount: 0,
    parts,
  };
}

function buildProjectRow(options = {}) {
  const {
    projects = [],
    selectedProjectIndex = -1,
    projectListWindowStart = 0,
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
  const planned = planChipsRow({
    caption: "Projects",
    labels: rows.map(projectName),
    selectedIndex: focused ? selected : -1,
    windowStart: projectListWindowStart || 0,
    hint: requestedHint,
    maxWidth,
    reserveHintWhenFocused: focused,
  });
  return {
    kind: "chips",
    caption: "Projects",
    leftMore: planned.leftMore,
    rightMore: planned.rightMore,
    windowStart: planned.windowStart,
    hint: planned.hint,
    items: planned.visible.map((item) => {
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
    maxWidth = 80,
    getAgentLabel = (id) => id,
    getAgentState = () => "",
    selectedModeIndex = 0,
    selectedProviderIndex = 0,
    selectedCronIndex = -1,
    modeOptions = [],
    providerOptions = [],
    cronTasks = [],
    dashHints = {},
    focused = false,
  } = options;

  if (dashboardView === "mode") {
    const labels = (modeOptions || []).map((label) => String(label));
    const planned = planChipsRow({
      caption: "Mode",
      labels,
      selectedIndex: focused ? selectedModeIndex : -1,
      hint: dashHints.mode || "",
      maxWidth,
      reserveHintWhenFocused: focused,
    });
    return {
      kind: "chips",
      caption: "Mode",
      hint: planned.hint,
      leftMore: planned.leftMore,
      rightMore: planned.rightMore,
      items: planned.visible.map((item) => ({
        label: item.label,
        selected: focused && item.absoluteIndex === selectedModeIndex,
      })),
    };
  }
  if (dashboardView === "provider") {
    const opts = Array.isArray(providerOptions) ? providerOptions : [];
    const labels = opts.map((opt) => String(opt && opt.label != null ? opt.label : opt));
    const planned = planChipsRow({
      caption: "Agent",
      labels,
      selectedIndex: focused ? selectedProviderIndex : -1,
      hint: dashHints.provider || "",
      maxWidth,
      reserveHintWhenFocused: focused,
    });
    return {
      kind: "chips",
      caption: "Agent",
      hint: planned.hint,
      leftMore: planned.leftMore,
      rightMore: planned.rightMore,
      items: planned.visible.map((item) => ({
        label: item.label,
        selected: focused && item.absoluteIndex === selectedProviderIndex,
      })),
    };
  }
  if (dashboardView === "cron") {
    const items = Array.isArray(cronTasks) ? cronTasks : [];
    const labels = items
      .map((item) => String(item.label || item.summary || item.id || ""))
      .filter(Boolean);
    if (labels.length === 0) {
      return {
        kind: "chips",
        caption: "Cron",
        hint: dashHints.cron || "",
        emptyLabel: "none",
        items: [],
      };
    }
    const planned = planChipsRow({
      caption: "Cron",
      labels,
      selectedIndex: focused ? selectedCronIndex : -1,
      hint: dashHints.cron || "",
      maxWidth,
      reserveHintWhenFocused: focused,
    });
    return {
      kind: "chips",
      caption: "Cron",
      hint: planned.hint,
      leftMore: planned.leftMore,
      rightMore: planned.rightMore,
      items: planned.visible.map((item) => ({
        label: item.label,
        selected: focused && item.absoluteIndex === selectedCronIndex,
      })),
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
  const labels = activeAgents.map((agentId) => withActivityMarker(
    ensureAtPrefix(getAgentLabel(agentId)),
    getAgentState(agentId)
  ));
  // Keep the legacy `maxAgentWindow` as an upper bound on visible chips even
  // when there's plenty of horizontal room, so the agents row scrolls for
  // long lists in the same way the legacy blessed view did.
  const cap = Math.max(1, Math.min(maxAgentWindow || labels.length, labels.length));
  let cappedStart = clampAgentWindowWithSelection({
    activeCount: labels.length,
    maxWindow: cap,
    windowStart: agentListWindowStart || 0,
    selectionIndex: selectedAgentIndex,
  });
  const cappedLabels = labels.slice(cappedStart, cappedStart + cap);
  const cappedSelected = focused && selectedAgentIndex >= cappedStart
    ? selectedAgentIndex - cappedStart
    : -1;
  const planned = planChipsRow({
    caption: "Agents",
    labels: cappedLabels,
    selectedIndex: cappedSelected,
    windowStart: 0,
    hint: globalMode ? (dashHints.agentsGlobal || dashHints.agents || "") : (dashHints.agents || ""),
    maxWidth,
    reserveHintWhenFocused: focused,
  });
  return {
    kind: "chips",
    caption: "Agents",
    leftMore: cappedStart > 0 || planned.leftMore,
    rightMore: (cappedStart + cap < labels.length) || planned.rightMore,
    windowStart: cappedStart,
    hint: planned.hint,
    items: planned.visible.map((item) => {
      const cappedIdx = item.absoluteIndex;
      const absolute = cappedStart + cappedIdx;
      const agentId = activeAgents[absolute];
      const active = Boolean(activeAgentId && agentId === activeAgentId);
      return {
        label: item.label,
        selected: focused && absolute === selectedAgentIndex,
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

/**
 * Render a chip row to plain text + ANSI color spans, sized to fit
 * `maxWidth`. Includes the caption, optional `< / >` markers, optional
 * `emptyLabel`, and the trailing hint when the planner kept it. Used as the
 * sole text payload of a row's <Text wrap="truncate">.
 */
function renderChipRowText(row, maxWidth = 80) {
  const budget = Math.max(1, Math.floor(Number(maxWidth) || 80));
  const { caption = "", items = [], hint = "", leftMore, rightMore, emptyLabel } = row || {};
  const captionText = `${caption}: `;
  let out = chalk.gray(captionText);
  let used = displayCellWidth(captionText);

  if (leftMore) {
    out += chalk.gray("< ");
    used += 2;
  }
  if (items.length === 0 && emptyLabel) {
    const remaining = Math.max(0, budget - used - (hint ? HINT_PREFIX_WIDTH + displayCellWidth(hint) : 0));
    const trimmedEmpty = truncateToCells(emptyLabel, remaining);
    out += chalk.cyan(trimmedEmpty);
    used += displayCellWidth(trimmedEmpty);
  }
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) {
      out += chalk.gray(CHIP_SEP);
      used += CHIP_SEP_WIDTH;
    }
    const item = items[i];
    const label = String(item.label || "");
    if (item.selected) {
      out += chalk.inverse(label);
    } else if (item.active) {
      out += chalk.bold.cyan(label);
    } else {
      out += chalk.cyan(label);
    }
    used += displayCellWidth(label);
  }
  if (rightMore) {
    out += chalk.gray(" >");
    used += 2;
  }
  if (hint) {
    const remaining = Math.max(0, budget - used);
    if (remaining > HINT_PREFIX_WIDTH + 1) {
      const hintBody = truncateToCells(hint, remaining - HINT_PREFIX_WIDTH);
      out += chalk.gray(`${HINT_PREFIX}${hintBody}`);
    }
  }
  return out;
}

function renderSummaryRowText(row, maxWidth = 80) {
  const budget = Math.max(1, Math.floor(Number(maxWidth) || 80));
  const { parts = [], agentItems = [] } = row || {};

  // Pre-render the non-Agents parts so we know how many cells they will
  // claim. Agents is special: it carries the full active list and we want
  // to fit as many chips as the remaining budget allows.
  const tailParts = parts.slice(1).map((part) => {
    const labelText = `${part.label}: `;
    const labelWidth = displayCellWidth(labelText);
    const value = String(part.value || "");
    return {
      label: part.label,
      labelText,
      labelColored: chalk.gray(labelText),
      labelWidth,
      value,
      width: labelWidth + displayCellWidth(value),
      colored: chalk.gray(labelText) + chalk.cyan(value),
      truncatable: part.label === "Loop",
    };
  });

  // How many cells would tail parts ideally claim (with their leading gap)?
  // We use this to reserve room for them when packing Agents chips, but we
  // never reserve so much that Agents can't fit at least one short chip
  // (otherwise narrow terminals show "Agents:  +N" with zero names).
  let tailIdealWidth = 0;
  for (const tp of tailParts) {
    tailIdealWidth += SUMMARY_GAP_WIDTH + tp.width;
  }
  // Cap reservation so Agents always gets at least ~12 cells to play with
  // when there's any agent to show — enough for "@a +N" on the narrowest
  // displays. The remaining tail parts will simply be dropped one by one.
  const minAgentRoom = 12;
  const captionWidth = displayCellWidth("Agents: ");
  const tailReserve = Math.min(
    tailIdealWidth,
    Math.max(0, budget - captionWidth - minAgentRoom)
  );

  let out = "";
  let used = 0;

  const agentsPart = parts[0];
  if (agentsPart && agentsPart.label === "Agents") {
    const labelText = "Agents: ";
    const labelWidth = displayCellWidth(labelText);
    out += chalk.gray(labelText);
    used += labelWidth;

    if (agentItems.length === 0) {
      const noneText = "none";
      out += chalk.cyan(noneText);
      used += displayCellWidth(noneText);
    } else {
      // Reserve room for the worst-case " +N" overflow tail so we never have
      // to backtrack and pop a chip after committing to it.
      const worstOverflow = ` +${agentItems.length}`;
      const worstOverflowWidth = displayCellWidth(worstOverflow);
      const agentBudget = Math.max(0, budget - used - tailReserve);
      let fittedCount = 0;
      let agentsUsed = 0;
      for (let i = 0; i < agentItems.length; i += 1) {
        const item = agentItems[i];
        const label = String(item.label || "");
        const sepWidth = i === 0 ? 0 : displayCellWidth(", ");
        const remainingItems = agentItems.length - i - 1;
        const reserveOverflow = remainingItems > 0 ? worstOverflowWidth : 0;
        const labelWidthInner = displayCellWidth(label);
        if (agentsUsed + sepWidth + labelWidthInner + reserveOverflow > agentBudget) break;
        if (i > 0) {
          out += chalk.gray(", ");
          agentsUsed += sepWidth;
        }
        if (item.active) out += chalk.bold.cyan(label);
        else out += chalk.cyan(label);
        agentsUsed += labelWidthInner;
        fittedCount += 1;
      }
      const overflow = agentItems.length - fittedCount;
      if (overflow > 0) {
        const tail = ` +${overflow}`;
        out += chalk.cyan(tail);
        agentsUsed += displayCellWidth(tail);
      }
      used += agentsUsed;
    }
  }

  for (let i = 0; i < tailParts.length; i += 1) {
    const part = tailParts[i];
    const remaining = budget - used - SUMMARY_GAP_WIDTH;
    if (remaining <= 0) break;
    if (part.width <= remaining) {
      out += chalk.gray(SUMMARY_GAP) + part.colored;
      used += SUMMARY_GAP_WIDTH + part.width;
      continue;
    }
    if (part.truncatable && remaining >= 6) {
      const valueRoom = Math.max(1, remaining - part.labelWidth);
      const trimmedValue = truncateToCells(part.value, valueRoom);
      out += chalk.gray(SUMMARY_GAP) + part.labelColored + chalk.cyan(trimmedValue);
      used += SUMMARY_GAP_WIDTH + part.labelWidth + displayCellWidth(trimmedValue);
    }
    break;
  }
  return out;
}

function createDashboardBar({ React, ink }) {
  const { Box, Text } = ink;
  const h = React.createElement;

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
      let text;
      if (row.kind === "summary") {
        text = renderSummaryRowText(row, maxWidth);
      } else if (row.kind === "message") {
        const value = String(row.text || "");
        text = chalk.gray(truncateToCells(value, maxWidth));
      } else {
        text = renderChipRowText(row, maxWidth);
      }
      return h(Box, { key: `dr-${idx}`, width: "100%" },
        h(Text, { wrap: "truncate" }, text || " "));
    });

    if (rows.length === 1) return h(Box, { width: "100%" }, rows[0]);
    return h(Box, { flexDirection: "column", width: "100%" }, ...rows);
  };
}

function renderDashboardLines(params) {
  const maxWidth = params.maxWidth || 80;
  const rows = buildDashboardRows(params);
  return rows.map((row) => {
    if (row.kind === "summary") return renderSummaryRowText(row, maxWidth);
    if (row.kind === "message") return chalk.gray(truncateToCells(String(row.text || ""), maxWidth));
    return renderChipRowText(row, maxWidth);
  });
}

module.exports = { createDashboardBar, buildDashboardRows, renderDashboardLines, formatLoopSummary };
