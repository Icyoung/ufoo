const {
  parseAssistantOutput,
  normalizeResponse,
  resolveAssistantCommand,
} = require("../../../src/assistant/bridge");

describe("assistant bridge helpers", () => {
  test("resolveAssistantCommand uses internal bin by default", () => {
    const original = process.env.UFOO_ASSISTANT_CMD;
    delete process.env.UFOO_ASSISTANT_CMD;
    const resolved = resolveAssistantCommand();
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toContain("bin/ufoo-assistant-agent.js");
    if (typeof original === "string") {
      process.env.UFOO_ASSISTANT_CMD = original;
    } else {
      delete process.env.UFOO_ASSISTANT_CMD;
    }
  });

  test("resolveAssistantCommand honors explicit command override", () => {
    const original = process.env.UFOO_ASSISTANT_CMD;
    process.env.UFOO_ASSISTANT_CMD = "assistant-custom --stdio";
    const resolved = resolveAssistantCommand();
    expect(resolved).toEqual({
      command: "assistant-custom",
      args: ["--stdio"],
    });
    if (typeof original === "string") {
      process.env.UFOO_ASSISTANT_CMD = original;
    } else {
      delete process.env.UFOO_ASSISTANT_CMD;
    }
  });

  test("parseAssistantOutput parses full JSON payload", () => {
    const parsed = parseAssistantOutput('{"ok":true,"summary":"done"}');
    expect(parsed).toEqual({ ok: true, summary: "done" });
  });

  test("parseAssistantOutput falls back to last valid JSON line", () => {
    const parsed = parseAssistantOutput("noise\n{\"ok\":false}\n{\"ok\":true,\"summary\":\"x\"}\n");
    expect(parsed).toEqual({ ok: true, summary: "x" });
  });

  test("normalizeResponse returns failed result for invalid payload", () => {
    const result = normalizeResponse(null, "boom");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
    expect(result.artifacts).toEqual([]);
    expect(result.logs).toEqual([]);
  });

  test("normalizeResponse keeps supported fields", () => {
    const result = normalizeResponse({
      ok: true,
      summary: "ok",
      artifacts: ["a"],
      logs: ["l"],
      metrics: { duration_ms: 12 },
    });
    expect(result).toEqual({
      ok: true,
      summary: "ok",
      artifacts: ["a"],
      logs: ["l"],
      error: "",
      metrics: { duration_ms: 12 },
    });
  });

  test("parseAssistantOutput returns null for empty input", () => {
    expect(parseAssistantOutput("")).toBeNull();
    expect(parseAssistantOutput(null)).toBeNull();
  });

  test("parseAssistantOutput returns null for unparseable text", () => {
    expect(parseAssistantOutput("not json at all")).toBeNull();
  });

  test("normalizeResponse defaults non-string summary to empty", () => {
    const result = normalizeResponse({ ok: true, summary: 123 });
    expect(result.summary).toBe("");
  });

  test("normalizeResponse defaults non-array artifacts and logs", () => {
    const result = normalizeResponse({ ok: true, artifacts: "str", logs: "str" });
    expect(result.artifacts).toEqual([]);
    expect(result.logs).toEqual([]);
  });

  test("normalizeResponse defaults non-object metrics", () => {
    const result = normalizeResponse({ ok: true, metrics: "str" });
    expect(result.metrics).toEqual({});
  });

  test("normalizeResponse uses default error message", () => {
    const result = normalizeResponse(null);
    expect(result.error).toBe("assistant returned invalid JSON");
  });

  test("resolveAssistantCommand handles empty UFOO_ASSISTANT_CMD", () => {
    const original = process.env.UFOO_ASSISTANT_CMD;
    process.env.UFOO_ASSISTANT_CMD = "";
    const resolved = resolveAssistantCommand();
    expect(resolved.command).toBe(process.execPath);
    if (typeof original === "string") {
      process.env.UFOO_ASSISTANT_CMD = original;
    } else {
      delete process.env.UFOO_ASSISTANT_CMD;
    }
  });
});
