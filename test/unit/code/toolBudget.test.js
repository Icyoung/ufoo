const { parseMaxToolCalls, resolveMaxToolCalls } = require("../../../src/code/toolBudget");
const { parseAgentArgs } = require("../../../src/code/repl");

describe("optional native tool-call budget", () => {
  test("defaults to unlimited and lets explicit options override the environment", () => {
    expect(resolveMaxToolCalls(undefined, {})).toBeNull();
    expect(resolveMaxToolCalls(undefined, { UFOO_UCODE_MAX_TOOL_CALLS: "" })).toBeNull();
    expect(resolveMaxToolCalls(undefined, { UFOO_UCODE_MAX_TOOL_CALLS: "200" })).toBe(200);
    expect(resolveMaxToolCalls(10, { UFOO_UCODE_MAX_TOOL_CALLS: "200" })).toBe(10);
    expect(resolveMaxToolCalls(null, { UFOO_UCODE_MAX_TOOL_CALLS: "200" })).toBeNull();
    expect(resolveMaxToolCalls("none", { UFOO_UCODE_MAX_TOOL_CALLS: "200" })).toBeNull();
  });

  test("parses CLI forms without overriding the environment when omitted", () => {
    expect(parseAgentArgs([]).maxToolCalls).toBeUndefined();
    expect(parseAgentArgs(["--max-tool-calls", "200"]).maxToolCalls).toBe(200);
    expect(parseAgentArgs(["--max-tool-calls=12"]).maxToolCalls).toBe(12);
    expect(parseAgentArgs(["--max-tool-calls", "None"]).maxToolCalls).toBeNull();
    expect(() => parseAgentArgs(["--max-tool-calls"])).toThrow(/requires/);
    expect(() => parseAgentArgs(["--max-tool-calls", "--tui"])).toThrow(/positive integer/);
  });

  test.each(["", "0", "-1", "1.5", "10abc", "NaN", "Infinity", "9007199254740992"])(
    "rejects invalid explicit budget %s",
    (value) => expect(() => parseMaxToolCalls(value)).toThrow(/positive integer or none/),
  );
});
