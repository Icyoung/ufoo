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

    // Compose dashboard rows. Both modes treat the dashboard as a flat
    // list of views; the difference is the viewport size:
    //   project mode → 1 visible row
    //   global mode → 2 visible rows
    // Each row renders one view; the highlighted row matches dashboardView.
    const sequence = globalMode
      ? ["projects", "agents", "mode", "provider", "cron"]
      : ["agents", "mode", "provider", "cron"];
    const viewportSize = globalMode ? 2 : 1;
    const cursorIdx = Math.max(0, sequence.indexOf(dashboardView));
    let viewStart = cursorIdx;
    if (cursorIdx >= viewportSize) viewStart = cursorIdx - viewportSize + 1;
    const visibleViews = sequence.slice(viewStart, viewStart + viewportSize);

    const renderForView = (view) => {
      if (view === "projects") {
        if (!Array.isArray(projects) || projects.length === 0) {
          return h(Box, null,
            h(Text, { color: "gray" }, "Projects: "),
            h(Text, { color: "cyan" }, "(none registered)"),
          );
        }
        const max = Math.max(1, Math.min(maxProjectWindow || 5, projects.length));
        const start = clampAgentWindowWithSelection({
          activeCount: projects.length,
          maxWindow: max,
          windowStart: projectListWindowStart || 0,
          selectionIndex: selectedProjectIndex,
        });
        const end = start + max;
        const visible = projects.slice(start, end).map((p) => ({
          ...p,
          active: p.root && p.root === activeProjectRoot,
        }));
        return h(Box, { wrap: "truncate" },
          h(Text, { wrap: "truncate", color: "gray" }, "Projects: "),
          start > 0 ? h(Text, { color: "gray" }, "< ") : null,
          ...visible.map((proj, renderedIdx) => {
            const idx = start + renderedIdx;
            const focused = dashboardFocused && view === dashboardView && idx === selectedProjectIndex;
            return h(React.Fragment, { key: `p-${idx}` },
              renderedIdx > 0 ? sep(`p-sep-${idx}`) : null,
              h(Text, {
                wrap: "truncate",
                color: focused ? undefined : (proj.active ? "yellow" : "cyan"),
                inverse: focused,
              }, proj.label || proj.id || ""),
            );
          }),
          end < projects.length ? h(Text, { color: "gray" }, " >") : null,
        );
      }
      if (view === "agents") {
        if (activeAgents.length === 0) {
          return h(NoneRow, { caption: "Agents", hint: dashHints.agentsEmpty || "" });
        }
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
          return { label, selected: dashboardFocused && view === dashboardView && (windowStart + i) === selectedAgentIndex };
        });
        return h(ChipsRow, {
          caption: "Agents",
          items,
          selectedIndex: dashboardFocused && view === dashboardView ? selectedAgentIndex - windowStart : -1,
          leftMore: windowStart > 0,
          rightMore: windowStart + maxItems < activeAgents.length,
          hint: globalMode
            ? (dashHints.agentsGlobal || dashHints.agents || "")
            : (dashHints.agents || ""),
        });
      }
      if (view === "mode") {
        return h(ChipsRow, {
          caption: "Mode",
          items: (modeOptions || []).map((m) => ({ label: m })),
          selectedIndex: dashboardFocused && view === dashboardView ? selectedModeIndex : -1,
          hint: dashHints.mode || "",
        });
      }
      if (view === "provider") {
        return h(ChipsRow, {
          caption: "Engine",
          items: (providerOptions || []).map((opt) => ({ label: opt.label || opt })),
          selectedIndex: dashboardFocused && view === dashboardView ? selectedProviderIndex : -1,
          hint: dashHints.provider || "",
        });
      }
      if (view === "cron") {
        const items = Array.isArray(cronTasks) ? cronTasks : [];
        if (items.length === 0) return h(NoneRow, { caption: "Cron", hint: dashHints.cron || "" });
        return h(ChipsRow, {
          caption: "Cron",
          items: items.map((it) => ({ label: it.label || it.summary || it.id || "" })).filter((x) => x.label),
          selectedIndex: dashboardFocused && view === dashboardView ? selectedCronIndex : -1,
          hint: dashHints.cron || "",
        });
      }
      return null;
    };

    const rows = visibleViews.map((view, idx) =>
      h(Box, { key: `dr-${view}-${idx}` }, renderForView(view))
    );

    if (rows.length === 1) return rows[0];
    return h(Box, { flexDirection: "column" }, ...rows);
  };
}

module.exports = { createDashboardBar };
