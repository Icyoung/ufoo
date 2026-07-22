"use strict";

/**
 * Protocol validator — fail-closed when STRICT; otherwise returns diagnostics.
 *
 * Before a Provider turn: every declared call must be resolved or legitimately
 * deferred (ask_user). Declared/executing calls block the next turn.
 */

const {
  listUnresolved,
  listDeferred,
  listCalls,
  DEFERABLE_TOOLS,
} = require("./toolCallLedger");

/**
 * @returns {{ ok: boolean, code?: string, errors: Array<{ code: string, message: string, callId?: string }> }}
 */
function assertReadyForProviderTurn(ledger = null) {
  const errors = [];
  if (!ledger) {
    return { ok: true, errors: [], skipped: true };
  }

  const unresolved = listUnresolved(ledger);
  for (const call of unresolved) {
    errors.push({
      code: "UNRESOLVED_TOOL_CALL",
      message: `tool call ${call.callId} (${call.name}) is still ${call.state}`,
      callId: call.callId,
    });
  }

  const deferred = listDeferred(ledger);
  for (const call of deferred) {
    if (!DEFERABLE_TOOLS.has(call.name)) {
      errors.push({
        code: "INVALID_DEFER",
        message: `tool call ${call.callId} (${call.name}) is deferred but not deferable`,
        callId: call.callId,
      });
    }
  }

  // Session-level: deferred ask_user is a legal suspension — next Provider turn
  // must not happen until resume resolves it. Treat deferred as blocking here.
  for (const call of deferred) {
    errors.push({
      code: "DEFERRED_PENDING_RESUME",
      message: `tool call ${call.callId} is deferred; resume before next provider turn`,
      callId: call.callId,
    });
  }

  if (errors.length > 0) {
    return {
      ok: false,
      code: errors[0].code,
      errors,
    };
  }
  return { ok: true, errors: [] };
}

/**
 * Validate that a batch of declared calls matches policy expectations.
 * Used by tests / shadow diagnostics — does not mutate messages.
 */
function validateDeclaredBatch(ledger = null, {
  requireAskUserAlone = true,
  rejectPlanWithData = true,
  dataPlaneTools = null,
} = {}) {
  const errors = [];
  const calls = listCalls(ledger);
  if (calls.length === 0) return { ok: true, errors: [] };

  const names = calls.map((c) => c.name);
  const hasAskUser = names.includes("ask_user");
  const hasControlPlane = names.includes("plan_graph") || names.includes("task_run");
  const dataSet = dataPlaneTools instanceof Set
    ? dataPlaneTools
    : new Set(["read", "write", "edit", "bash", "artifact_read"]);
  const hasData = names.some((name) => dataSet.has(name));

  if (requireAskUserAlone && hasAskUser && calls.length > 1) {
    errors.push({
      code: "ASK_USER_MUST_BE_ALONE",
      message: "ask_user must be the only tool call in the turn",
    });
  }
  if (rejectPlanWithData && hasControlPlane && hasData) {
    errors.push({
      code: "MIXED_PLAN_AND_DATA_TOOLS",
      message: "Do not mix plan_graph/task_run with data-plane tools in the same turn",
    });
  }

  return {
    ok: errors.length === 0,
    code: errors[0] ? errors[0].code : undefined,
    errors,
  };
}

/**
 * Env: UFOO_UCODE_PROTOCOL_STRICT
 * - unset / "1" → fail-closed (Phase 1 default)
 * - "0" → shadow diagnose only (rollback)
 * Owner: runtime. Remove after R1 materialize is proven stable.
 */
function isProtocolStrictEnabled(env = process.env) {
  const raw = String(env && env.UFOO_UCODE_PROTOCOL_STRICT || "").trim();
  if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off") {
    return false;
  }
  return true;
}

/**
 * Run validator; in shadow mode record violations on ledger, optionally throw.
 * @returns {{ ok: boolean, errors: object[], threw: boolean }}
 */
function runProviderTurnGate(ledger, {
  strict = null,
  onViolation = null,
} = {}) {
  const result = assertReadyForProviderTurn(ledger);
  if (result.ok || result.skipped) {
    return { ok: true, errors: [], threw: false };
  }

  if (typeof onViolation === "function") {
    try {
      onViolation(result);
    } catch {
      // ignore observer errors
    }
  }

  const { recordViolation } = require("./toolCallLedger");
  for (const err of result.errors) {
    recordViolation(ledger, err);
  }

  const shouldStrict = strict == null ? isProtocolStrictEnabled() : Boolean(strict);
  if (shouldStrict) {
    const err = new Error(
      `protocol validator failed: ${result.errors.map((e) => e.code).join(", ")}`
    );
    err.code = result.code || "PROTOCOL_VIOLATION";
    err.protocolErrors = result.errors;
    throw err;
  }

  return { ok: false, errors: result.errors, threw: false };
}

module.exports = {
  assertReadyForProviderTurn,
  validateDeclaredBatch,
  isProtocolStrictEnabled,
  runProviderTurnGate,
};
