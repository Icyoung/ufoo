const { validateModelConfig, resolveGroupModelConfig, buildGroupModelArgs, buildGroupModelEnv } = require("../../../src/orchestration/groups/modelConfig");

const defaults = {
  codex: { model: "gpt-6-astra", reasoning_effort: "high" },
  claude: { model: "claude-fable-5-2", reasoning_effort: "" },
  agy: { model: "gemini-4-carbon-high", reasoning_effort: "" },
  override: { model: "", reasoning_effort: "" },
};

test("selects provider defaults and never applies Codex settings to Claude or native workers", () => {
  expect(resolveGroupModelConfig(defaults, "codex")).toEqual({ ...defaults.codex, model_source: "codex" });
  expect(resolveGroupModelConfig(defaults, "claude")).toEqual({ ...defaults.claude, model_source: "claude" });
  expect(resolveGroupModelConfig(defaults, "ucode")).toEqual({});
  expect(resolveGroupModelConfig(undefined, "codex")).toEqual({});
});

test.each(["codex", "claude", "agy"])("a nonempty override replaces the entire %s default without borrowing effort", type => {
  const config = { ...defaults, override: { model: "  manual-model  " } };
  const resolved = resolveGroupModelConfig(config, type);
  expect(resolved).toEqual({ model: "manual-model", reasoning_effort: "", model_source: "override" });
  expect(buildGroupModelArgs(type, resolved)).toEqual(["--model", "manual-model"]);
  expect(resolveGroupModelConfig({ ...config, override: { model: "   " } }, type).model).toBe(defaults[type].model);
});

test("native agy retains its provider when defaults or manual overrides select the model", () => {
  const native = resolveGroupModelConfig(defaults, "ucode", "agy-cli");
  expect(native).toEqual({ ...defaults.agy, model_source: "agy", model_provider: "agy" });
  expect(buildGroupModelArgs("ucode", native)).toEqual(["--model", "gemini-4-carbon-high"]);
  expect(buildGroupModelEnv("ucode", native)).toEqual({ UFOO_UCODE_PROVIDER: "agy" });
  const override = resolveGroupModelConfig({ ...defaults, override: { model: "gemini-4-hydrogen-xhigh" } }, "ucode", "agy-cli");
  expect(override).toMatchObject({ model_source: "override", model_provider: "agy", reasoning_effort: "" });
  expect(buildGroupModelEnv("ucode", override)).toEqual({ UFOO_UCODE_PROVIDER: "agy" });
  expect(resolveGroupModelConfig(defaults, "ucode", "openai")).toEqual({});
  expect(resolveGroupModelConfig(defaults, "claude", "agy-cli").model_source).toBe("claude");
  expect(buildGroupModelEnv("agy", native)).toEqual({});
});

test("launch arguments carry model and effort in each provider's syntax", () => {
  expect(buildGroupModelArgs("codex", { model: "gpt-6.1-sol", reasoning_effort: "xhigh" }))
    .toEqual(["--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="xhigh"']);
  expect(buildGroupModelArgs("claude", { model: "claude-opus-5-5", reasoning_effort: "high" }))
    .toEqual(["--model", "claude-opus-5-5", "--effort", "high"]);
  expect(buildGroupModelArgs("agy", { model: "gemini-4-argon-high", reasoning_effort: "high" }))
    .toEqual(["--model", "gemini-4-argon-high", "--effort", "high"]);
});

test.each([null, [], { codex: "model" }, { codex: { model: 3 } },
  { claude: { reasoning_effort: "typo" } }, { override: { reasoning_effort: "high" } },
  { codex: { typo: "xhigh" } }, { typo: {} }])("rejects malformed model configuration: %j", config => {
  expect(validateModelConfig(config, "agents[0].model_config").length).toBeGreaterThan(0);
});

test("empty configurations and explicit provider defaults validate", () => {
  for (const config of [undefined, {}, defaults]) expect(validateModelConfig(config, "model_config")).toEqual([]);
});

test.each([
  ["codex-cli", "codex", "codex"],
  ["claude-cli", "anthropic", "claude"],
  ["anthropic", "anthropic", "claude"],
  ["antigravity", "agy", "agy"],
])("explicit ucode uses %s role defaults and native effort", (provider, normalized, key) => {
  const resolved = resolveGroupModelConfig(defaults, "ucode", provider);
  expect(resolved).toEqual({ ...defaults[key], model_source: key, model_provider: normalized });
  expect(buildGroupModelArgs("ucode", resolved)).toEqual(["--model", defaults[key].model]);
  expect(buildGroupModelEnv("ucode", resolved)).toEqual({ UFOO_UCODE_PROVIDER: normalized,
    ...(defaults[key].reasoning_effort ? { UFOO_UCODE_THINKING: defaults[key].reasoning_effort } : {}) });
});

test.each(["codex", "anthropic", "agy", "openai", "kimi"])("native %s honors manual overrides without switching provider", provider => {
  const resolved = resolveGroupModelConfig({ ...defaults, override: { model: "manual-model", reasoning_effort: "high" } }, "ucode", provider);
  expect(resolved).toMatchObject({ model: "manual-model", model_source: "override", model_provider: provider });
  expect(buildGroupModelEnv("ucode", resolved)).toEqual({ UFOO_UCODE_PROVIDER: provider, UFOO_UCODE_THINKING: "high" });
});
