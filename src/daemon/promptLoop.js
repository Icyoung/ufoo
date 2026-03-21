function buildAssistantContinuationPrompt({
  originalPrompt,
  previousReply,
  reports,
}) {
  const lines = [];
  lines.push(`User: ${originalPrompt}`);
  if (previousReply) {
    lines.push("");
    lines.push(`Your previous reply draft: ${previousReply}`);
  }
  lines.push("");
  lines.push("Assistant execution reports (JSON):");
  lines.push(JSON.stringify(reports, null, 2));
  lines.push("");
  lines.push("Using these reports, return the final JSON response.");
  return lines.join("\n");
}

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

function annotateAssistantFailureFallback(payload, assistantResult) {
  if (!payload || typeof payload !== "object") return payload;
  const dispatchCount = Array.isArray(payload.dispatch) ? payload.dispatch.length : 0;
  const opsCount = Array.isArray(payload.ops) ? payload.ops.length : 0;
  if (dispatchCount > 0 || opsCount > 0) return payload;

  const error = assistantResult && typeof assistantResult.error === "string" && assistantResult.error
    ? assistantResult.error
    : "assistant task failed";
  const note = `Assistant execution failed: ${error}. No action was applied.`;
  const reply = typeof payload.reply === "string" && payload.reply
    ? `${payload.reply}\n${note}`
    : note;
  return {
    ...payload,
    reply,
  };
}

function extractAssistantCall(payload) {
  if (!payload || typeof payload !== "object") {
    return { assistantCall: null, ops: [] };
  }

  const ops = Array.isArray(payload.ops) ? payload.ops : [];
  let assistantCall = payload.assistant_call || null;
  const normalOps = [];

  for (const op of ops) {
    if (op && op.action === "assistant_call") {
      if (!assistantCall) assistantCall = op;
      continue;
    }
    if (op) normalOps.push(op);
  }

  return { assistantCall, ops: normalOps };
}

function normalizeAssistantCall(call) {
  if (!call) return null;
  if (typeof call === "string") {
    return { task: call, kind: "mixed", context: "", expect: "" };
  }
  if (typeof call !== "object") return null;
  const task = typeof call.task === "string" ? call.task : "";
  if (!task) return null;
  return {
    task,
    kind: typeof call.kind === "string" ? call.kind : "mixed",
    context: typeof call.context === "string" ? call.context : "",
    expect: typeof call.expect === "string" ? call.expect : "",
    provider: typeof call.provider === "string" ? call.provider : "",
    model: typeof call.model === "string" ? call.model : "",
    timeoutMs: Number.isFinite(call.timeout_ms) ? call.timeout_ms : null,
  };
}

function buildAssistantReport(call, result) {
  return {
    kind: call.kind,
    task: call.task,
    ok: result && result.ok !== false,
    summary: result && typeof result.summary === "string" ? result.summary : "",
    error: result && typeof result.error === "string" ? result.error : "",
    artifacts: result && Array.isArray(result.artifacts) ? result.artifacts : [],
    logs: result && Array.isArray(result.logs) ? result.logs : [],
    metrics: result && typeof result.metrics === "object" ? result.metrics : {},
  };
}

