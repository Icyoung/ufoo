function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { reply: "", dispatch: [], ops: [] };
  }
  return {
    ...payload,
    reply: typeof payload.reply === "string" ? payload.reply : "",
    dispatch: Array.isArray(payload.dispatch) ? payload.dispatch : [],
    ops: Array.isArray(payload.ops) ? payload.ops : [],
  };
}

function stripAssistantCall(payload) {
  if (!payload || typeof payload !== "object") {
    return { reply: "", dispatch: [], ops: [] };
  }

  const ops = Array.isArray(payload.ops) ? payload.ops : [];
  const normalOps = [];

  for (const op of ops) {
    if (op && op.action === "assistant_call") {
      continue;
    }
    if (op) normalOps.push(op);
  }

  const nextPayload = {
    ...normalizePayload(payload),
    ops: normalOps,
  };
  delete nextPayload.assistant_call;
  return nextPayload;
}

async function finalizePromptRun({
  projectRoot,
  payload,
  processManager,
  dispatchMessages,
  handleOps,
  markPending,
  finalizeLocally = true,
}) {
  if (finalizeLocally === false) {
    return {
      ok: true,
      payload,
      opsResults: [],
    };
  }

  for (const item of payload.dispatch || []) {
    if (item && item.target && item.target !== "broadcast") {
      markPending(item.target);
    }
  }

  await dispatchMessages(projectRoot, payload.dispatch || []);
  const opsResults = await handleOps(projectRoot, payload.ops || [], processManager);

  return {
    ok: true,
    payload,
    opsResults,
  };
}

async function runPromptWithAssistant({
  projectRoot,
  prompt,
  provider,
  model,
  processManager = null,
  runUfooAgent,
  runPromptWithControllerLoop = null,
  dispatchMessages,
  handleOps,
  markPending = () => {},
  ufooAgentOptions = {},
  finalizeLocally = true,
  loopRuntime = null,
}) {
  const agentOptions = {
    ...(ufooAgentOptions && typeof ufooAgentOptions === "object" ? ufooAgentOptions : {}),
  };

  const firstResult = await runUfooAgent({
    projectRoot,
    prompt: prompt || "",
    provider,
    model,
    ...agentOptions,
  });

  if (!firstResult || !firstResult.ok) {
    return {
      ok: false,
      error: (firstResult && firstResult.error) || "agent failed",
    };
  }

  const firstPayload = stripAssistantCall(firstResult.payload);
  const shouldUpgradeToLoop = Boolean(
    loopRuntime
      && loopRuntime.enabled
      && firstPayload
      && firstPayload.upgrade_to_loop_router === true
      && typeof runPromptWithControllerLoop === "function"
  );

  if (shouldUpgradeToLoop) {
    return runPromptWithControllerLoop({
      projectRoot,
      prompt: prompt || "",
      provider,
      model,
      processManager,
      runUfooAgent,
      dispatchMessages,
      handleOps,
      markPending,
      ufooAgentOptions,
      finalizeLocally,
      loopRuntime,
    });
  }

  return finalizePromptRun({
    projectRoot,
    payload: firstPayload,
    processManager,
    dispatchMessages,
    handleOps,
    markPending,
    finalizeLocally,
  });
}

module.exports = {
  runPromptWithAssistant,
  normalizePayload,
  stripAssistantCall,
};
