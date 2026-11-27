"use strict";

/**
 * Shared dashboard snapshot helpers for Rust chat host.
 */

const { formatLoopSummary } = require("./format/loopSummary");

function loadGlobalProjectRows(activeProjectRoot = "") {
  const path = require("path");
  const {
    listProjectRuntimes,
    filterVisibleProjectRuntimes,
    isGlobalControllerProjectRoot,
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

  let rows = listProjectRuntimes({ validate: true, cleanupTmp: false }) || [];
  rows = filterVisibleProjectRuntimes(rows);
  rows = rows.filter((row) => {
    if (row && row.validation && row.validation.project_exists === false) return false;
    const root = resolveRoot(row);
    return Boolean(root) && !isGlobalControllerProjectRoot(root);
  });
  const deduped = new Map();
  for (const row of rows) {
    const root = resolveRoot(row);
    if (!root || deduped.has(root)) continue;
    deduped.set(root, {
      id: row.project_id || root,
      label: row.project_name || path.basename(root) || root,
      root,
      status: row.status || "",
      active: root === String(activeProjectRoot || ""),
    });
  }
  return Array.from(deduped.values()).sort(
    (a, b) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.root.localeCompare(b.root)
  );
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
