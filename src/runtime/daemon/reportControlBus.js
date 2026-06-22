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

  const event = normalizeQueueEnvelope(buildReportControlEvent(report, options), {
    queueType: QUEUE_TYPES.REPORT,
    delivery: { mode: "daemon_consume", gate: "none", max_inflight: 1 },
    ack: { policy: "on_consume" },
  });
  new DeliveryQueue(getReportControlQueueFile(projectRoot)).append(event);

  return {
    queued: true,
    request_id: event.data.request_id,
    target: REPORT_CONTROL_TARGET,
    targets: [REPORT_CONTROL_TARGET],
    report,
  };
}

function takeReportControlEvents(projectRoot) {
  const queueFile = getReportControlQueueFile(projectRoot);
  const queue = new DeliveryQueue(queueFile);
  const events = [];
  queue.recover();
  while (true) {
    const claim = queue.claimNext();
    if (!claim) break;
    events.push(claim.event);
    queue.completeClaim(claim);
  }
  return events;
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
    report: data.report,
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
  takeReportControlEvents,
  isAgentReportControlEvent,
  extractAgentReportControl,
};
