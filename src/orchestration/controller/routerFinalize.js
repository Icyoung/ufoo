"use strict";

const {
  normalizeLaunchAgentForNickname,
  stripRoutingPromptMetadata,
} = require("./launchRouting");

const LAUNCH_TARGET_PREFIX = "__ufoo_launch_";

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

function isLaunchOp(op) {
  return Boolean(op && op.action === "launch");
}

function hasDispatchMessage(item) {
  return Boolean(item && String(item.target || "").trim() && String(item.message || "").trim());
}

function launchPlaceholder(index) {
  return `${LAUNCH_TARGET_PREFIX}${index}`;
}

function parseLaunchPlaceholder(target = "") {
  const raw = String(target || "").trim();
  if (!raw.startsWith(LAUNCH_TARGET_PREFIX)) return -1;
  const parsed = Number.parseInt(raw.slice(LAUNCH_TARGET_PREFIX.length), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
}

function isLaunchDispatchTarget(target = "", op = {}) {
  const raw = String(target || "").trim();
  if (!raw || raw.includes(":")) return false;
  const normalized = raw.toLowerCase();
  const nickname = String(op.nickname || "").trim();
  if (nickname && raw === nickname) return true;
  const placeholders = new Set([
    "new",
    "new-agent",
    "new-worker",
    "worker",
    "agent",
    "launched",
    "launched-agent",
    "launched-worker",
  ]);
  if (placeholders.has(normalized)) return true;
  const launchAgent = normalizeLaunchAgentForNickname(op.agent || "");
  return Boolean(launchAgent && normalizeLaunchAgentForNickname(raw) === launchAgent);
}

function resolveLaunchResultTarget(op = {}, result = {}) {
  if (result && result.agent_id) return String(result.agent_id);
  if (result && Array.isArray(result.subscriber_ids) && result.subscriber_ids[0]) {
    return String(result.subscriber_ids[0]);
  }
  if (result && result.subscriber_id) return String(result.subscriber_id);
  if (result && result.nickname) return String(result.nickname);
  if (op && op.nickname) return String(op.nickname);
  return "";
}

function resolveDispatchLaunchIndex(dispatchItem = {}, launchOps = []) {
  const target = String(dispatchItem.target || "").trim();
  const placeholderIndex = parseLaunchPlaceholder(target);
  if (placeholderIndex >= 0) return placeholderIndex;

  for (let i = 0; i < launchOps.length; i += 1) {
    if (isLaunchDispatchTarget(target, launchOps[i])) return i;
  }
  return -1;
}

function prepareLaunchDispatchPayload(payload, prompt = "") {
  const normalized = normalizePayload(payload);
  const launchOps = [];
  const otherOps = [];
  for (const op of normalized.ops) {
    if (isLaunchOp(op)) launchOps.push(op);
    else if (op) otherOps.push(op);
  }

  if (launchOps.length === 0) {
    return {
      payload: normalized,
      launchOps,
      otherOps,
      dispatch: normalized.dispatch.filter(hasDispatchMessage),
    };
  }

  let dispatch = normalized.dispatch.filter(hasDispatchMessage).map((item) => ({ ...item }));
  const taskMessage = stripRoutingPromptMetadata(prompt);
  if (dispatch.length === 0 && !taskMessage) {
    return {
      payload: { ...normalized, dispatch: [], ops: otherOps },
      launchOps: [],
      otherOps,
      dispatch: [],
      droppedLaunches: launchOps,
    };
  }

  if (dispatch.length === 0 && taskMessage) {
    dispatch = launchOps.map((op, index) => ({
      target: op.nickname || launchPlaceholder(index),
      message: taskMessage,
      injection_mode: "immediate",
      source: "ufoo-agent",
    }));
  } else if (launchOps.length === 1) {
    const fallbackTarget = launchOps[0].nickname || launchPlaceholder(0);
    dispatch = dispatch.map((item) => (
      isLaunchDispatchTarget(item.target, launchOps[0])
        ? { ...item, target: fallbackTarget }
        : item
    ));
  }

  return {
    payload: { ...normalized, dispatch, ops: [...launchOps, ...otherOps] },
    launchOps,
    otherOps,
    dispatch,
  };
}

function bindDispatchToLaunchResults(dispatch = [], launchOps = [], launchResults = []) {
  const resultByIndex = launchResults.filter((item) => item && item.action === "launch");
  return dispatch.map((item) => {
    const index = resolveDispatchLaunchIndex(item, launchOps);
    if (index < 0) return item;
    const target = resolveLaunchResultTarget(launchOps[index], resultByIndex[index] || {});
    return target ? { ...item, target } : item;
  });
}

async function finalizeRouterPayload({
  projectRoot,
  payload,
  prompt = "",
  processManager,
  dispatchMessages,
  handleOps,
  markPending = () => {},
  finalizeLocally = true,
}) {
  const prepared = prepareLaunchDispatchPayload(payload, prompt);
  if (finalizeLocally === false) {
    return {
      ok: true,
      payload: prepared.payload,
      opsResults: [],
    };
  }

  if (prepared.launchOps.length === 0) {
    for (const item of prepared.dispatch) {
      if (item && item.target && item.target !== "broadcast") {
        markPending(item.target);
      }
    }
    if (typeof dispatchMessages === "function") {
      await dispatchMessages(projectRoot, prepared.dispatch);
    }
    const opsResults = typeof handleOps === "function" && prepared.otherOps.length > 0
      ? await handleOps(projectRoot, prepared.otherOps, processManager)
      : [];
    return {
      ok: true,
      payload: { ...prepared.payload, dispatch: prepared.dispatch, ops: prepared.otherOps },
      opsResults,
    };
  }

  const launchResults = typeof handleOps === "function"
    ? await handleOps(projectRoot, prepared.launchOps, processManager)
    : [];
  const boundDispatch = bindDispatchToLaunchResults(prepared.dispatch, prepared.launchOps, launchResults);

  for (const item of boundDispatch) {
    if (item && item.target && item.target !== "broadcast") {
      markPending(item.target);
    }
  }
  if (typeof dispatchMessages === "function") {
    await dispatchMessages(projectRoot, boundDispatch);
  }

  const otherResults = typeof handleOps === "function" && prepared.otherOps.length > 0
    ? await handleOps(projectRoot, prepared.otherOps, processManager)
    : [];

  return {
    ok: true,
    payload: { ...prepared.payload, dispatch: boundDispatch },
    opsResults: [...launchResults, ...otherResults],
  };
}

module.exports = {
  bindDispatchToLaunchResults,
  finalizeRouterPayload,
  normalizePayload,
  prepareLaunchDispatchPayload,
  __private: {
    isLaunchDispatchTarget,
    launchPlaceholder,
    resolveLaunchResultTarget,
    stripRoutingPromptMetadata,
  },
};
