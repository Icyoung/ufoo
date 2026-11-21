import React, { useEffect, useState } from "react";
import { Columns, GridFour, Square, Terminal, X } from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import { WORKER_AGENTS, type WorkerAgent } from "../workerAgents";
import type { WindowMode } from "../types";

const MANUAL_MODEL = "<manual>";
const PROVIDERS = [
  { value: "codex-cli", label: "Codex (OpenAI)" },
  { value: "claude-cli", label: "Claude (Anthropic)" },
  { value: "agy-cli", label: "Antigravity (agy)" },
  { value: "kimi-cli", label: "Kimi Code" },
  { value: "grok-cli", label: "Grok" },
  { value: "custom", label: "Custom OpenAI-Compatible Gateway" },
];
const WINDOW_LAYOUTS = [
  { id: "main", label: "Main", icon: Square },
  { id: "side", label: "Side", icon: Columns },
  { id: "multi", label: "Multi", icon: GridFour },
] as const;
const REASONING_EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

type ModelCatalog = { ok: boolean; models: string[]; default_model?: string };

function SegmentedSetting<Value extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ id: Value; label: string; icon?: typeof Square }>;
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled}>
      <legend className="mb-1 text-[11.5px] font-medium text-zinc-400">{label}</legend>
      <div className="grid grid-cols-3 gap-1 rounded-xl border border-white/[0.08] bg-zinc-900 p-1">
        {options.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className="flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 aria-pressed:bg-white/[0.13] aria-pressed:text-white disabled:opacity-50 disabled:cursor-default cursor-pointer"
          >
            {Icon && <Icon size={13} />}
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsModal() {
  const { state, dispatch, notifyToast, setDefaultWorkerAgent, setWindowMode } = useWorkspace();
  const savedProvider = state.settings.agent_provider || "codex-cli";
  const savedModel = state.settings.agent_model || "";
  const savedBaseUrl = state.settings.custom_base_url ?? state.settings.agent_base_url ?? "";
  const [provider, setProvider] = useState(savedProvider);
  const [model, setModel] = useState(savedModel);
  const [manualModel, setManualModel] = useState(false);
  const [catalog, setCatalog] = useState<(ModelCatalog & { key: string }) | null>(null);
  const [thinking, setThinking] = useState(state.settings.agent_thinking || "medium");
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [defaultWorker, setDefaultWorker] = useState(state.defaultWorkerAgent);
  const [windowMode, setLayout] = useState<WindowMode>(state.windowMode);

  useEffect(() => {
    setProvider(savedProvider);
    setModel(savedModel);
    setManualModel(false);
    setThinking(state.settings.agent_thinking || "medium");
    setBaseUrl(savedBaseUrl);
  }, [savedProvider, savedModel, savedBaseUrl, state.settings.agent_thinking, state.activeRoot, state.settingsModalOpen]);

  const canListModels = provider !== "custom" || (
    savedProvider === "custom" && Boolean(savedBaseUrl) && baseUrl.trim() === savedBaseUrl && !apiKey.trim()
  );
  const catalogKey = `${state.activeRoot}\n${provider}\n${provider === "custom" ? savedBaseUrl : ""}`;
  useEffect(() => {
    setCatalog(null);
    if (!state.settingsModalOpen || !state.activeRoot || !canListModels) return;
    let stale = false;
    void ufooBridge.sendCommand<ModelCatalog>("settings.models", { agent_provider: provider })
      .then((result) => {
        if (!stale) setCatalog({ key: catalogKey, ...result, models: result.models || [] });
      })
      .catch(() => {
        if (!stale) setCatalog({ key: catalogKey, ok: false, models: [] });
      });
    return () => { stale = true; };
  }, [catalogKey, canListModels, provider, state.activeRoot, state.settingsModalOpen]);

  useEffect(() => {
    setDefaultWorker(state.defaultWorkerAgent);
  }, [state.defaultWorkerAgent, state.settingsModalOpen]);

  useEffect(() => {
    setLayout(state.windowMode);
  }, [state.windowMode, state.activeRoot, state.settingsModalOpen]);

  useEffect(() => {
    if (!state.settingsModalOpen) setApiKey("");
  }, [state.settingsModalOpen]);

  if (!state.settingsModalOpen) return null;

  const currentCatalog = canListModels && catalog?.key === catalogKey ? catalog : null;
  const modelOptions = Array.from(new Set([model, ...(currentCatalog?.models || [])].filter(Boolean)));
  let catalogStatus = "";
  if (!canListModels) catalogStatus = "Save the gateway settings to load its model list.";
  else if (!state.activeRoot) catalogStatus = "Connect to Ufoo to load models.";
  else if (!currentCatalog) catalogStatus = "Loading models…";
  else if (!currentCatalog.models.length) catalogStatus = "No models available. You can enter a model ID.";

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      const providerChanged = provider !== savedProvider;
      const modelId = model.trim();
      if (manualModel && !modelId) throw new Error("Enter a model ID");
      if (providerChanged) patch.agent_provider = provider;
      if (modelId !== (providerChanged ? "" : savedModel)) patch.agent_model = modelId;
      if (thinking !== (state.settings.agent_thinking || "medium")) patch.agent_thinking = thinking;
      if (provider === "custom") {
        if (baseUrl.trim() !== savedBaseUrl) patch.agent_base_url = baseUrl.trim();
        if (apiKey.trim()) patch.agent_api_key = apiKey.trim();
      }
      if (Object.keys(patch).length) {
        const result = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("settings.set", patch);
        if (!result.ok) throw new Error(result.error || "Could not save settings");
      }
      if (defaultWorker !== state.defaultWorkerAgent) setDefaultWorkerAgent(defaultWorker);
      if (state.scope === "project" && windowMode !== state.windowMode) {
        const project = state.projects.find(({ root }) => root === state.activeRoot);
        const workers = project?.workers.filter(({ internal }) => internal) || [];
        const sideWorker = workers.find(({ id }) => id === state.sideAgentId) || workers[0];
        await setWindowMode(windowMode, windowMode === "side" ? sideWorker?.id : undefined);
      }
      notifyToast("Settings saved");
      dispatch({ type: "SET_SETTINGS_MODAL", open: false });
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const handleInstallCli = async () => {
    const res = await ufooBridge.sendCommand<{ ok: boolean; targetDir?: string }>(
      "cli.install_shims",
      { updateZshrc: true }
    );
    if (res?.ok) {
      notifyToast(`Installed ufoo CLI shims in ${res.targetDir || "~/.ufoo/bin"}`);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/65 backdrop-blur-sm p-4">
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl border border-white/[0.1] bg-zinc-900 p-1 shadow-2xl">
        <div className="rounded-[12px] bg-zinc-950 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold text-zinc-100">
                Workspace & Runtime Settings
              </h2>
              <p className="text-[11.5px] text-zinc-500">Model and provider settings are shared with the CLI.</p>
            </div>
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: false })}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-white cursor-pointer"
            >
              <X size={15} />
            </button>
          </div>

          <div className="space-y-3">
            <SegmentedSetting
              label="Window Layout"
              value={windowMode}
              options={WINDOW_LAYOUTS}
              onChange={setLayout}
              disabled={state.scope !== "project"}
            />

            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium text-zinc-400">Default Worker Agent</span>
              <select
                value={defaultWorker}
                onChange={(e) => setDefaultWorker(e.target.value as WorkerAgent)}
                className="w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 text-[13px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
              >
                {WORKER_AGENTS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>

            <div>
              <label className="block text-[11.5px] font-medium text-zinc-400 mb-1">
                ufoo Agent Provider
              </label>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  setModel(e.target.value === savedProvider ? savedModel : "");
                  setManualModel(false);
                }}
                className="w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 text-[13px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
              >
                {PROVIDERS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>

            <div>
              <label htmlFor="agent-model" className="block text-[11.5px] font-medium text-zinc-400 mb-1">
                Model
              </label>
              <select
                id="agent-model"
                value={manualModel ? MANUAL_MODEL : model}
                onChange={(e) => {
                  const selected = e.target.value;
                  setManualModel(selected === MANUAL_MODEL);
                  if (selected !== MANUAL_MODEL) setModel(selected);
                }}
                className="w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 text-[13px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
              >
                <option value="" disabled={provider === "custom"}>
                  {provider === "custom" ? "Select a model" : currentCatalog?.default_model ? `Provider default (${currentCatalog.default_model})` : "Provider default"}
                </option>
                {modelOptions.map((id) => <option key={id} value={id}>{id}</option>)}
                <option value={MANUAL_MODEL}>Enter model ID…</option>
              </select>
              {manualModel && (
                <input
                  type="text"
                  aria-label="Custom model ID"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="Model ID"
                  className="mt-2 w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 font-mono text-[12.5px] text-zinc-100 focus:border-blue-500/50 focus:outline-none"
                />
              )}
              {catalogStatus && <p role="status" className="mt-1 text-[11.5px] text-zinc-500">{catalogStatus}</p>}
            </div>

            <SegmentedSetting label="Reasoning Effort" value={thinking} options={REASONING_EFFORTS} onChange={setThinking} />

            {provider === "custom" && (
              <>
                <div>
                  <label className="block text-[11.5px] font-medium text-zinc-400 mb-1">
                    Custom Base URL
                  </label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.example.com/v1"
                    className="w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 font-mono text-[12px] text-zinc-100 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11.5px] font-medium text-zinc-400 mb-1">
                    API Key (Stored locally, never sent in UI snapshots)
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full rounded-xl border border-white/[0.09] bg-zinc-900 px-3 py-2 font-mono text-[12px] text-zinc-100 focus:outline-none"
                  />
                </div>
              </>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[12px] font-medium text-zinc-200">
                CLI Integration (`~/.ufoo/bin`)
              </div>
              <div className="text-[11px] text-zinc-500">
                Link `ufoo`, `ucode`, `uclaude`, `ucodex` to bundled Node runtime
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleInstallCli()}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.06] px-2.5 py-1.5 text-[11.5px] text-zinc-200 hover:bg-white/[0.12] cursor-pointer"
            >
              <Terminal size={13} />
              <span>Install</span>
            </button>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: false })}
              className="rounded-xl px-3.5 py-1.5 text-[12.5px] text-zinc-400 hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded-xl bg-blue-600 px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 cursor-pointer"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
