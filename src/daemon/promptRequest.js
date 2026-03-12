"use strict";

const { IPC_RESPONSE_TYPES } = require("../shared/eventContract");
const {
  listControllerInboxEntries,
  consumeControllerInboxEntries,
} = require("../report/store");

function buildPromptWithPrivateReports(prompt = "", reports = [], requestMeta = {}) {
  const meta = requestMeta && typeof requestMeta === "object" ? requestMeta : {};
  const hasMeta = Object.keys(meta).length > 0;
  if (!Array.isArray(reports) || reports.length === 0) {
    if (!hasMeta) return prompt;
    const lines = [];
    lines.push(prompt || "");
    lines.push("");
    lines.push("Routing request metadata (JSON):");
    lines.push(JSON.stringify(meta, null, 2));
    lines.push("");
    lines.push("Honor this metadata when choosing dispatch targets and injection_mode.");
    return lines.join("\n");
  }
  const lines = [];
  lines.push(prompt || "");
  lines.push("");
  if (hasMeta) {
    lines.push("Routing request metadata (JSON):");
    lines.push(JSON.stringify(meta, null, 2));
    lines.push("");
    lines.push("Honor this metadata when choosing dispatch targets and injection_mode.");
    lines.push("");
  }
  lines.push("Private runtime reports for ufoo-agent (JSON):");
  lines.push(JSON.stringify(reports, null, 2));
  lines.push("");
  lines.push("Use these runtime reports when deciding reply/dispatch/ops.");
  return lines.join("\n");
}

async function handlePromptRequest(options = {}) {
  const {
    projectRoot,
    req = {},
    socket,
    provider,
    model,
    processManager = null,
    runPromptWithAssistant,
    runUfooAgent,
    runAssistantTask,
    dispatchMessages,
    handleOps,
    markPending = () => {},
    reportTaskStatus = () => {},
    log = () => {},
  } = options;

  log(`prompt ${String(req.text || "").slice(0, 200)}`);
  const privateReports = listControllerInboxEntries(projectRoot, "ufoo-agent", { num: 100 });
  const promptText = buildPromptWithPrivateReports(req.text || "", privateReports, req.request_meta);

  try {
    const handled = await runPromptWithAssistant({
      projectRoot,
      prompt: promptText,
      provider,
      model,
      processManager,
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending,
      reportTaskStatus,
      maxAssistantLoops: 2,
      log,
    });

    if (!handled.ok) {
      log(`agent-fail ${handled.error || "agent failed"}`);
      socket.write(
        `${JSON.stringify({
          type: IPC_RESPONSE_TYPES.ERROR,
          error: handled.error || "agent failed",
        })}\n`,
      );
      return false;
    }

    consumeControllerInboxEntries(projectRoot, "ufoo-agent", privateReports);

    const payload = handled.payload || {};
    const opsResults = handled.opsResults || [];
    log(`ok reply=${Boolean(payload.reply)} dispatch=${(payload.dispatch || []).length} ops=${(payload.ops || []).length}`);
    socket.write(
      `${JSON.stringify({
        type: IPC_RESPONSE_TYPES.RESPONSE,
        data: payload,
        opsResults,
      })}\n`,
    );
    return true;
  } catch (err) {
    log(`error ${err.message || String(err)}`);
    socket.write(
      `${JSON.stringify({
        type: IPC_RESPONSE_TYPES.ERROR,
        error: err.message || String(err),
      })}\n`,
    );
    return false;
  }
}

module.exports = {
  handlePromptRequest,
  buildPromptWithPrivateReports,
};
