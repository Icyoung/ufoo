"use strict";

const { IPC_RESPONSE_TYPES } = require("../contracts/eventContract");
const {
  listControllerInboxEntries,
  consumeControllerInboxEntries,
} = require("../../coordination/report/store");
const { isGlobalControllerProjectRoot } = require("../projects");

function normalizeProjectRoute(route) {
  if (!route || typeof route !== "object") return null;
  const projectRoot = String(route.project_root || "").trim();
  if (!projectRoot) return null;
  return {
    project_root: projectRoot,
    project_name: String(route.project_name || "").trim(),
    prompt: String(route.prompt || "").trim(),
    reason: String(route.reason || "").trim(),
  };
}

function buildRoutedProjectPayload(payload = {}, route = {}) {
  return {
    ...payload,
    routed_project: {
      project_root: String(route.project_root || ""),
      project_name: String(route.project_name || ""),
      reason: String(route.reason || ""),
    },
  };
}

async function handlePromptRequest({
  projectRoot,
  req = {},
  socket,
  runMainAgent,
  forwardProjectPrompt,
  log = () => {},
} = {}) {
  const text = String(req.text ?? req.prompt ?? "");
  const requestMeta = req.request_meta && typeof req.request_meta === "object" && !Array.isArray(req.request_meta)
    ? req.request_meta : {};
  const requestId = String(req.request_id || req.message_id || req.msg_id || req.id || "").trim() || undefined;
  const sessionId = req.session_id || requestMeta.session_id || "main-default";
  const global = isGlobalControllerProjectRoot(projectRoot);
  const respond = (payload, opsResults = []) => {
    socket.write(`${JSON.stringify({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: payload,
      opsResults,
    })}\n`);
    return true;
  };
  const forward = async (route) => {
    if (typeof forwardProjectPrompt !== "function") {
      throw new Error("project forwarding is unavailable");
    }
    const routed = await forwardProjectPrompt({
      targetProjectRoot: route.project_root,
      targetProjectName: route.project_name,
      prompt: route.prompt || text,
      routeReason: route.reason,
      requestMeta,
    });
    if (!routed || routed.ok !== true) {
      throw new Error(routed?.error || "project forward failed");
    }
    return {
      payload: buildRoutedProjectPayload(routed.payload || {}, {
        project_root: routed.project_root || route.project_root,
        project_name: routed.project_name || route.project_name,
        reason: route.reason,
      }),
      opsResults: routed.opsResults || [],
    };
  };
  log(`prompt ${text.slice(0, 200)}`);
  try {
    if (global && requestMeta.force_project_root) {
      const routed = await forward({
        project_root: String(requestMeta.force_project_root).trim(),
        project_name: String(requestMeta.force_project_name || "").trim(),
        prompt: text,
        reason: "forced_project_root",
      });
      return respond(routed.payload, routed.opsResults);
    }
    if (typeof runMainAgent !== "function") {
      throw new Error("main agent runtime is unavailable");
    }
    const reports = listControllerInboxEntries(projectRoot, "ufoo-agent", { num: 100 });
    const handled = await runMainAgent({
      projectRoot,
      originalPrompt: text,
      requestId,
      sessionId,
      requestMeta,
    });
    if (!handled || handled.ok !== true) {
      throw Object.assign(new Error(handled?.error || "agent failed"), { code: handled?.code });
    }
    let payload = handled.payload && typeof handled.payload === "object" ? { ...handled.payload } : {};
    let opsResults = handled.opsResults || [];
    if (global) {
      const route = normalizeProjectRoute(payload.project_route);
      if (route) {
        const routed = await forward(route);
        payload = routed.payload;
        opsResults = routed.opsResults;
        log(`project-forward-ok ${route.project_root}`);
      } else {
        delete payload.project_route;
        delete payload.disambiguate;
        payload.dispatch = [];
        payload.ops = [];
      }
    }
    consumeControllerInboxEntries(projectRoot, "ufoo-agent", reports);
    log(`ok reply=${Boolean(payload.reply)} dispatch=${(payload.dispatch || []).length} ops=${(payload.ops || []).length}`);
    return respond(payload, opsResults);
  } catch (error) {
    log(`error ${error.message || String(error)}`);
    socket.write(`${JSON.stringify({
      type: IPC_RESPONSE_TYPES.ERROR,
      error: error.message || String(error),
      ...(error.code ? { code: error.code } : {}),
    })}\n`);
    return false;
  }
}

module.exports = { handlePromptRequest };
