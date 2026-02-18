const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  inspectUcodeRuntimeConfig,
  prepareUcodeRuntimeConfig,
} = require("../../../src/agent/ucodeRuntimeConfig");

describe("ucode runtime config", () => {
  test("inspect resolves runtime paths and configured values", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-runtime-"));
    const result = inspectUcodeRuntimeConfig({
      projectRoot,
      env: {},
      loadConfigImpl: () => ({
        ucodeProvider: "openai",
        ucodeModel: "gpt-5.1-codex",
        ucodeBaseUrl: "https://example.invalid/v1",
        ucodeApiKey: "sk-test",
      }),
    });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.1-codex");
    expect(result.baseUrl).toBe("https://example.invalid/v1");
    expect(result.apiKey).toBe("sk-test");
    expect(result.agentDir).toContain(path.join(".ufoo", "agent", "ucode", "config"));

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("prepare writes settings/auth/models for provider config", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-runtime-write-"));
    const agentDir = path.join(projectRoot, ".ufoo", "agent", "ucode", "custom-pi");
    const result = prepareUcodeRuntimeConfig({
      projectRoot,
      env: {},
      loadConfigImpl: () => ({
        ucodeProvider: "openai",
        ucodeModel: "gpt-5.1-codex",
        ucodeBaseUrl: "https://example.invalid/v1",
        ucodeApiKey: "sk-test",
        ucodeAgentDir: agentDir,
      }),
    });

    expect(result.env.UFOO_UCODE_CONFIG_DIR).toBe(agentDir);
    expect(result.env.PI_CODING_AGENT_DIR).toBe(agentDir);

    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    expect(settings.defaultProvider).toBe("openai");
    expect(settings.defaultModel).toBe("gpt-5.1-codex");

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    expect(auth.openai).toEqual({
      type: "api_key",
      key: "sk-test",
    });

    const models = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    expect(models.providers.openai.baseUrl).toBe("https://example.invalid/v1");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

