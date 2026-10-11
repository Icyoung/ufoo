"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig, saveConfig } = require("../../../src/config");
const { applySettingsPatch, buildSettingsSnapshot } = require("../../../src/ui/settingsBridge");
const { createAgentSettingsController, MODEL_COMMAND } = require("../../../src/ui/agentSettingsController");
const { buildCompletions } = require("../../../src/ui/format");
const { COMMAND_TREE, COMMAND_REGISTRY } = require("../../../src/app/chat/commands");
const { listAgentModels, confirmAgentModel } = require("../../../src/agents/providers/modelSettings");
const { resolveRuntimeConfig, resolveTransport } = require("../../../src/agents/providers/runtimeConfig");

describe("custom provider settings", () => {
  let root, ui, publish, logs;
  const fakeCatalog = async (_url, request) => {
    expect(request.headers.Authorization).toBe("Bearer fixture-custom-key");
    return new Response(JSON.stringify({ data: Array.from({ length: 65 }, (_, i) => ({ id: `model-${i}` })) }),
      { headers: { "content-type": "application/json" } });
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-custom-settings-"));
    publish = jest.fn(); logs = jest.fn();
    ui = createAgentSettingsController({ getProjectRoot: () => root, publish, logMessage: logs,
      applyPatch: async (patch) => applySettingsPatch(root, patch),
      listModels: (project) => listAgentModels(project, { fetchImpl: fakeCatalog, skipCache: true }),
      confirmModel: (project, model) => confirmAgentModel(project, model, { fetchImpl: fakeCatalog, skipCache: true }),
    });
  });
  afterEach(() => fs.rmSync(root, { force: true, recursive: true }));

  test("custom URL and hidden key configure an isolated OpenAI runtime and all models have thinking menus", async () => {
    ui.open("custom");
    await ui.respond({ id: "settings-url", text: "https://gateway.test/v1" });
    expect(loadConfig(root).agentProvider).toBe("codex-cli");
    expect(publish).toHaveBeenLastCalledWith("interaction.request", expect.objectContaining({ id: "settings-key", secret: true }));
    await ui.respond({ id: "settings-key", text: "fixture-custom-key" });
    const config = loadConfig(root);
    expect(config).toMatchObject({ agentProvider: "custom", agentBaseUrl: "https://gateway.test/v1", agentApiKey: "fixture-custom-key", agentModel: "" });
    expect(JSON.stringify(buildSettingsSnapshot(config))).not.toContain("fixture-custom-key");
    expect(JSON.stringify(logs.mock.calls)).not.toContain("fixture-custom-key");
    expect(resolveRuntimeConfig({ workspaceRoot: root, provider: "custom", useCodingConfig: false })).toMatchObject({
      provider: "openai", transport: "openai-chat", apiKey: "fixture-custom-key", baseUrl: "https://gateway.test/v1",
    });
    expect(resolveTransport({ provider: "openai", baseUrl: "https://anthropic.com/v1/messages" })).toBe("openai-chat");
    expect(resolveTransport({ provider: "claude" })).toBe("anthropic-messages");
    const lists = await ui.completions(`${MODEL_COMMAND} `);
    const options = { argumentLists: lists, commandTree: COMMAND_TREE, commands: COMMAND_REGISTRY, limit: 100 };
    expect(buildCompletions({ ...options, text: `${MODEL_COMMAND} ` })).toHaveLength(66);
    const thinking = buildCompletions({ ...options, text: `${MODEL_COMMAND} model-64 ` });
    expect(thinking.map((item) => item.replace)).toContain(`${MODEL_COMMAND} model-64 high`);
    expect(buildCompletions({ ...options, text: `${MODEL_COMMAND} <manual> ` })).toEqual([]);
    expect((await ui.applyModel("model-64", "high")).ok).toBe(true);
    expect(loadConfig(root)).toMatchObject({ agentModel: "model-64", agentThinking: "high" });
    expect((await ui.applyModel("gateway-only-model")).ok).toBe(true);
    expect(loadConfig(root).agentModel).toBe("gateway-only-model");
    const updated = await ui.completions(`${MODEL_COMMAND} `);
    expect(updated[MODEL_COMMAND][0]).toMatchObject({ id: "gateway-only-model", desc: "current · choose thinking" });
  });

  test("cancelling custom setup discards edits and does not change Codex credentials or provider", async () => {
    saveConfig(root, { agentProvider: "claude-cli", agentModel: "saved-model" });
    ui.open("custom");
    await ui.respond({ id: "settings-url", text: "https://gateway.test/v1" });
    await ui.respond({ id: "settings-key", cancelled: true });
    expect(loadConfig(root)).toMatchObject({ agentProvider: "claude-cli", agentModel: "saved-model", agentApiKey: "", agentBaseUrl: "" });
    expect(publish).toHaveBeenLastCalledWith("interaction.clear", {});
  });

  test("manual models remain configurable when the custom endpoint has no catalog", async () => {
    applySettingsPatch(root, { agent_provider: "custom", agent_base_url: "https://gateway.test/v1" });
    ui = createAgentSettingsController({ getProjectRoot: () => root, publish, logMessage: logs,
      applyPatch: async (patch) => applySettingsPatch(root, patch),
      confirmModel: (project, model) => confirmAgentModel(project, model, { fetchImpl: async () => new Response("not found", { status: 404 }) }),
    });
    ui.open("manual");
    expect((await ui.respond({ id: "settings-model", text: "private-model" })).ok).toBe(true);
    expect(loadConfig(root).agentModel).toBe("private-model");
    expect(publish).toHaveBeenLastCalledWith("prompt.set_text", expect.objectContaining({ text: "/settings agent thinking " }));
  });

  test("Claude with a custom URL saves Opus 5.5 and keeps it in the menu when the catalog is stale", async () => {
    saveConfig(root, { agentProvider: "claude-cli", agentModel: "claude-opus-4-5" });
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-opus-4-5" }] })));
    const resolveRuntime = async () => ({ provider: "claude", transport: "anthropic-messages",
      baseUrl: "https://claude-gateway.test/v1", auth: { apiKey: "fixture-claude-key" } });
    const catalogOptions = { resolveRuntime, fetchImpl, skipCache: true };
    ui = createAgentSettingsController({ getProjectRoot: () => root, publish, logMessage: logs,
      applyPatch: async patch => applySettingsPatch(root, patch),
      listModels: project => listAgentModels(project, catalogOptions),
      confirmModel: (project, model) => confirmAgentModel(project, model, catalogOptions),
    });
    await ui.completions(`${MODEL_COMMAND} `);
    fetchImpl.mockClear();
    ui.open("manual");
    expect((await ui.respond({ id: "settings-model", text: "claude-opus-5-5" })).ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadConfig(root)).toMatchObject({ agentProvider: "claude-cli", agentModel: "claude-opus-5-5" });
    expect(logs).not.toHaveBeenCalled();
    const rows = (await ui.completions(`${MODEL_COMMAND} `))[MODEL_COMMAND];
    expect(rows.map(row => row.id)).toEqual(["claude-opus-5-5", "claude-opus-4-5", "<manual>"]);
    expect(rows[0].desc).toContain("current");
  });

  test.each(["xhigh", "max"])("GPT-6.1 Sol keeps %s as an independent menu and saved effort", async (effort) => {
    saveConfig(root, { agentProvider: "codex-cli", agentModel: "gpt-6.1-sol" });
    ui = createAgentSettingsController({ getProjectRoot: () => root, publish,
      applyPatch: async (patch) => applySettingsPatch(root, patch),
      listModels: async () => ({ ok: true, models: ["gpt-6.1-sol"] }),
      confirmModel: async () => ({ allowed: true }),
    });
    const lists = await ui.completions(`${MODEL_COMMAND} gpt-6.1-sol `);
    const rows = buildCompletions({ argumentLists: lists, commandTree: COMMAND_TREE,
      commands: COMMAND_REGISTRY, text: `${MODEL_COMMAND} gpt-6.1-sol ` });
    expect(rows.map(row => row.replace)).toContain(`${MODEL_COMMAND} gpt-6.1-sol ${effort}`);
    expect((await ui.applyModel("gpt-6.1-sol", effort)).ok).toBe(true);
    expect(loadConfig(root).agentThinking).toBe(effort);
  });
});
