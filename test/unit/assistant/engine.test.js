const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  resolveAssistantEngine,
  parseEngineJson,
  splitCommand,
  buildExternalEngineArgs,
  isUnsupportedArgError,
  extractSessionId,
} = require("../../../src/assistant/engine");

describe("assistant engine resolver", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-assistant-engine-"));
    delete process.env.UFOO_ASSISTANT_ENGINE;
    delete process.env.UFOO_ASSISTANT_UFOO_CMD;
    delete process.env.UFOO_ASSISTANT_MODEL;
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    delete process.env.UFOO_ASSISTANT_ENGINE;
    delete process.env.UFOO_ASSISTANT_UFOO_CMD;
    delete process.env.UFOO_ASSISTANT_MODEL;
  });

  function writeConfig(config) {
    const file = path.join(projectRoot, ".ufoo", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), "utf8");
  }

  test("omitted assistant provider follows fallback provider", () => {
    writeConfig({ assistantEngine: "ufoo" });
    const resolved = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "",
      requestedModel: "",
      fallbackProvider: "claude-cli",
    });
    expect(resolved).toMatchObject({
      engine: "claude",
      kind: "cli",
      provider: "claude-cli",
    });
  });

  test("auto follows fallback provider even when UFOO_ASSISTANT_ENGINE is set", () => {
    writeConfig({ assistantEngine: "auto" });
    process.env.UFOO_ASSISTANT_ENGINE = "ufoo";
    const resolved = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "",
      requestedModel: "",
      fallbackProvider: "codex-cli",
    });
    expect(resolved).toMatchObject({
      engine: "codex",
      kind: "cli",
      provider: "codex-cli",
    });
  });

  test("requested ufoo provider uses configured engine command", () => {
    writeConfig({
      assistantUfooCmd: "pi-mono --assistant",
      assistantModel: "ufoo-core",
    });

    const resolved = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "ufoo",
      requestedModel: "",
      fallbackProvider: "codex-cli",
    });

    expect(resolved).toEqual({
      engine: "ufoo",
      kind: "external",
      command: "pi-mono",
      args: ["--assistant"],
      model: "ufoo-core",
    });
  });

  test("requested provider overrides config and env", () => {
    writeConfig({ assistantEngine: "ufoo" });
    process.env.UFOO_ASSISTANT_ENGINE = "claude";

    const resolved = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "codex",
      requestedModel: "",
      fallbackProvider: "claude-cli",
    });

    expect(resolved).toMatchObject({
      engine: "codex",
      provider: "codex-cli",
      kind: "cli",
    });
  });

  test("requested provider=auto inherits fallback provider (not config ufoo)", () => {
    writeConfig({ assistantEngine: "ufoo" });
    const resolved = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "auto",
      requestedModel: "",
      fallbackProvider: "codex-cli",
    });
    expect(resolved).toMatchObject({
      engine: "codex",
      kind: "cli",
      provider: "codex-cli",
    });
  });

  test("explicit provider takes precedence over auto/config fallback", () => {
    writeConfig({ assistantEngine: "auto" });
    const resolved = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "claude",
      requestedModel: "",
      fallbackProvider: "codex-cli",
    });
    expect(resolved).toMatchObject({
      engine: "claude",
      kind: "cli",
      provider: "claude-cli",
    });
  });

  test("invalid requested provider falls back in a controlled way", () => {
    writeConfig({ assistantEngine: "ufoo" });

    const resolvedWithValidFallback = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "invalid-provider",
      requestedModel: "",
      fallbackProvider: "claude-cli",
    });
    expect(resolvedWithValidFallback).toMatchObject({
      engine: "claude",
      kind: "cli",
      provider: "claude-cli",
    });

    const resolvedWithInvalidFallback = resolveAssistantEngine({
      projectRoot,
      requestedProvider: "invalid-provider",
      requestedModel: "",
      fallbackProvider: "invalid-fallback",
    });
    expect(resolvedWithInvalidFallback).toMatchObject({
      engine: "codex",
      kind: "cli",
      provider: "codex-cli",
    });
  });

  test("splitCommand and parseEngineJson helpers", () => {
    expect(splitCommand("  cmd  --x  --y ")).toEqual({
      command: "cmd",
      args: ["--x", "--y"],
    });
    expect(parseEngineJson("noise\n{\"ok\":true,\"summary\":\"x\"}\n")).toEqual({
      ok: true,
      summary: "x",
    });
  });

  test("buildExternalEngineArgs builds cli-style assistant task contract", () => {
    const args = buildExternalEngineArgs(
      { args: ["run"] },
      {
        task: "scan repo",
        kind: "explore",
        model: "m1",
        session_id: "sess-1",
        project_root: "/repo",
        context: "ctx",
        expect: "exp",
        timeout_ms: 90000,
      }
    );

    expect(args).toEqual([
      "run",
      "--assistant-task",
      "--json",
      "--model",
      "m1",
      "--session-id",
      "sess-1",
      "--cwd",
      "/repo",
      "--kind",
      "explore",
      "--context",
      "ctx",
      "--expect",
      "exp",
      "--timeout-ms",
      "90000",
      "scan repo",
    ]);
  });

  test("error/session helpers", () => {
    expect(isUnsupportedArgError("Unknown option --assistant-task")).toBe(true);
    expect(isUnsupportedArgError("other error")).toBe(false);
    expect(extractSessionId({ session_id: "s1" })).toBe("s1");
    expect(extractSessionId({ sessionId: "s2" })).toBe("s2");
    expect(extractSessionId({ session: "s3" })).toBe("s3");
  });
});
