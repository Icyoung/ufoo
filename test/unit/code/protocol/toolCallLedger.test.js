"use strict";

const {
  createToolCallLedger,
  declareCalls,
  markExecuting,
  deferCall,
  resolveCall,
  listUnresolved,
  listDeferred,
  digestValue,
  CALL_STATES,
} = require("../../../../src/code/protocol/toolCallLedger");

describe("toolCallLedger", () => {
  test("declare → resolve clears unresolved", () => {
    const ledger = createToolCallLedger({ provider: "openai" });
    expect(declareCalls(ledger, [
      { callId: "c1", name: "read", args: { path: "a" } },
      { callId: "c2", name: "bash", args: { command: "ls" } },
    ]).ok).toBe(true);
    expect(listUnresolved(ledger)).toHaveLength(2);

    expect(markExecuting(ledger, "c1").ok).toBe(true);
    expect(resolveCall(ledger, "c1", { result: { ok: true }, isError: false }).ok).toBe(true);
    expect(resolveCall(ledger, "c2", { result: { ok: true }, isError: false }).ok).toBe(true);
    expect(listUnresolved(ledger)).toHaveLength(0);
    expect(ledger.calls.c1.state).toBe("resolved");
    expect(ledger.calls.c1.resultDigest).toBe(digestValue({ ok: true }));
  });

  test("duplicate declare fails", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [{ callId: "c1", name: "read", args: {} }]);
    const second = declareCalls(ledger, [{ callId: "c1", name: "bash", args: {} }]);
    expect(second.ok).toBe(false);
    expect(second.code).toBe("DUPLICATE_CALL_ID");
  });

  test("ask_user can defer; other tools cannot", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [
      { callId: "ask", name: "ask_user", args: { prompt: "hi" } },
      { callId: "read", name: "read", args: { path: "x" } },
    ]);
    expect(deferCall(ledger, "ask").ok).toBe(true);
    expect(listDeferred(ledger)).toHaveLength(1);
    expect(deferCall(ledger, "read").ok).toBe(false);
    expect(deferCall(ledger, "read").code).toBe("NOT_DEFERABLE");
  });

  test("resolve is idempotent for same result; rejects different result", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [{ callId: "c1", name: "read", args: {} }]);
    const payload = { ok: false, code: "X" };
    expect(resolveCall(ledger, "c1", { result: payload, isError: true }).ok).toBe(true);
    const again = resolveCall(ledger, "c1", { result: payload, isError: true });
    expect(again.ok).toBe(true);
    expect(again.idempotent).toBe(true);
    const clash = resolveCall(ledger, "c1", { result: { ok: true }, isError: false });
    expect(clash.ok).toBe(false);
    expect(clash.code).toBe("DUPLICATE_RESOLVE");
  });

  test("deferred ask_user resolves on resume", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [{ callId: "ask", name: "ask_user", args: { prompt: "?" } }]);
    deferCall(ledger, "ask");
    const resumed = resolveCall(ledger, "ask", {
      result: { type: "user_answer", text: "yes" },
      allowFromDeferred: true,
    });
    expect(resumed.ok).toBe(true);
    expect(listDeferred(ledger)).toHaveLength(0);
    expect(listUnresolved(ledger)).toHaveLength(0);
  });

  test("CALL_STATES covers declared executing deferred resolved", () => {
    expect(CALL_STATES).toEqual(["declared", "executing", "deferred", "resolved"]);
  });
});
