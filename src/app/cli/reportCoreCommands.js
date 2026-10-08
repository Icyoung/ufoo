"use strict";

async function sendAgentReportRequest(projectRoot, report) {
  const { enqueueAgentReport } = require("../../runtime/daemon/reportControlBus");
  const queued = await enqueueAgentReport(projectRoot, report);
  const entry = queued.report;
  return {
    type: "response",
    data: {
      reply: `Report queued (${entry.phase})`,
      report: entry,
      queued,
    },
  };
}

function getReportDetail(out = {}) {
  if (out.phase === "error") {
    return out.error || out.summary || out.message || out.task_id;
  }
  return out.summary || out.message || out.task_id;
}

function printReportOutput(out, json = false, queued = null) {
  if (json) {
    console.log(JSON.stringify({
      status: "queued",
      report: out,
      queued,
    }, null, 2));
    return;
  }
  const detail = getReportDetail(out);
  console.log(`[report] queued ${out.phase} ${out.agent_id} ${out.task_id} ${detail}`);
}

module.exports = { sendAgentReportRequest, printReportOutput };
