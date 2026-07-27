"use strict";

/**
 * Shared dashboard snapshot helpers for Rust chat host.
 */

const { formatLoopSummary } = require("../app/chat/dashboardView");

function loadGlobalProjectRows(activeProjectRoot = "") {
  const path = require("path");
  const {
    listProjectRuntimes,
    filterVisibleProjectRuntimes,
    isGlobalControllerProjectRoot,
    markProjectStopped,
    canonicalProjectRoot,
  } = require("../runtime/projects");

  function resolveRoot(row = {}) {
    const raw = String((row && (row.root || row.project_root || row.projectRoot)) || "").trim();
    if (!raw) return "";
    try {
      return canonicalProjectRoot(raw);
    } catch {
      return path.resolve(raw);
    }
  }

  let rows = listProjectRuntimes({ validate: true, cleanupTmp: true }) || [];
  for (const row of rows) {
    const status = String((row && row.status) || "").trim().toLowerCase();
    const root = resolveRoot(row);
    if (status === "stale" && root && !isGlobalControllerProjectRoot(root)) {
      try {
        markProjectStopped(root);
      } catch {
        // ignore
      }
    }
  }
  rows = filterVisibleProjectRuntimes(rows);
  rows = rows.filter((row) => !isGlobalControllerProjectRoot(resolveRoot(row)));
  return rows.map((row) => ({
    id: row.project_id || row.project_root || "",
    label: row.project_name || (row.project_root ? path.basename(row.project_root) : ""),
    root: row.project_root || "",
    status: row.status || "",
    active: resolveRoot(row) === String(activeProjectRoot || ""),
  }));
}

function cronTasksFromStatus(data = {}) {
  const cron = data && data.cron;
  const tasks = cron && Array.isArray(cron.tasks) ? cron.tasks : [];
  return tasks.map((task, index) => ({
    id: String((task && (task.id || task.task_id)) || `cron-${index}`),
    label: String((task && (task.label || task.name || task.summary || task.id)) || `cron-${index}`),
    summary: String((task && (task.summary || task.schedule || "")) || ""),
  }));
}

function buildDashboardPublishPayload(controller, data = {}) {
  const agents = controller.getAgentsSnapshot();
  const cron = cronTasksFromStatus(data);
  const loop = (data && data.loop) || agents.loop || null;
  const loopText = formatLoopSummary(loop);
  return {
    agents: agents.agents,
    footer: agents.footer,
    cron,
    loop,
    loop_summary: loopText,
  };
}

module.exports = {
  loadGlobalProjectRows,
  cronTasksFromStatus,
  buildDashboardPublishPayload,
  formatLoopSummary,
};
