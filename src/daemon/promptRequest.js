"use strict";

const { IPC_RESPONSE_TYPES } = require("../shared/eventContract");
const {
  listControllerInboxEntries,
  consumeControllerInboxEntries,
} = require("../report/store");
const { isGlobalControllerProjectRoot } = require("../projects");
const {
  resolveGateRouterConfig,
  shouldUseGateRouter,
} = require("../controller/gateRouter");
const {
  CONTROLLER_MODES,
  applyControllerModeForMessage,
  resolveControllerMode,
} = require("../controller/flags");
const {
  resolveLoopRuntimeOptions,
  runPromptWithControllerLoop,
} = require("../agent/loopRuntime");
const {
  appendShadowDiff,
  createLoopObserver,
} = require("../agent/loopObservability");
const {
  DEFAULT_SHADOW_SAMPLING_RATE,
  createShadowBudgetBreaker,
  createShadowGuard,
  shouldSampleShadow,
} = require("../controller/shadowGuard");

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

function normalizeMessageId(req = {}) {
  return String(req.request_id || req.message_id || req.msg_id || req.id || "").trim();
}

function summarizeShadowPayload(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return {
      reply_present: false,
      dispatch_count: 0,
      ops_count: 0,
      terminal_reason: "",
    };
  }
  return {
    reply_present: Boolean(payload.reply),
    dispatch_count: Array.isArray(payload.dispatch) ? payload.dispatch.length : 0,
    ops_count: Array.isArray(payload.ops) ? payload.ops.length : 0,
    terminal_reason: payload.loop && typeof payload.loop === "object"
      ? String(payload.loop.terminal_reason || "").trim()
      : "",
  };
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
    runPromptWithControllerLoop: injectedLoopRunner = runPromptWithControllerLoop,
    runUfooAgent,
    runUfooRouteAgent,
    dispatchMessages,
    handleOps,
    ackBus,
    markPending = () => {},
    reportTaskStatus = () => {},
    forwardProjectPrompt = null,
    log = () => {},
  } = options;

  log(`prompt ${String(req.text || "").slice(0, 200)}`);
  const requestMeta = req.request_meta && typeof req.request_meta === "object" ? req.request_meta : {};
  const messageId = normalizeMessageId(req);
  const requestedControllerMode = String(
    requestMeta.controller_mode || requestMeta.agent_execution_path || ""
  ).trim();
  let controllerMode = resolveControllerMode({
    projectRoot,
    requestedMode: requestedControllerMode,
  });
  const isGlobalController = isGlobalControllerProjectRoot(projectRoot);
  const forcedProjectRoot = String(requestMeta.force_project_root || "").trim();
  const resolvedLoopRuntime = resolveLoopRuntimeOptions();
  if (controllerMode === CONTROLLER_MODES.LEGACY && resolvedLoopRuntime.enabled) {
    controllerMode = CONTROLLER_MODES.LOOP;
  }
  const controllerObserver = createLoopObserver({
    projectRoot,
    enabled: true,
    defaults: {
      controller_mode: controllerMode,
    },
  });
  const appliedControllerMode = applyControllerModeForMessage({
    projectRoot,
    nextMode: controllerMode,
    messageId,
  });
  if (appliedControllerMode.transition) {
    controllerObserver.emit("controller.flag.transition", appliedControllerMode.transition);
  }
  const loopRuntime = {
    ...resolvedLoopRuntime,
    enabled: controllerMode === CONTROLLER_MODES.LOOP,
  };
  const shadowEnabled = controllerMode === CONTROLLER_MODES.SHADOW;

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
  const useGlobalProjectRouter = isGlobalController;
  const ufooAgentOptions = useGlobalProjectRouter ? { routingMode: "global-router" } : { controllerMode };
  let nextRequestMeta = requestMeta;
  const hasExplicitRequestMeta = Object.keys(nextRequestMeta).length > 0;
  if (hasExplicitRequestMeta && !Object.prototype.hasOwnProperty.call(nextRequestMeta, "agent_execution_path") && controllerMode !== CONTROLLER_MODES.LEGACY) {
    nextRequestMeta = {
      ...nextRequestMeta,
      agent_execution_path: controllerMode,
    };
  }
  let forceMainRouterFallback = false;

  const logGateRouterEvent = (event, details = {}) => {
    controllerObserver.emit(event, details);
    if (typeof log !== "function") return;
    log(`event ${JSON.stringify({ event, ...details })}`);
  };

  const attachGateRouterMeta = (reason, detail = {}) => {
    nextRequestMeta = {
      ...nextRequestMeta,
      gate_router: {
        attempted: true,
        reason,
        ...detail,
      },
    };
  };

  controllerObserver.emit("controller.prompt_path_selected", {
    applied_from_msg_id: messageId,
    shadow_enabled: shadowEnabled,
    loop_enabled: loopRuntime.enabled,
  });

  const gateRouterEligibility = shouldUseGateRouter({
    projectRoot,
    prompt: req.text || "",
    requestMeta: nextRequestMeta,
  });
  const gateRouterConfig = gateRouterEligibility.enabled
    ? resolveGateRouterConfig({
      projectRoot,
      requestMeta,
    })
    : null;

  if (!useGlobalProjectRouter && gateRouterEligibility.enabled && typeof runUfooRouteAgent === "function") {
    logGateRouterEvent("controller.gate_router_attempted", {
      flag: gateRouterEligibility.executionPath,
      intent_reason: gateRouterEligibility.intent.reason,
    });

    const routed = await runUfooRouteAgent({
      projectRoot,
      prompt: req.text || "",
      provider: gateRouterConfig.provider,
      model: gateRouterConfig.model,
      timeoutMs: gateRouterConfig.timeoutMs,
    });

    if (!routed || routed.ok !== true) {
      attachGateRouterMeta("provider_error", {
        error: routed && routed.error ? routed.error : "route_agent_failed",
      });
      forceMainRouterFallback = true;
      logGateRouterEvent("controller.gate_router_upgraded", {
        reason: "provider_error",
        fallback_used: "main_router",
      });
    } else {
      const route = routed.route || {};
      const canDispatch = route.decision === "direct_dispatch"
        && route.target && route.target !== "unknown"
        && route.confidence >= gateRouterConfig.confidenceThreshold;

      if (!canDispatch) {
        const upgradeReason = route.decision && route.decision !== "direct_dispatch"
          ? route.decision
          : "low_confidence";
        attachGateRouterMeta(upgradeReason, {
          decision: route.decision || "",
          target: route.target || "unknown",
          confidence: Number(route.confidence || 0),
          route_reason: route.reason || "",
        });
        forceMainRouterFallback = true;
        logGateRouterEvent("controller.gate_router_upgraded", {
          reason: upgradeReason,
          decision: route.decision || "",
          target: route.target || "unknown",
          confidence: Number(route.confidence || 0),
          fallback_used: "main_router",
        });
      } else {
        const payload = {
          reply: "",
          dispatch: [{
            target: route.target,
            message: route.message || req.text || "",
            injection_mode: route.injection_mode || "immediate",
            source: "ufoo-agent-gate-router",
          }],
          ops: [],
        };
        try {
          markPending(route.target);
          await dispatchMessages(projectRoot, payload.dispatch);
          consumeControllerInboxEntries(projectRoot, "ufoo-agent", privateReports);
          logGateRouterEvent("controller.gate_router_completed", {
            target: route.target,
            confidence: Number(route.confidence || 0),
            provider: routed.meta && routed.meta.provider ? routed.meta.provider : "",
            model: routed.meta && routed.meta.model ? routed.meta.model : "",
            fallback_used: "none",
          });
          socket.write(
            `${JSON.stringify({
              type: IPC_RESPONSE_TYPES.RESPONSE,
              data: payload,
              opsResults: [],
            })}\n`,
          );
          return true;
        } catch (err) {
          attachGateRouterMeta("dispatch_failed", {
            target: route.target,
            confidence: Number(route.confidence || 0),
            route_reason: route.reason || "",
            error: err && err.message ? err.message : String(err),
          });
          forceMainRouterFallback = true;
          logGateRouterEvent("controller.gate_router_upgraded", {
            reason: "dispatch_failed",
            target: route.target,
            confidence: Number(route.confidence || 0),
            fallback_used: "main_router",
          });
        }
      }
    }
  }

  const promptText = buildPromptWithPrivateReports(req.text || "", privateReports, nextRequestMeta);
  const promptRunner = loopRuntime.enabled
    && !forceMainRouterFallback
    && typeof injectedLoopRunner === "function"
    ? injectedLoopRunner
    : runPromptWithAssistant;

  try {
    const handled = await promptRunner({
      projectRoot,
      prompt: promptText,
      provider,
      model,
      processManager,
      runUfooAgent,
      runPromptWithControllerLoop: injectedLoopRunner,
      dispatchMessages,
      handleOps,
      ackBus,
      markPending,
      reportTaskStatus,
      maxAssistantLoops: 2,
      log,
      ufooAgentOptions,
      finalizeLocally: !useGlobalProjectRouter,
      loopRuntime,
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

    let shadowResult = null;
    if (shadowEnabled && !useGlobalProjectRouter && typeof injectedLoopRunner === "function") {
      const shadowObserver = createLoopObserver({
        projectRoot,
        enabled: true,
        defaults: {
          controller_mode: controllerMode,
          shadow_only: true,
        },
      });

      const shadowSamplingRate = Number.isFinite(Number(requestMeta.shadow_sampling_rate))
        ? Math.max(0, Math.min(1, Number(requestMeta.shadow_sampling_rate)))
        : DEFAULT_SHADOW_SAMPLING_RATE;
      const sampling = shouldSampleShadow({ messageId, samplingRate: shadowSamplingRate });
      const budgetBreaker = createShadowBudgetBreaker({ projectRoot });
      const budgetStatus = budgetBreaker.check();

      if (!sampling.sampled) {
        shadowObserver.emit("controller.shadow.skipped", {
          applied_from_msg_id: messageId,
          reason: "sampling_excluded",
          sampling_rate: sampling.rate,
        });
      } else if (!budgetStatus.allowed) {
        shadowObserver.emit("controller.shadow.skipped", {
          applied_from_msg_id: messageId,
          reason: budgetStatus.reason,
          sampling_rate: sampling.rate,
        });
      } else {
        const shadowGuard = createShadowGuard({ projectRoot });
        const noOpExecutors = shadowGuard.buildNoOpExecutors();
        const beforeSnapshot = shadowGuard.takeSnapshot();

        shadowObserver.emit("controller.shadow.started", {
          applied_from_msg_id: messageId,
          primary_mode: CONTROLLER_MODES.LEGACY,
          candidate_mode: CONTROLLER_MODES.LOOP,
          sampling_rate: sampling.rate,
        });

        try {
          shadowResult = await injectedLoopRunner({
            projectRoot,
            prompt: promptText,
            provider,
            model,
            processManager,
            runUfooAgent,
            dispatchMessages: noOpExecutors.dispatchMessages,
            handleOps: noOpExecutors.handleOps,
            ackBus: noOpExecutors.ackBus,
            markPending: noOpExecutors.markPending,
            reportTaskStatus,
            maxAssistantLoops: 2,
            log,
            ufooAgentOptions,
            finalizeLocally: false,
            loopRuntime: {
              ...resolvedLoopRuntime,
              enabled: true,
            },
            observer: shadowObserver,
            observabilityDefaults: {
              controller_mode: controllerMode,
              shadow_only: true,
            },
          });
        } catch (shadowErr) {
          shadowResult = {
            ok: false,
            error: shadowErr && shadowErr.message ? shadowErr.message : String(shadowErr),
          };
        }

        const assertion = shadowGuard.assertNoSideEffects(beforeSnapshot);
        if (!assertion.ok) {
          shadowObserver.emit("controller.shadow.violation", {
            applied_from_msg_id: messageId,
            violations: assertion.violations,
          });
        }

        const loopSummary = shadowResult && shadowResult.payload && shadowResult.payload.loop
          ? shadowResult.payload.loop
          : null;
        const totalInputTokens = loopSummary && typeof loopSummary.total_tokens === "number"
          ? loopSummary.total_tokens
          : 0;
        budgetBreaker.record({ inputTokens: totalInputTokens });

        const diffFile = appendShadowDiff(projectRoot, {
          event: "controller.shadow.diff",
          request_id: messageId,
          primary_mode: CONTROLLER_MODES.LEGACY,
          candidate_mode: CONTROLLER_MODES.LOOP,
          sampling_rate: sampling.rate,
          primary: summarizeShadowPayload(handled.payload),
          shadow: shadowResult && shadowResult.ok
            ? summarizeShadowPayload(shadowResult.payload)
            : {
              ok: false,
              error: shadowResult && shadowResult.error ? String(shadowResult.error) : "shadow_run_failed",
            },
          side_effects_ok: assertion.ok,
          side_effect_violations: assertion.violations,
        });
        shadowObserver.emit("controller.shadow.completed", {
          applied_from_msg_id: messageId,
          ok: shadowResult && shadowResult.ok === true,
          diff_file: diffFile || "",
          side_effects_ok: assertion.ok,
          terminal_reason: loopSummary ? String(loopSummary.terminal_reason || "") : "",
        });
      }
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
    controllerObserver.emit("controller.prompt_completed", {
      applied_from_msg_id: messageId,
      ok: true,
      shadow_enabled: shadowEnabled,
      shadow_ok: shadowResult ? shadowResult.ok === true : false,
      dispatch_count: Array.isArray(payload.dispatch) ? payload.dispatch.length : 0,
      ops_count: Array.isArray(payload.ops) ? payload.ops.length : 0,
      terminal_reason: payload.loop && typeof payload.loop === "object"
        ? String(payload.loop.terminal_reason || "").trim()
        : "",
    });
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
    controllerObserver.emit("controller.prompt_completed", {
      applied_from_msg_id: messageId,
      ok: false,
      error: err.message || String(err),
      shadow_enabled: shadowEnabled,
    });
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