function createAssistantTaskId() {
  return `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function emitAssistantReport(reportTaskStatus, payload) {
  if (typeof reportTaskStatus !== "function") return;
  try {
    await reportTaskStatus(payload);
  } catch {
    // best effort: reporting must not break prompt flow
  }
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
  runAssistantTask,
  dispatchMessages,
  handleOps,
  markPending = () => {},
  reportTaskStatus = () => {},
  maxAssistantLoops = 2,
  log = () => {},
  ufooAgentOptions = {},
  finalizeLocally = true,
}) {
  const firstResult = await runUfooAgent({
    projectRoot,
    prompt: prompt || "",
    provider,
    model,
    ...ufooAgentOptions,
  });

  if (!firstResult || !firstResult.ok) {
    return {
      ok: false,
      error: (firstResult && firstResult.error) || "agent failed",
    };
  }

  const firstPayload = normalizePayload(firstResult.payload);
  const extractedFirst = extractAssistantCall(firstPayload);
  const assistantCall = normalizeAssistantCall(extractedFirst.assistantCall);
  const basePayload = {
    ...firstPayload,
    ops: extractedFirst.ops,
  };
  delete basePayload.assistant_call;

  if (!assistantCall || maxAssistantLoops < 1) {
    return finalizePromptRun({
      projectRoot,
      payload: basePayload,
      processManager,
      dispatchMessages,
      handleOps,
      markPending,
      finalizeLocally,
    });
  }

  const assistantTaskId = createAssistantTaskId();
  await emitAssistantReport(reportTaskStatus, {
    phase: "start",
    source: "assistant",
    agent_id: "ufoo-assistant-agent",
    scope: "private",
    controller_id: "ufoo-agent",
    task_id: assistantTaskId,
    message: assistantCall.task,
    summary: "",
    error: "",
    ok: true,
    meta: {
      kind: assistantCall.kind,
      provider: assistantCall.provider || provider || "",
      model: assistantCall.model || model || "",
    },
  });

  let assistantResult;
  try {
    assistantResult = await runAssistantTask({
      projectRoot,
      provider: assistantCall.provider || "",
      fallbackProvider: provider,
      model: assistantCall.model || model,
      task: assistantCall.task,
      kind: assistantCall.kind,
      context: assistantCall.context,
      expect: assistantCall.expect,
      timeoutMs: assistantCall.timeoutMs || undefined,
    });
  } catch (err) {
    assistantResult = {
      ok: false,
      summary: "",
      artifacts: [],
      logs: [],
      error: err && err.message ? err.message : "assistant task failed",
      metrics: {},
    };
  }

  await emitAssistantReport(reportTaskStatus, {
    phase: assistantResult && assistantResult.ok === false ? "error" : "done",
    source: "assistant",
    agent_id: "ufoo-assistant-agent",
    scope: "private",
    controller_id: "ufoo-agent",
    task_id: assistantTaskId,
    message: assistantCall.task,
    summary: assistantResult && typeof assistantResult.summary === "string" ? assistantResult.summary : "",
    error: assistantResult && typeof assistantResult.error === "string" ? assistantResult.error : "",
    ok: assistantResult && assistantResult.ok !== false,
    meta: {
      kind: assistantCall.kind,
      provider: assistantCall.provider || provider || "",
      model: assistantCall.model || model || "",
      metrics: assistantResult && assistantResult.metrics && typeof assistantResult.metrics === "object"
        ? assistantResult.metrics
        : {},
    },
  });

  if (!assistantResult || assistantResult.ok === false) {
    log("assistant-loop fallback to round1 payload");
    const fallbackPayload = annotateAssistantFailureFallback(basePayload, assistantResult);
    return finalizePromptRun({
      projectRoot,
      payload: fallbackPayload,
      processManager,
      dispatchMessages,
      handleOps,
      markPending,
    });
  }

  const reports = [buildAssistantReport(assistantCall, assistantResult)];
  const continuationPrompt = buildAssistantContinuationPrompt({
    originalPrompt: prompt || "",
    previousReply: basePayload.reply || "",
    reports,
  });

  const secondResult = await runUfooAgent({
    projectRoot,
    prompt: continuationPrompt,
    provider,
    model,
    ...ufooAgentOptions,
  });

  if (!secondResult || !secondResult.ok) {
    log("assistant-loop fallback to round1 payload (round2 failed)");
    return finalizePromptRun({
      projectRoot,
      payload: basePayload,
      processManager,
      dispatchMessages,
      handleOps,
      markPending,
      finalizeLocally,
    });
  }

  const secondPayload = normalizePayload(secondResult.payload);
  const extractedSecond = extractAssistantCall(secondPayload);
  const finalPayload = {
    ...secondPayload,
    ops: extractedSecond.ops,
    assistant: { runs: reports },
  };
  delete finalPayload.assistant_call;

  return finalizePromptRun({
    projectRoot,
    payload: finalPayload,
    processManager,
    dispatchMessages,
    handleOps,
    markPending,
    finalizeLocally,
  });
}

module.exports = {
  runPromptWithAssistant,
  buildAssistantContinuationPrompt,
  normalizePayload,
  annotateAssistantFailureFallback,
  extractAssistantCall,
  normalizeAssistantCall,
  buildAssistantReport,
};
