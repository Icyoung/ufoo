"use strict";

/**
 * Tool Call Ledger — authoritative record of declared tool calls for a turn.
 *
 * Shadow mode (Phase 0 / R1): ledger tracks declare/defer/resolve alongside the
 * existing TRANSPORTS message assembly. Materialize-from-ledger comes later.
 *
 * Call states: declared | executing | deferred | resolved
 */

const { createHash, randomUUID } = require("crypto");

const CALL_STATES = Object.freeze(["declared", "executing", "deferred", "resolved"]);
const DEFERABLE_TOOLS = Object.freeze(new Set(["ask_user"]));

function digestValue(value) {
  const raw = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function stableStringify(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function createTurnId() {
  return `turn_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

/**
 * @param {{ provider?: string, sessionId?: string, turnId?: string, assistantMessageId?: string }} opts
 */
function createToolCallLedger(opts = {}) {
  return {
    turnId: String(opts.turnId || createTurnId()),
    provider: String(opts.provider || "").trim(),
    sessionId: String(opts.sessionId || "").trim(),
    assistantMessageId: String(opts.assistantMessageId || "").trim(),
    calls: Object.create(null),
    violations: [],
    createdAt: new Date().toISOString(),
  };
}

function getCall(ledger, callId) {
  if (!ledger || !ledger.calls) return null;
  const id = String(callId || "").trim();
  return id && ledger.calls[id] ? ledger.calls[id] : null;
}

function listCalls(ledger) {
  if (!ledger || !ledger.calls) return [];
  return Object.keys(ledger.calls).map((id) => ledger.calls[id]);
}

function listUnresolved(ledger) {
  return listCalls(ledger).filter((call) => (
    call.state === "declared" || call.state === "executing"
  ));
}

function listDeferred(ledger) {
  return listCalls(ledger).filter((call) => call.state === "deferred");
}

/**
 * Declare one or more tool calls after prepareToolCalls.
 * @param {object} ledger
 * @param {Array<{ callId: string, name: string, args?: object }>} calls
 */
function declareCalls(ledger, calls = []) {
  if (!ledger || !ledger.calls) {
    return { ok: false, error: "missing ledger" };
  }
  const list = Array.isArray(calls) ? calls : [];
  for (const entry of list) {
    const callId = String(entry && entry.callId || "").trim();
    if (!callId) {
      return { ok: false, error: "callId required" };
    }
    if (ledger.calls[callId]) {
      return { ok: false, error: `duplicate callId: ${callId}`, code: "DUPLICATE_CALL_ID" };
    }
    const name = String(entry.name || "").trim().toLowerCase();
    ledger.calls[callId] = {
      callId,
      name,
      argsDigest: digestValue(entry.args == null ? {} : entry.args),
      state: "declared",
      resultDigest: "",
      isError: false,
      resolvedAt: "",
      deferredAt: "",
      executingAt: "",
    };
  }
  if (!ledger.assistantMessageId && list.length > 0) {
    ledger.assistantMessageId = String(list[0].callId || "");
  }
  return { ok: true, count: list.length };
}

function markExecuting(ledger, callId) {
  const call = getCall(ledger, callId);
  if (!call) return { ok: false, error: "call not found", code: "CALL_NOT_FOUND" };
  if (call.state !== "declared") {
    return { ok: false, error: `cannot execute from ${call.state}`, code: "INVALID_STATE" };
  }
  call.state = "executing";
  call.executingAt = new Date().toISOString();
  return { ok: true, call };
}

/**
 * Defer a call (ask_user only). Leaves assistant tool_call unpaired until resume.
 */
function deferCall(ledger, callId, { reason = "" } = {}) {
  const call = getCall(ledger, callId);
  if (!call) return { ok: false, error: "call not found", code: "CALL_NOT_FOUND" };
  if (call.state !== "declared" && call.state !== "executing") {
    return { ok: false, error: `cannot defer from ${call.state}`, code: "INVALID_STATE" };
  }
  if (!DEFERABLE_TOOLS.has(call.name)) {
    return {
      ok: false,
      error: `tool ${call.name} cannot be deferred`,
      code: "NOT_DEFERABLE",
    };
  }
  call.state = "deferred";
  call.deferredAt = new Date().toISOString();
  call.deferReason = String(reason || "").trim();
  return { ok: true, call };
}

/**
 * Resolve a declared/executing/deferred call with exactly one result.
 * Idempotent when resultDigest matches a prior resolve.
 */
function resolveCall(ledger, callId, {
  result = null,
  isError = false,
  allowFromDeferred = true,
} = {}) {
  const call = getCall(ledger, callId);
  if (!call) return { ok: false, error: "call not found", code: "CALL_NOT_FOUND" };

  const resultDigest = digestValue(result);
  if (call.state === "resolved") {
    if (call.resultDigest === resultDigest) {
      return { ok: true, call, idempotent: true };
    }
    return {
      ok: false,
      error: "call already resolved with different result",
      code: "DUPLICATE_RESOLVE",
      call,
    };
  }

  if (call.state === "deferred" && !allowFromDeferred) {
    return { ok: false, error: "call is deferred", code: "STILL_DEFERRED", call };
  }
  if (call.state !== "declared" && call.state !== "executing" && call.state !== "deferred") {
    return { ok: false, error: `cannot resolve from ${call.state}`, code: "INVALID_STATE", call };
  }

  call.state = "resolved";
  call.resultDigest = resultDigest;
  call.resultPayload = result;
  call.isError = Boolean(isError);
  call.resolvedAt = new Date().toISOString();
  return { ok: true, call, idempotent: false };
}

function recordViolation(ledger, violation = {}) {
  if (!ledger) return;
  if (!Array.isArray(ledger.violations)) ledger.violations = [];
  ledger.violations.push({
    code: String(violation.code || "PROTOCOL_VIOLATION"),
    message: String(violation.message || ""),
    callId: String(violation.callId || ""),
    at: new Date().toISOString(),
  });
}

function snapshotLedger(ledger) {
  if (!ledger) return null;
  return JSON.parse(JSON.stringify({
    turnId: ledger.turnId,
    provider: ledger.provider,
    sessionId: ledger.sessionId,
    assistantMessageId: ledger.assistantMessageId,
    calls: ledger.calls,
    violations: ledger.violations || [],
    createdAt: ledger.createdAt,
  }));
}

module.exports = {
  CALL_STATES,
  DEFERABLE_TOOLS,
  digestValue,
  createTurnId,
  createToolCallLedger,
  getCall,
  listCalls,
  listUnresolved,
  listDeferred,
  declareCalls,
  markExecuting,
  deferCall,
  resolveCall,
  recordViolation,
  snapshotLedger,
};
