const fs = require("fs");
const {
  bundledModuleRoots,
  defaultBundledCoreRoot,
  tokenizeCommand,
  splitCommand,
  hasAnyArg,
  pickBinEntry,
  normalizeAppendSystemPromptMode,
  isLikelyPiCoreCommand,
  readLastArgValue,
  canExecutePath,
  resolveCoreFromPath,
  resolveCandidateCoreRoot,
  resolveNativeFallbackCommand,
  resolveUcodeLaunch,
} = require("../../../src/agent/ucode");

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
    expect(resolved.args[0]).toMatch(/(src\/code\/agent\.js|bin\/ucode-core\.js)$/);
    expect(resolved.args).toEqual(expect.arrayContaining(["--help"]));
    expect(resolved.args).toEqual(
      expect.arrayContaining([
        "--append-system-prompt",
        resolved.env.UFOO_UCODE_BOOTSTRAP_FILE,
      ])
    );
    expect(resolved.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE).toBe("auto");
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

  test("tokenize/split command keeps quoted windows paths", () => {
    expect(splitCommand("\"C:\\\\Program Files\\\\Pi Core\\\\pi.exe\" --mode json"))
      .toEqual({ command: "C:\\Program Files\\Pi Core\\pi.exe", args: ["--mode", "json"] });
    expect(tokenizeCommand("C:\\\\Pi\\\\pi.exe --help")).toEqual(["C:\\Pi\\pi.exe", "--help"]);
  });

  test("native fallback reports unavailable when no entry and no PATH command", () => {
    const statSpy = jest.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("not found");
    });
    try {
      const resolved = resolveNativeFallbackCommand({ env: { PATH: "", PATHEXT: "" } });
      expect(resolved.command).toBe("ucode-core");
      expect(resolved.available).toBe(false);
      expect(String(resolved.missingReason || "")).toContain("not available on PATH");
    } finally {
      statSpy.mockRestore();
    }
  });

  test("helpers keep expected semantics", () => {
    expect(normalizeAppendSystemPromptMode("always")).toBe("always");
    expect(normalizeAppendSystemPromptMode("disable")).toBe("never");
    expect(normalizeAppendSystemPromptMode("other")).toBe("auto");
    expect(isLikelyPiCoreCommand("node", ["/repo/src/code/agent.js"])).toBe(true);
    expect(isLikelyPiCoreCommand("other", ["--help"])).toBe(false);
    expect(readLastArgValue(["--provider", "openai", "--provider=anthropic"], "--provider")).toBe("anthropic");
    expect(hasAnyArg(["--model=claude"], ["--model"])).toBe(true);
  });

  test("bundled roots are flattened to src/code first", () => {
    const roots = bundledModuleRoots();
    expect(Array.isArray(roots)).toBe(true);
    expect(roots[0]).toMatch(/src\/code$/);
  });

  test("tokenizeCommand handles single quotes", () => {
    expect(tokenizeCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  test("tokenizeCommand handles double quotes with escapes", () => {
    expect(tokenizeCommand('echo "hello \\"world\\""')).toEqual(["echo", 'hello "world"']);
  });

  test("tokenizeCommand handles backslash escapes", () => {
    expect(tokenizeCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
  });

  test("tokenizeCommand handles trailing backslash", () => {
    expect(tokenizeCommand("echo hello\\")).toEqual(["echo", "hello\\"]);
  });

  test("tokenizeCommand falls back to split on unclosed quote", () => {
    const result = tokenizeCommand("echo 'unclosed");
    expect(result).toEqual(["echo", "'unclosed"]);
  });

  test("splitCommand returns fallback for empty input", () => {
    expect(splitCommand("")).toEqual({ command: "pi", args: [] });
    expect(splitCommand("", "custom")).toEqual({ command: "custom", args: [] });
  });

  test("hasAnyArg returns false for empty arrays", () => {
    expect(hasAnyArg([], ["--flag"])).toBe(false);
    expect(hasAnyArg(null, ["--flag"])).toBe(false);
  });

  test("pickBinEntry handles string bin field", () => {
    expect(pickBinEntry("./cli.js")).toBe("./cli.js");
  });

  test("pickBinEntry handles object bin field", () => {
    expect(pickBinEntry({ tool: "./tool.js" })).toBe("./tool.js");
    expect(pickBinEntry({ ucode: "./ucode.js", other: "./other.js" })).toBe("./ucode.js");
  });

  test("pickBinEntry returns empty for empty/null", () => {
    expect(pickBinEntry({})).toBe("");
    expect(pickBinEntry(null)).toBe("");
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

  test("isLikelyPiCoreCommand detects ucode variants", () => {
    expect(isLikelyPiCoreCommand("ucode")).toBe(true);
    expect(isLikelyPiCoreCommand("ucode-core")).toBe(true);
    expect(isLikelyPiCoreCommand("node", ["ucode-core"])).toBe(true);
    expect(isLikelyPiCoreCommand("node", ["\\src\\code\\agent.js"])).toBe(true);
    expect(isLikelyPiCoreCommand("random")).toBe(false);
    expect(isLikelyPiCoreCommand("")).toBe(false);
  });

  test("readLastArgValue reads flag and inline values", () => {
    expect(readLastArgValue(["--model", "gpt4", "--model", "gpt5"], "--model")).toBe("gpt5");
    expect(readLastArgValue(["--model=inline"], "--model")).toBe("inline");
    expect(readLastArgValue([], "--model")).toBe("");
    expect(readLastArgValue(null, "--model")).toBe("");
  });

  test("canExecutePath returns false for empty/nonexistent", () => {
    expect(canExecutePath("")).toBe(false);
    expect(canExecutePath("/nonexistent/file")).toBe(false);
  });

  test("resolveCoreFromPath returns null for nonexistent dir", () => {
    expect(resolveCoreFromPath("/nonexistent/dir")).toBeNull();
    expect(resolveCoreFromPath("")).toBeNull();
  });

  test("resolveCandidateCoreRoot returns null (native-only mode)", () => {
    expect(resolveCandidateCoreRoot()).toBeNull();
  });

  test("defaultBundledCoreRoot returns src/code path", () => {
    const root = defaultBundledCoreRoot();
    expect(root).toContain("src");
    expect(root).toContain("code");
  });
});
