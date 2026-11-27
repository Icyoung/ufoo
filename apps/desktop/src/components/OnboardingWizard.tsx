import React, { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, X } from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import type { OnboardingEngineStatus, OnboardingProbeState } from "../types";
import { BrandIcon } from "./BrandIcon";

const STEPS = [
  { id: 1, title: "Engines & Auth" },
  { id: 2, title: "CLI & Tools" },
  { id: 3, title: "Workspace" },
] as const;

function StatusBadge({ engine }: { engine: OnboardingEngineStatus }) {
  if (engine.status === "ready") {
    return (
      <span className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-md bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
        <span>Ready</span>
      </span>
    );
  }
  if (engine.status === "needs_auth") {
    return (
      <span className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-md bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
        <span>Needs Login</span>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 whitespace-nowrap items-center rounded-md bg-white/[0.04] px-2 py-0.5 text-[11px] text-zinc-500">
      Not installed
    </span>
  );
}

export function OnboardingWizard() {
  const { state, dispatch, selectProjectMain, notifyToast } = useWorkspace();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [probing, setProbing] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");

  const probe = state.onboardingProbe;

  const runProbe = useCallback(async () => {
    setProbing(true);
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; data?: OnboardingProbeState }>(
        "onboarding.probe",
        {}
      );
      if (res?.ok && res.data) {
        dispatch({ type: "SET_ONBOARDING_PROBE", probe: res.data });
        setSelectedProvider((prev) => prev || res.data!.recommended_provider || "claude-cli");
      }
    } catch {
      // ignore probe errors
    } finally {
      setProbing(false);
    }
  }, [dispatch]);

  useEffect(() => {
    if (state.onboardingOpen) {
      setStep(1);
      setSelectedFolder("");
      void runProbe();
    }
  }, [state.onboardingOpen, runProbe]);

  useEffect(() => {
    if (!state.onboardingOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void handleSkip();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.onboardingOpen]);

  if (!state.onboardingOpen) return null;

  const handleOpenLogin = async (engineId: string) => {
    const res = await ufooBridge.sendCommand<{ ok: boolean; command?: string; error?: string }>(
      "onboarding.open_login",
      { engine: engineId }
    );
    if (res?.ok) {
      notifyToast(`Opened Terminal: ${res.command}. Click Re-scan once signed in.`);
    } else if (res?.error) {
      notifyToast(res.error);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notifyToast(`Copied: ${text}`);
    } catch {
      notifyToast("Copy failed");
    }
  };

  const handleInstallCli = async () => {
    setBusyAction("cli");
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; targetDir?: string; error?: string }>(
        "cli.install_shims",
        { updateZshrc: true }
      );
      if (res?.ok) {
        notifyToast(`Installed ufoo & ucode in ${res.targetDir || "~/.ufoo/bin"}`);
        await runProbe();
      } else if (res?.error) {
        notifyToast(res.error);
      }
    } finally {
      setBusyAction("");
    }
  };

  const handleConfigureMcp = async () => {
    setBusyAction("mcp");
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; target?: string; error?: string }>(
        "onboarding.configure_mcp",
        { host: "codex" }
      );
      if (res?.ok) {
        notifyToast(`Configured Codex MCP (${res.target || "~/.codex/config.toml"})`);
        await runProbe();
      } else if (res?.error) {
        notifyToast(res.error);
      }
    } finally {
      setBusyAction("");
    }
  };

  const handlePickFolder = async () => {
    const picked = await ufooBridge.pickProjectFolder();
    if (picked) {
      setSelectedFolder(picked);
    }
  };

  const handleSkip = async () => {
    await ufooBridge.sendCommand("onboarding.complete", { skipped: true }).catch(() => {});
    dispatch({ type: "SET_ONBOARDING_OPEN", open: false });
  };

  const handleFinish = async (explicitFolder?: string) => {
    setBusyAction("finish");
    try {
      const folder = explicitFolder || selectedFolder;
      await ufooBridge.sendCommand("onboarding.complete", {
        skipped: false,
        ...(selectedProvider ? { agent_provider: selectedProvider } : {}),
      });
      if (folder) {
        const added = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("project.add", {
          root: folder,
        });
        if (!added?.ok && added?.error) {
          await selectProjectMain(folder);
        }
      }
      dispatch({ type: "SET_ONBOARDING_OPEN", open: false });
      notifyToast("Workspace ready");
    } finally {
      setBusyAction("");
    }
  };

  const readyPrimaryCount = (probe?.primary_engines || []).filter((e) => e.status === "ready").length;
  const detectedAcp = (probe?.acp_engines || []).filter((e) => e.installed);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-6">
      <div className="flex max-h-[86vh] w-full max-w-[660px] flex-col overflow-hidden rounded-2xl border border-white/[0.11] bg-[#101013] shadow-2xl">
        {/* Top Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-white/[0.07] bg-zinc-950/70 px-6 py-4">
          <div>
            <h2 className="text-[14.5px] font-semibold tracking-tight text-zinc-100">
              Setup Ufoo
            </h2>
            <p className="mt-0.5 text-[11.5px] text-zinc-500">
              Local-first multi-agent workspace · SDK, ACP & MCP
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleSkip()}
            aria-label="Close setup"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <X size={15} />
          </button>
        </header>

        {/* Minimal Stepper */}
        <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.05] bg-zinc-950/40 px-6 py-2.5">
          {STEPS.map((s, idx) => {
            const active = step === s.id;
            const done = step > s.id;
            return (
              <React.Fragment key={s.id}>
                <button
                  type="button"
                  onClick={() => setStep(s.id)}
                  className={`inline-flex items-center gap-2 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors cursor-pointer ${
                    active
                      ? "bg-white/[0.09] text-white"
                      : done
                      ? "text-zinc-300 hover:bg-white/[0.04]"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  <span className="font-mono text-[11px] text-zinc-400">
                    {done ? "✓" : `0${s.id}`}
                  </span>
                  <span>{s.title}</span>
                </button>
                {idx < STEPS.length - 1 && <div className="h-px flex-1 bg-white/[0.07]" />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Step Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {step === 1 && (
            <>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-[13.5px] font-semibold text-zinc-100">
                    Local Coding Engines
                  </h3>
                  <p className="text-[12px] text-zinc-500 mt-0.5">
                    Reuses your local Claude Code, Codex, and ACP credentials directly.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={probing}
                  onClick={() => void runProbe()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-zinc-300 hover:bg-white/[0.08] disabled:opacity-50 cursor-pointer"
                >
                  <ArrowsClockwise size={12} className={probing ? "animate-spin" : ""} />
                  <span>{probing ? "Scanning" : "Re-scan"}</span>
                </button>
              </div>

              <div className="space-y-2">
                <div className="text-[11px] font-medium text-zinc-500">
                  Primary Orchestrator & SDK Workers
                </div>
                <div className="space-y-2">
                  {(probe?.primary_engines || []).map((eng) => {
                    const isSelected = selectedProvider === eng.id;
                    return (
                      <div
                        key={eng.id}
                        onClick={() => setSelectedProvider(eng.id)}
                        className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 transition-colors cursor-pointer ${
                          isSelected
                            ? "border-blue-400/40 bg-blue-500/[0.07]"
                            : "border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]"
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                              isSelected ? "border-blue-400 bg-blue-500" : "border-zinc-600"
                            }`}
                          >
                            {isSelected && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                          </div>
                          <BrandIcon brand={eng.id} size={18} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-[13px] font-medium text-zinc-100 truncate">
                                {eng.label}
                              </span>
                              <StatusBadge engine={eng} />
                              {isSelected && (
                                <span className="shrink-0 whitespace-nowrap rounded bg-white/[0.08] px-1.5 py-0.2 text-[10px] text-zinc-300">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[11.5px] text-zinc-500 truncate">{eng.detail}</div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          {eng.status === "needs_auth" && eng.loginCommand && (
                            <button
                              type="button"
                              onClick={() => void handleOpenLogin(eng.id)}
                              className="rounded-lg border border-amber-400/30 bg-amber-500/15 px-2.5 py-1 text-[11.5px] font-medium text-amber-200 hover:bg-amber-500/25 cursor-pointer"
                            >
                              Sign in
                            </button>
                          )}
                          {eng.status === "not_installed" && eng.installHint && (
                            <button
                              type="button"
                              onClick={() => void handleCopy(eng.installHint!)}
                              title={`Copy: ${eng.installHint}`}
                              className="rounded-lg border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.09] cursor-pointer"
                            >
                              Copy install
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span className="font-medium">ACP Extensions ({detectedAcp.length} detected)</span>
                  <span>Kimi · Grok · Gemini · OpenCode · Goose</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(probe?.acp_engines || []).map((eng) => (
                    <div
                      key={eng.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <BrandIcon brand={eng.id} size={16} />
                        <div className="min-w-0">
                          <div className="text-[12px] font-medium text-zinc-200 truncate">
                            {eng.label.replace(/\s*\(ACP\)$/i, "")}
                          </div>
                          <div className="font-mono text-[10px] text-zinc-500 truncate">{eng.detail}</div>
                        </div>
                      </div>
                      <StatusBadge engine={eng} />
                    </div>
                  ))}
                </div>
              </div>

              {readyPrimaryCount === 0 && !probing && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-[12px] text-amber-200">
                  No signed-in primary engine detected yet. Sign in above and re-scan, or configure a Custom Gateway in Settings later.
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <h3 className="text-[13.5px] font-semibold text-zinc-100">
                  CLI Handoff & MCP Cooperation
                </h3>
                <p className="text-[12px] text-zinc-500 mt-0.5">
                  Optional integrations for terminal handoff and external native CLI collaboration.
                </p>
              </div>

              <div className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-white/[0.02]">
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-zinc-100">
                        CLI Shims (`ufoo` & `ucode`)
                      </span>
                      {probe?.cli.installed && (
                        <span className="shrink-0 whitespace-nowrap rounded-md bg-emerald-500/12 px-2 py-0.5 text-[10.5px] text-emerald-300">
                          Installed
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-zinc-500">
                      Link <code className="text-zinc-300">ufoo</code> and{" "}
                      <code className="text-zinc-300">ucode</code> into{" "}
                      <code className="text-zinc-300">~/.ufoo/bin</code> using the bundled Node runtime.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyAction === "cli"}
                    onClick={() => void handleInstallCli()}
                    className="shrink-0 rounded-lg border border-white/[0.1] bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-zinc-100 hover:bg-white/[0.12] disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    {busyAction === "cli" ? "Installing…" : probe?.cli.installed ? "Reinstall" : "Install"}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <BrandIcon brand="codex" size={14} />
                      <span className="text-[13px] font-medium text-zinc-100">
                        External CLI MCP Cooperation (Codex)
                      </span>
                      {probe?.mcp.codex_configured && !probe?.mcp.codex_needs_update && (
                        <span className="shrink-0 whitespace-nowrap rounded-md bg-emerald-500/12 px-2 py-0.5 text-[10.5px] text-emerald-300">
                          Synced
                        </span>
                      )}
                      {probe?.mcp.codex_needs_update && (
                        <span className="shrink-0 whitespace-nowrap rounded-md bg-amber-500/12 px-2 py-0.5 text-[10.5px] text-amber-300">
                          Update available
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-zinc-500">
                      Let native <code className="text-zinc-300">codex</code> share Decisions, Memory, and Event Bus directly over MCP.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyAction === "mcp"}
                    onClick={() => void handleConfigureMcp()}
                    className="shrink-0 rounded-lg border border-white/[0.1] bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-zinc-100 hover:bg-white/[0.12] disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    {busyAction === "mcp"
                      ? "Configuring…"
                      : probe?.mcp.codex_needs_update
                      ? "Update MCP"
                      : probe?.mcp.codex_configured
                      ? "Re-sync"
                      : "Configure"}
                  </button>
                </div>

                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-zinc-100">
                        ufoo Browser (Optional)
                      </span>
                      <span className="shrink-0 whitespace-nowrap rounded-md bg-white/[0.05] px-2 py-0.5 font-mono text-[10.5px] text-zinc-400">
                        {probe?.browser.state || "not_installed"}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] text-zinc-500">
                      Automate your logged-in Chrome tabs via <code className="text-zinc-300">ufoo browser install</code>.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleCopy("ufoo browser install")}
                    className="shrink-0 rounded-lg border border-white/[0.09] bg-white/[0.04] px-3 py-1.5 text-[11.5px] text-zinc-300 hover:bg-white/[0.09] cursor-pointer"
                  >
                    Copy cmd
                  </button>
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <h3 className="text-[13.5px] font-semibold text-zinc-100">
                  Open a Workspace
                </h3>
                <p className="text-[12px] text-zinc-500 mt-0.5">
                  Choose a local Git repository folder or select an existing workspace below.
                </p>
              </div>

              <button
                type="button"
                onClick={() => void handlePickFolder()}
                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/[0.15] bg-white/[0.02] px-6 py-7 text-center hover:border-white/[0.3] hover:bg-white/[0.04] transition-colors cursor-pointer"
              >
                <div className="text-[13px] font-medium text-zinc-100 font-mono">
                  {selectedFolder || "Choose Repository Folder…"}
                </div>
                <div className="text-[11.5px] text-zinc-500">
                  {selectedFolder
                    ? "Click to pick a different folder"
                    : "Lightweight .ufoo/ metadata is initialized automatically."}
                </div>
              </button>

              {state.projects.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-zinc-500">
                    Existing Workspaces ({state.projects.length})
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                    {state.projects.slice(0, 8).map((proj) => {
                      const picked = selectedFolder === proj.root;
                      return (
                        <button
                          key={proj.root}
                          type="button"
                          onClick={() => setSelectedFolder(proj.root)}
                          className={`rounded-xl border px-3 py-2 text-left transition-colors cursor-pointer ${
                            picked
                              ? "border-blue-400/50 bg-blue-500/15 text-white"
                              : "border-white/[0.07] bg-white/[0.02] text-zinc-300 hover:bg-white/[0.05]"
                          }`}
                        >
                          <div className="text-[12.5px] font-medium truncate">{proj.label}</div>
                          <div className="font-mono text-[10px] text-zinc-500 truncate mt-0.5">
                            {proj.branch || proj.root}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom Wizard Navigation */}
        <footer className="flex shrink-0 items-center justify-between border-t border-white/[0.07] bg-zinc-950/70 px-6 py-3.5">
          <div>
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
                className="rounded-lg px-3 py-1.5 text-[12.5px] text-zinc-400 hover:bg-white/[0.06] hover:text-white cursor-pointer"
              >
                Back
              </button>
            ) : (
              <span className="text-[11.5px] text-zinc-500">
                Available anytime in Settings
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSkip()}
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 cursor-pointer"
            >
              Skip
            </button>
            {step < 3 ? (
              <button
                type="button"
                onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-500 transition-colors cursor-pointer"
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                disabled={busyAction === "finish"}
                onClick={() => void handleFinish()}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {busyAction === "finish" ? "Opening…" : "Start Coding"}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
