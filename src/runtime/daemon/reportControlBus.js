"use strict";

const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");
const {
  ensureDir,
  generateInstanceId,
} = require("../../coordination/bus/utils");
const {
  DeliveryQueue,
  QUEUE_TYPES,
  normalizeQueueEnvelope,
} = require("../../coordination/bus/deliveryQueue");

const REPORT_CONTROL_TARGET = "ufoo-agent";
const REPORT_CONTROL_EVENT = "agent_report";
const REPORT_CONTROL_TYPE = "control/report";
const { withFileLock } = require("../../coordination/state/fileLock");
const { normalizeReportInput, normalizePhase, loadReportState } = require("../../coordination/report/store");
const draining = new Set();

function getReportControlQueueDir(projectRoot) {
  const paths = getUfooPaths(projectRoot);
  return path.join(paths.busDir, "control", "report");
}

function getReportControlQueueFile(projectRoot) {
  return path.join(getReportControlQueueDir(projectRoot), "pending.jsonl");
}

function ensureReportControlQueue(projectRoot) {
  const queueDir = getReportControlQueueDir(projectRoot);
  ensureDir(queueDir);
  return queueDir;
}

function resolveReportPublisher(report = {}) {
  const fromReport = String(report.agent_id || report.agentId || "").trim();
  if (fromReport) return fromReport;
  const fromEnv = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
  return fromEnv || "unknown-agent";
}

function buildReportControlData(report = {}, options = {}) {
  return {
    request_id: options.requestId || `report-${Date.now().toString(36)}-${generateInstanceId()}`,
    queued_at: options.queuedAt || new Date().toISOString(),
    report,
  };
}

function buildReportControlEvent(report = {}, options = {}) {
  const data = buildReportControlData(report, options);
  return {
    timestamp: data.queued_at,
    type: REPORT_CONTROL_TYPE,
    event: REPORT_CONTROL_EVENT,
    publisher: options.publisher || resolveReportPublisher(report),
    target: REPORT_CONTROL_TARGET,
    data,
  };
}

async function enqueueAgentReport(projectRoot, report, options = {}) {
  ensureReportControlQueue(projectRoot);
  return withFileLock(getReportControlQueueFile(projectRoot), () => {
    const queue = new DeliveryQueue(getReportControlQueueFile(projectRoot));
    const publisher = options.publisher || resolveReportPublisher(report);
    const pending = { ...(loadReportState(projectRoot).agents[publisher]?.pending || {}) };
    const controls = [...queue.processingFiles().flatMap((file) => {
      return require("../../coordination/bus/utils").readJSONL(file);
    }), ...queue.readPendingRaw()];
    for (const control of controls) {
      const entry = control.data?.report;
      if (!entry || entry.agent_id !== publisher) continue;
      if (["start", "progress"].includes(entry.phase)) pending[entry.task_id] = entry;
      else delete pending[entry.task_id];
    }
    let taskId = String(report.task_id || report.taskId || report.task || "").trim();
    if (!taskId && normalizePhase(report.phase) !== "start") {
      const tasks = Object.keys(pending);
      if (tasks.length > 1) throw new Error("Multiple active tasks; specify --task / task_id for this report");
      taskId = tasks[0];
    }
    const entry = normalizeReportInput({ ...report, agent_id: publisher, task_id: taskId });
    const event = normalizeQueueEnvelope(buildReportControlEvent(entry, options), {
      queueType: QUEUE_TYPES.REPORT,
      delivery: { mode: "daemon_consume", gate: "none", max_inflight: 1 },
      ack: { policy: "on_consume" },
    });
    queue.append(event);

    return {
      queued: true,
      request_id: event.data.request_id,
      target: REPORT_CONTROL_TARGET,
      targets: [REPORT_CONTROL_TARGET],
      report: entry,
    };
  });
}

async function drainReportControlEvents(projectRoot, handle) {
  const queueFile = getReportControlQueueFile(projectRoot);
  if (draining.has(queueFile)) return 0;
  draining.add(queueFile);
  const queue = new DeliveryQueue(queueFile);
  let consumed = 0;
  try {
    while (true) {
      const claim = withFileLock(queueFile, () => {
        queue.recover();
        if (queue.processingFiles().length) return null;
        return queue.claimNext();
      });
      if (!claim) break;
      try {
        const handled = await handle(claim.event);
        if (handled === false) { queue.restoreClaim(claim); break; }
        queue.completeClaim(claim);
        consumed += 1;
      } catch (error) { queue.restoreClaim(claim); throw error; }
    }
    return consumed;
  } finally { draining.delete(queueFile); }
}

function isAgentReportControlEvent(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (evt.target !== REPORT_CONTROL_TARGET) return false;
  if (evt.type !== REPORT_CONTROL_TYPE) return false;
  if (evt.event !== REPORT_CONTROL_EVENT) return false;
  const data = evt.data && typeof evt.data === "object" ? evt.data : {};
  return Boolean(data.report && typeof data.report === "object");
}

function extractAgentReportControl(evt) {
  if (!isAgentReportControlEvent(evt)) return null;
  const data = evt.data && typeof evt.data === "object" ? evt.data : {};
  return {
    report: normalizeReportInput(data.report, { entry_id: data.request_id, ts: data.report.ts || data.queued_at || evt.timestamp || evt.ts }),
    request_id: data.request_id || "",
    queued_at: data.queued_at || evt.timestamp || evt.ts || "",
  };
}

module.exports = {
  REPORT_CONTROL_TARGET,
  REPORT_CONTROL_EVENT,
  REPORT_CONTROL_TYPE,
  getReportControlQueueDir,
  getReportControlQueueFile,
  ensureReportControlQueue,
  resolveReportPublisher,
  buildReportControlData,
  buildReportControlEvent,
  enqueueAgentReport,
  drainReportControlEvents,
  isAgentReportControlEvent,
  extractAgentReportControl,
};
