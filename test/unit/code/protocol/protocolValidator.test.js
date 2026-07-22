"use strict";

const fs = require("fs");
const path = require("path");
const {
  createToolCallLedger,
  declareCalls,
  deferCall,
  resolveCall,
} = require("../../../../src/code/protocol/toolCallLedger");
const {
  assertReadyForProviderTurn,
  validateDeclaredBatch,
  isProtocolStrictEnabled,
  runProviderTurnGate,
} = require("../../../../src/code/protocol/protocolValidator");

const FIXTURES = path.join(__dirname, "../../../fixtures/protocol");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

describe("protocolValidator", () => {
  test("unpaired declared calls block provider turn", () => {
    const fixture = loadFixture("openai-unpaired-tool-calls.json");
    const ledger = createToolCallLedger({ provider: "openai" });
    declareCalls(ledger, fixture.calls);
    const result = assertReadyForProviderTurn(ledger);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNRESOLVED_TOOL_CALL");
  });

  test("all resolved allows provider turn", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [
      { callId: "c1", name: "read", args: {} },
    ]);
    resolveCall(ledger, "c1", { result: { ok: true } });
    expect(assertReadyForProviderTurn(ledger).ok).toBe(true);
  });

  test("deferred ask_user blocks next provider turn until resume", () => {
    const fixture = loadFixture("openai-ask-user-deferred.json");
    const ledger = createToolCallLedger({ provider: "openai" });
    declareCalls(ledger, fixture.calls);
    deferCall(ledger, "call_ask");
    const blocked = assertReadyForProviderTurn(ledger);
    expect(blocked.ok).toBe(false);
    expect(blocked.errors.some((e) => e.code === "DEFERRED_PENDING_RESUME")).toBe(true);

    resolveCall(ledger, "call_ask", { result: fixture.resultsAfterResume[0].content });
    expect(assertReadyForProviderTurn(ledger).ok).toBe(true);
  });

  test("validateDeclaredBatch catches mixed plan+data and ask_user alone", () => {
    const mixed = loadFixture("openai-mixed-plan-data-reject.json");
    const mixedLedger = createToolCallLedger();
    declareCalls(mixedLedger, mixed.calls);
    expect(validateDeclaredBatch(mixedLedger).code).toBe("MIXED_PLAN_AND_DATA_TOOLS");

    const alone = loadFixture("openai-ask-user-alone-reject.json");
    const aloneLedger = createToolCallLedger();
    declareCalls(aloneLedger, alone.calls);
    expect(validateDeclaredBatch(aloneLedger).code).toBe("ASK_USER_MUST_BE_ALONE");
  });

  test("STRICT env fail-closes via runProviderTurnGate", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [{ callId: "c1", name: "read", args: {} }]);
    expect(() => runProviderTurnGate(ledger, { strict: true })).toThrow(/protocol validator failed/);
    expect(ledger.violations.length).toBeGreaterThan(0);

    expect(isProtocolStrictEnabled({ UFOO_UCODE_PROTOCOL_STRICT: "1" })).toBe(true);
    expect(isProtocolStrictEnabled({})).toBe(true);
    expect(isProtocolStrictEnabled({ UFOO_UCODE_PROTOCOL_STRICT: "0" })).toBe(false);
  });

  test("shadow mode records violations without throwing", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [{ callId: "c1", name: "read", args: {} }]);
    const out = runProviderTurnGate(ledger, { strict: false });
    expect(out.ok).toBe(false);
    expect(out.threw).toBe(false);
    expect(ledger.violations[0].code).toBe("UNRESOLVED_TOOL_CALL");
  });
});
