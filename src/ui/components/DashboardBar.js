"use strict";

/**
 * DashboardBar — the bottom 1-2 rows in chat showing the current dashboard
 * mode (projects rail in global mode + one of agents/mode/provider/resume/
 * cron). Renders directly with ink primitives instead of going through
 * computeDashboardContent (which emits blessed-tag strings) so we don't
 * have to translate "{cyan-fg}…{/cyan-fg}" at render time.
 *
 * The agents window math (clamping the visible slice around the selection
 * cursor) is reused from src/chat/agentDirectory.js so the two TUIs scroll
 * the strip the same way.
 */

const { clampAgentWindowWithSelection } = require("../../chat/agentDirectory");

function createDashboardBar({ React, ink }) {
  const { Box, Text } = ink;
  const h = React.createElement;

  const sep = (key) =>
    h(Text, { key, color: "gray" }, "  ");

  const dim = (text, key) =>
    h(Text, { key, color: "gray" }, text);

  const renderItem = (label, selected, key) =>
    h(Text, { key, color: selected ? undefined : "cyan", inverse: selected }, label);

  const renderHint = (hint) =>
    hint ? h(Text, { color: "gray" }, ` · ${hint}`) : null;

  const ChipsRow = ({ caption, items, selectedIndex, hint, leftMore, rightMore }) =>
    h(Box, null,
      h(Text, { color: "gray" }, `${caption}: `),
      leftMore ? h(Text, { color: "gray" }, "< ") : null,
      ...items.map((item, idx) => h(React.Fragment, { key: idx },
        idx > 0 ? sep(`s-${idx}`) : null,
        renderItem(item.label, idx === selectedIndex, `c-${idx}`),
      )),
      rightMore ? h(Text, { color: "gray" }, " >") : null,
      renderHint(hint),
    );

  const NoneRow = ({ caption, hint }) =>
    h(Box, null,
      h(Text, { color: "gray" }, `${caption}: `),
      h(Text, { color: "cyan" }, "none"),
      renderHint(hint),
    );

  const ProjectRail = ({ projects, selectedIndex, focused, scope, dashboardHint, windowStart, maxItems }) => {
    if (!Array.isArray(projects) || projects.length === 0) {
      return h(Box, null,
        h(Text, { color: "gray" }, "Projects: "),
        h(Text, { color: "cyan" }, "(none registered)"),
        dashboardHint ? h(Text, { color: "gray" }, ` · ${dashboardHint}`) : null,
      );
    }
    const max = Math.max(1, Math.min(maxItems || 5, projects.length));
    const start = clampAgentWindowWithSelection({
      activeCount: projects.length,
      maxWindow: max,
      windowStart: windowStart || 0,
      selectionIndex: selectedIndex,
    });
    const end = start + max;
    const visible = projects.slice(start, end);
    const leftMore = start > 0;
    const rightMore = end < projects.length;
    return h(Box, { wrap: "truncate" },
      h(Text, { wrap: "truncate", color: "gray" }, "Projects: "),
      leftMore ? h(Text, { color: "gray" }, "< ") : null,
      ...visible.map((proj, renderedIdx) => {
        const idx = start + renderedIdx;
        return h(React.Fragment, { key: `p-${idx}` },
          renderedIdx > 0 ? sep(`p-sep-${idx}`) : null,
          h(Text, {
            wrap: "truncate",
            color: focused && idx === selectedIndex
              ? undefined
              : (proj.active ? "yellow" : "cyan"),
            inverse: focused && idx === selectedIndex,
          }, proj.label || proj.id || ""),
        );
      }),
      rightMore ? h(Text, { color: "gray" }, " >") : null,
      dashboardHint ? h(Text, { wrap: "truncate", color: "gray" }, ` · ${dashboardHint}`) : null,
    );
  };

  return function DashboardBar({
    dashboardView = "agents",
    focusMode = "input",
    globalMode = false,
    globalScope = "controller",
    activeAgents = [],
    activeAgentMeta = new Map(),
    selectedAgentIndex = -1,
    agentListWindowStart = 0,
    maxAgentWindow = 4,
    projectListWindowStart = 0,
    maxProjectWindow = 5,
    getAgentLabel = (id) => id,
    modeOptions = [],
    selectedModeIndex = 0,
    providerOptions = [],
    selectedProviderIndex = 0,
    resumeOptions = [],
    selectedResumeIndex = 0,
    cronTasks = [],
    selectedCronIndex = -1,
    projects = [],
    selectedProjectIndex = -1,
    activeProjectRoot = "",
    dashHints = {},
  }) {
    const dashboardFocused = focusMode === "dashboard";

    if (dashboardView === "mode") {
      return h(ChipsRow, {
        caption: "Mode",
        items: (modeOptions || []).map((m) => ({ label: m })),
        selectedIndex: selectedModeIndex,
        hint: dashHints.mode || "",
      });
    }
    if (dashboardView === "provider") {
      return h(ChipsRow, {
        caption: "Agent",
        items: (providerOptions || []).map((opt) => ({ label: opt.label || opt })),
        selectedIndex: selectedProviderIndex,
        hint: dashHints.provider || "",
      });
    }
    if (dashboardView === "resume") {
      return h(ChipsRow, {
        caption: "Resume",
        items: (resumeOptions || []).map((opt) => ({ label: opt.label || opt })),
        selectedIndex: selectedResumeIndex,
        hint: dashHints.resume || "",
      });
    }
    if (dashboardView === "cron") {
      const items = Array.isArray(cronTasks) ? cronTasks : [];
      if (items.length === 0) return h(NoneRow, { caption: "Cron", hint: dashHints.cron || "" });
      return h(ChipsRow, {
        caption: "Cron",
        items: items.map((it) => ({ label: it.label || it.summary || it.id || "" })).filter((x) => x.label),
        selectedIndex: selectedCronIndex,
        hint: dashHints.cron || "",
      });
    }

    // dashboardView === "projects" or "agents" (or fallback)
    const showProjects = globalMode && (dashboardView === "projects" || focusMode === "dashboard" && dashboardView === "agents");
    const projectRow = showProjects && projects.length > 0
      ? h(ProjectRail, {
          projects: projects.map((p) => ({
            ...p,
            active: p.root && p.root === activeProjectRoot,
          })),
          selectedIndex: selectedProjectIndex,
          focused: dashboardFocused && dashboardView === "projects",
          scope: globalScope,
          dashboardHint: dashHints.projects || "",
          windowStart: projectListWindowStart,
          maxItems: maxProjectWindow,
        })
      : null;

    let agentsRow;
    if (activeAgents.length === 0) {
      agentsRow = h(NoneRow, {
        caption: "Agents",
        hint: dashHints.agentsEmpty || "",
      });
    } else {
      const windowStart = clampAgentWindowWithSelection({
        activeCount: activeAgents.length,
        maxWindow: maxAgentWindow,
        windowStart: agentListWindowStart,
        selectionIndex: selectedAgentIndex,
      });
      const maxItems = Math.max(1, Math.min(maxAgentWindow, activeAgents.length));
      const visible = activeAgents.slice(windowStart, windowStart + maxItems);
      const items = visible.map((agentId, i) => {
        const meta = activeAgentMeta.get && activeAgentMeta.get(agentId);
        const label = `@${getAgentLabel(agentId, meta)}`;
        const absoluteIndex = windowStart + i;
        return { label, selected: absoluteIndex === selectedAgentIndex };
      });
      const leftMore = windowStart > 0;
      const rightMore = windowStart + maxItems < activeAgents.length;
      // ChipsRow uses selectedIndex relative to its own items array.
      const relSelected = selectedAgentIndex - windowStart;
      agentsRow = h(ChipsRow, {
        caption: "Agents",
        items,
        selectedIndex: relSelected,
        leftMore,
        rightMore,
        hint: globalMode
          ? (dashHints.agentsGlobal || dashHints.agents || "")
          : (dashHints.agents || ""),
      });
    }

    // In controller scope (top-level global mode) there are no agents —
    // only the projects rail. Hide the agents row entirely so we don't
    // print an empty 'Agents: none' line that confuses the user.
    if (globalMode && globalScope === "controller") {
      return projectRow || null;
    }

    if (projectRow) {
      return h(Box, { flexDirection: "column" }, projectRow, agentsRow);
    }
    return agentsRow;
  };
}

module.exports = { createDashboardBar };
