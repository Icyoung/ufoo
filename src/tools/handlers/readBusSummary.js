const { buildStatus } = require("../../daemon/status");

function readBusSummaryHandler(ctx = {}) {
  const status = buildStatus(ctx.projectRoot);
  const activeAgents = Array.isArray(status.active_meta) ? status.active_meta : [];
  const busyCount = activeAgents.filter((item) => {
    const state = String((item && item.activity_state) || "").trim().toLowerCase();
    return state === "working"
      || state === "starting"
      || state === "running"
      || state === "waiting_input"
      || state === "blocked";
  }).length;

  return {
    project_root: ctx.projectRoot,
    summary: {
      active_count: activeAgents.length,
      busy_count: busyCount,
      ready_count: Math.max(activeAgents.length - busyCount, 0),
      unread_total: Number(status.unread && status.unread.total ? status.unread.total : 0) || 0,
      decisions_open: Number(status.decisions && status.decisions.open ? status.decisions.open : 0) || 0,
      reports_pending_total: Number(status.reports && status.reports.pending_total ? status.reports.pending_total : 0) || 0,
      controller_pending_total: Number(status.controller && status.controller.pending_total ? status.controller.pending_total : 0) || 0,
      cron_count: Number(status.cron && status.cron.count ? status.cron.count : 0) || 0,
      groups_active: Number(status.groups && status.groups.active ? status.groups.active : 0) || 0,
    },
    active_agents: activeAgents,
  };
}

module.exports = {
  readBusSummaryHandler,
};
