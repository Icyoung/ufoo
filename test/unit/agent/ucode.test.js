const fs = require("fs");
const {
  hasAnyArg,
  normalizeAppendSystemPromptMode,
  readLastArgValue,
  resolveNativeFallbackCommand,
  resolveUcodeLaunch,
} = require("../../../src/code/launcher/ucode");

describe("ucode launcher resolver", () => {
  test("default launch uses native core and injects append-system-prompt in auto mode", () => {
    const resolved = resolveUcodeLaunch({
      argv: ["--help"],
      env: {},
      cwd: "/repo",
      loadConfigImpl: () => ({}),
    });

    expect(resolved.agentType).toBe("ufoo-code");
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args[0]).toMatch(/src\/code\/agent\.js$/);
    expect(resolved.args).toEqual(expect.arrayContaining(["--help"]));
    expect(resolved.args).toEqual(
      expect.arrayContaining([
        "--append-system-prompt",
        resolved.env.UFOO_UCODE_BOOTSTRAP_FILE,
      ])
    );
    expect(resolved.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE).toBe("auto");
  });

  test("append-system-prompt is injected in always mode", () => {
    const resolved = resolveUcodeLaunch({
      argv: [],
      env: { UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "always" },
      cwd: "/repo",
      loadConfigImpl: () => ({}),
    });
    expect(resolved.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE).toBe("always");
    expect(resolved.args).toEqual(
      expect.arrayContaining([
        "--append-system-prompt",
        resolved.env.UFOO_UCODE_BOOTSTRAP_FILE,
      ])
    );
  });

  test("append-system-prompt can be disabled by mode=never", () => {
    const resolved = resolveUcodeLaunch({
      argv: [],
      env: { UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "never" },
      cwd: "/repo",
      loadConfigImpl: () => ({}),
    });
    expect(resolved.args.filter((arg) => arg === "--append-system-prompt").length).toBe(0);
  });

  test("does not duplicate append-system-prompt when caller already provides one", () => {
    const resolved = resolveUcodeLaunch({
      argv: ["--append-system-prompt", "/tmp/custom-bootstrap.md"],
      env: {},
      cwd: "/repo",
      loadConfigImpl: () => ({}),
    });
    expect(resolved.args.filter((arg) => arg === "--append-system-prompt").length).toBe(1);
    expect(resolved.args).toEqual(expect.arrayContaining(["--append-system-prompt", "/tmp/custom-bootstrap.md"]));
  });

  test("provider/model precedence supports partial CLI override", () => {
    const onlyProvider = resolveUcodeLaunch({
      argv: ["--provider", "anthropic"],
      env: {},
      cwd: "/repo",
      loadConfigImpl: () => ({ ucodeProvider: "openai", ucodeModel: "gpt-5.1-codex" }),
    });
    expect(onlyProvider.args).toEqual(expect.arrayContaining(["--provider", "anthropic", "--model", "gpt-5.1-codex"]));
    expect(onlyProvider.env.UFOO_UCODE_PROVIDER).toBe("anthropic");
    expect(onlyProvider.env.UFOO_UCODE_MODEL).toBe("gpt-5.1-codex");

    const onlyModel = resolveUcodeLaunch({
      argv: ["--model", "claude-opus-4-6"],
      env: {},
      cwd: "/repo",
      loadConfigImpl: () => ({ ucodeProvider: "openai", ucodeModel: "gpt-5.1-codex" }),
    });
    expect(onlyModel.args).toEqual(expect.arrayContaining(["--provider", "openai", "--model", "claude-opus-4-6"]));
    expect(onlyModel.env.UFOO_UCODE_PROVIDER).toBe("openai");
    expect(onlyModel.env.UFOO_UCODE_MODEL).toBe("claude-opus-4-6");
  });

  test("does not inject bundled prompt file by default but passes through explicit settings", () => {
    const resolved = resolveUcodeLaunch({
      argv: [],
      env: {},
      cwd: "/repo",
      loadConfigImpl: () => ({}),
    });
    expect(resolved.env.UFOO_UCODE_PROMPT_FILE).toBe("");

    const fromEnv = resolveUcodeLaunch({
      argv: [],
      env: { UFOO_UCODE_PROMPT_FILE: "/tmp/custom-prompt.md" },
      cwd: "/repo",
      loadConfigImpl: () => ({}),
    });
    expect(fromEnv.env.UFOO_UCODE_PROMPT_FILE).toBe("/tmp/custom-prompt.md");

    const fromConfig = resolveUcodeLaunch({
      argv: [],
      env: {},
      cwd: "/repo",
      loadConfigImpl: () => ({ ucodePromptFile: "/tmp/config-prompt.md" }),
    });
    expect(fromConfig.env.UFOO_UCODE_PROMPT_FILE).toBe("/tmp/config-prompt.md");
  });

  test("native fallback reports unavailable when no entry and no PATH command", () => {
    const statSpy = jest.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("not found");
    });
    try {
      const resolved = resolveNativeFallbackCommand({ env: { PATH: "", PATHEXT: "" } });
      expect(resolved.command).toBe(process.execPath);
      expect(resolved.args[0]).toMatch(/src\/code\/agent\.js$/);
      expect(resolved.available).toBe(false);
      expect(String(resolved.missingReason || "")).toContain("src/code/agent.js not found");
    } finally {
      statSpy.mockRestore();
    }
  });

  test("helpers keep expected semantics", () => {
    expect(normalizeAppendSystemPromptMode("always")).toBe("always");
    expect(normalizeAppendSystemPromptMode("disable")).toBe("never");
    expect(normalizeAppendSystemPromptMode("other")).toBe("auto");
    expect(readLastArgValue(["--provider", "openai", "--provider=anthropic"], "--provider")).toBe("anthropic");
    expect(hasAnyArg(["--model=claude"], ["--model"])).toBe(true);
  });

  test("hasAnyArg returns false for empty arrays", () => {
    expect(hasAnyArg([], ["--flag"])).toBe(false);
    expect(hasAnyArg(null, ["--flag"])).toBe(false);
  });

  test("normalizeAppendSystemPromptMode handles all variants", () => {
    expect(normalizeAppendSystemPromptMode("force")).toBe("always");
    expect(normalizeAppendSystemPromptMode("on")).toBe("always");
    expect(normalizeAppendSystemPromptMode("1")).toBe("always");
    expect(normalizeAppendSystemPromptMode("true")).toBe("always");
    expect(normalizeAppendSystemPromptMode("off")).toBe("never");
    expect(normalizeAppendSystemPromptMode("0")).toBe("never");
    expect(normalizeAppendSystemPromptMode("false")).toBe("never");
    expect(normalizeAppendSystemPromptMode("")).toBe("auto");
  });

  test("readLastArgValue reads flag and inline values", () => {
    expect(readLastArgValue(["--model", "gpt4", "--model", "gpt5"], "--model")).toBe("gpt5");
    expect(readLastArgValue(["--model=inline"], "--model")).toBe("inline");
    expect(readLastArgValue([], "--model")).toBe("");
    expect(readLastArgValue(null, "--model")).toBe("");
  });

  test("readLastArgValue treats a following flag as missing value", () => {
    expect(readLastArgValue(["--provider", "--model", "x"], "--provider")).toBe("");
    expect(readLastArgValue(["--provider", "--model", "x"], "--model")).toBe("x");
    expect(readLastArgValue(["--model", "gpt5", "--provider"], "--provider")).toBe("");
    expect(readLastArgValue(["--provider", "--provider", "openai"], "--provider")).toBe("openai");
  });
});
