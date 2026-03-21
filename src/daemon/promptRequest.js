"use strict";

const { IPC_RESPONSE_TYPES } = require("../shared/eventContract");
const {
  listControllerInboxEntries,
  consumeControllerInboxEntries,
} = require("../report/store");
const { isGlobalControllerProjectRoot } = require("../globalMode");

function normalizeProjectRoute(route) {
  if (!route || typeof route !== "object") return null;
  const projectRoot = String(route.project_root || route.projectRoot || "").trim();
  if (!projectRoot) return null;
  return {
    project_root: projectRoot,
    project_name: String(route.project_name || route.projectName || "").trim(),
    prompt: String(route.prompt || route.message || "").trim(),
    reason: String(route.reason || "").trim(),
  };
}

function buildRoutedProjectPayload(basePayload = {}, route = {}) {
  const payload = basePayload && typeof basePayload === "object" ? { ...basePayload } : {};
  payload.routed_project = {
    project_root: String(route.project_root || ""),
    project_name: String(route.project_name || ""),
    reason: String(route.reason || ""),
  };
  return payload;
}

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
  lines.push("Treat them as control-plane observability, not automatic downstream delivery instructions.");
  lines.push("If report.meta.handoff.status is \"delivered\" and report.meta.needs_dispatch is not true, do not dispatch that handoff again.");
  lines.push("Only treat a report as a controller dispatch request when report.meta.needs_dispatch is true.");
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
    forwardProjectPrompt = null,
    log = () => {},
  } = options;

  log(`prompt ${String(req.text || "").slice(0, 200)}`);
  const requestMeta = req.request_meta && typeof req.request_meta === "object" ? req.request_meta : {};
  const isGlobalController = isGlobalControllerProjectRoot(projectRoot);
  const forcedProjectRoot = String(requestMeta.force_project_root || "").trim();

  if (isGlobalController && forcedProjectRoot) {
    try {
      const routed = await Promise.resolve(forwardProjectPrompt({
        targetProjectRoot: forcedProjectRoot,
        targetProjectName: String(requestMeta.force_project_name || "").trim(),
        prompt: req.text || "",
        routeReason: "forced_project_root",
        requestMeta,
      }));
      if (!routed || routed.ok !== true) {
        const error = routed && routed.error ? routed.error : "project forward failed";
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.ERROR,
            error,
          })}\n`,
        );
        return false;
      }
      const payload = buildRoutedProjectPayload(routed.payload || {}, {
        project_root: routed.project_root || forcedProjectRoot,
        project_name: routed.project_name || String(requestMeta.force_project_name || "").trim(),
        reason: "forced_project_root",
      });
      socket.write(
        `${JSON.stringify({
          type: IPC_RESPONSE_TYPES.RESPONSE,
          data: payload,
          opsResults: routed.opsResults || [],
        })}\n`,
      );
      return true;
    } catch (err) {
      socket.write(
        `${JSON.stringify({
          type: IPC_RESPONSE_TYPES.ERROR,
          error: err.message || String(err),
        })}\n`,
      );
      return false;
    }
  }

  const privateReports = listControllerInboxEntries(projectRoot, "ufoo-agent", { num: 100 });
  const promptText = buildPromptWithPrivateReports(req.text || "", privateReports, requestMeta);
  const useGlobalProjectRouter = isGlobalController;

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
      ufooAgentOptions: useGlobalProjectRouter ? { routingMode: "global-router" } : {},
      finalizeLocally: !useGlobalProjectRouter,
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

    if (useGlobalProjectRouter) {
      const route = normalizeProjectRoute(handled.payload && handled.payload.project_route);
      if (route) {
        const routed = await Promise.resolve(forwardProjectPrompt({
          targetProjectRoot: route.project_root,
          targetProjectName: route.project_name,
          prompt: route.prompt || req.text || "",
          routeReason: route.reason,
          requestMeta,
        }));
        if (!routed || routed.ok !== true) {
          log(`project-forward-fail ${route.project_root} ${(routed && routed.error) || "project forward failed"}`);
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.ERROR,
              error: (routed && routed.error) || "project forward failed",
            })}\n`,
          );
          return false;
        }

        consumeControllerInboxEntries(projectRoot, "ufoo-agent", privateReports);
        const routedPayload = buildRoutedProjectPayload(routed.payload || {}, {
          project_root: routed.project_root || route.project_root,
          project_name: routed.project_name || route.project_name,
          reason: route.reason,
        });
        log(`project-forward-ok ${route.project_root}`);
        socket.write(
          `${JSON.stringify({
            type: IPC_RESPONSE_TYPES.RESPONSE,
            data: routedPayload,
            opsResults: routed.opsResults || [],
          })}\n`,
        );
        return true;
      }
    }

    consumeControllerInboxEntries(projectRoot, "ufoo-agent", privateReports);

    const payload = handled.payload && typeof handled.payload === "object"
      ? { ...handled.payload }
      : {};
    if (useGlobalProjectRouter) {
      delete payload.project_route;
      delete payload.disambiguate;
      payload.dispatch = [];
      payload.ops = [];
    }
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
