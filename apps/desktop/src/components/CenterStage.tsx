import React, { useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  ArrowsOutSimple,
  Cpu,
  GitBranch,
  Plus,
  SidebarSimple,
  Stop,
  TerminalWindow,
  X,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import type { MultiPaneFrame, WorkerSummary } from "../types";
import { TranscriptStream } from "./TranscriptStream";

function WorkerComposer({
  agentId,
  label,
  busy,
  external = false,
  compact = false,
}: {
  agentId: string;
  label: string;
  busy?: boolean;
  external?: boolean;
  compact?: boolean;
}) {
  const { state, dispatch, submitWorkerInput, cancelWorkerTurn } = useWorkspace();
  const draft = state.localPaneDrafts[agentId]?.text ?? "";

  const handleChange = (next: string) => {
    dispatch({ type: "UPDATE_LOCAL_PANE_DRAFT", agentId, text: next });
    // Keep Node host draft revision synchronized for seamless Side <-> Single <-> CLI handoff
    const rev = (state.localPaneDrafts[agentId]?.rev || 0) + 1;
    void ufooBridge.sendCommand("multi.raw", {
      agent_id: agentId,
      input: next,
      cursor: next.length,
      input_revision: rev,
      submit: false,
    });
  };

  const handleSubmit = async () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    await submitWorkerInput(agentId, trimmed);
  };

  return (
    <div className={`${compact ? "p-2.5" : "px-6 pb-4 pt-2"} border-t border-white/[0.06] bg-zinc-950/60`}>
      <div className={`${compact ? "" : "mx-auto max-w-3xl"} rounded-2xl border border-white/[0.09] bg-zinc-900/90 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] focus-within:border-blue-500/45 transition-colors`}>
        <textarea
          rows={compact ? 2 : 3}
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={
            external
              ? `Send bus message to @${label}…`
              : `Message ${label} directly (Enter to send, Shift+Enter newline)…`
          }
          className="w-full resize-none bg-transparent px-2 py-1 text-[13px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
        <div className="flex items-center justify-between px-1.5 pt-1">
          <span className="font-mono text-[11px] text-zinc-500 truncate">
            @{label} {external ? "· bus delivery" : "· internal surface"}
          </span>
          <div className="flex items-center gap-1.5">
            {busy && !external && (
              <button
                type="button"
                onClick={() => void cancelWorkerTurn(agentId)}
                title="Cancel current turn (does not close worker)"
                className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/15 px-2.5 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/25 transition-colors cursor-pointer"
              >
                <Stop size={11} weight="fill" />
                <span>Stop</span>
              </button>
            )}
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={() => void handleSubmit()}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-35 active:scale-95 transition-all cursor-pointer"
            >
              <ArrowUp size={14} weight="bold" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MainComposer({ workers }: { workers: WorkerSummary[] }) {
  const { state, dispatch, submitMainInput, notifyToast } = useWorkspace();
  const [input, setInput] = useState("");
  const [showTargetMenu, setShowTargetMenu] = useState(false);

  const handleTextChange = (val: string) => {
    setInput(val);
    if (val.startsWith("/") || val.includes("@")) {
      void ufooBridge.sendCommand("completion.request", { text: val });
    }
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    await submitMainInput(trimmed);
  };

  const handleNewConversation = async () => {
    await submitMainInput("/session new");
    notifyToast("Started fresh ufoo agent conversation");
  };

  const handleQuickThinking = async (effort: string) => {
    await ufooBridge.sendCommand("settings.set", { agent_thinking: effort });
  };

  const targetLabel = useMemo(() => {
    if (!state.targetAgent) return "main (ufoo)";
    const found = workers.find((w) => w.id === state.targetAgent);
    return `@${found?.label || state.targetAgent}`;
  }, [state.targetAgent, workers]);

  const showCompletions =
    (input.startsWith("/") || input.includes("@")) && state.completions.length > 0;

  return (
    <div className="border-t border-white/[0.06] bg-zinc-950/75 px-5 pb-4 pt-2.5">
      <div className="relative mx-auto max-w-3xl">
        {showCompletions && (
          <div className="absolute bottom-full left-0 mb-2 max-h-48 w-80 overflow-y-auto rounded-xl border border-white/[0.1] bg-zinc-900/95 p-1 shadow-2xl backdrop-blur-xl z-20">
            {state.completions.slice(0, 10).map((item, idx) => {
              const token = item.value || item.cmd || item.label || "";
              return (
                <button
                  key={`${token}-${idx}`}
                  type="button"
                  onClick={() => setInput(`${token} `)}
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-blue-500/20 cursor-pointer"
                >
                  <span className="font-mono font-medium text-zinc-100">{token}</span>
                  <span className="truncate text-[11px] text-zinc-400">{item.desc || ""}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="rounded-2xl border border-white/[0.09] bg-zinc-900/90 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] focus-within:border-blue-500/45 transition-colors">
          {state.targetAgent && (
            <div className="mb-1.5 flex items-center gap-1.5 px-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/18 border border-blue-400/30 px-2 py-0.5 text-[11px] font-mono text-blue-300">
                {state.promptPrefix.trim()}
                <button
                  type="button"
                  onClick={() => {
                    dispatch({ type: "SET_TARGET_AGENT", agentId: "", prefix: "› " });
                    void ufooBridge.sendCommand("agent.select", { agent_id: "" });
                  }}
                  className="ml-0.5 hover:text-white cursor-pointer"
                >
                  <X size={10} />
                </button>
              </span>
            </div>
          )}

          <textarea
            rows={3}
            value={input}
            onChange={(e) => handleTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={
              state.scope === "controller"
                ? "Ask Ufoo to route across projects…"
                : "Ask ufoo agent, @worker to dispatch, or /group, /launch, /resume…"
            }
            className="w-full resize-none bg-transparent px-2 py-1 text-[13.5px] leading-relaxed text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />

          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 px-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {/* Target Selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowTargetMenu(!showTargetMenu)}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[11.5px] font-medium text-zinc-300 hover:bg-white/[0.08] transition-colors cursor-pointer"
                >
                  <span>{targetLabel}</span>
                </button>
                {showTargetMenu && (
                  <div className="absolute bottom-full left-0 mb-1.5 w-48 rounded-xl border border-white/[0.1] bg-zinc-900/95 p-1 shadow-xl z-20">
                    <button
                      type="button"
                      onClick={() => {
                        setShowTargetMenu(false);
                        dispatch({ type: "SET_TARGET_AGENT", agentId: "", prefix: "› " });
                        void ufooBridge.sendCommand("agent.select", { agent_id: "" });
                      }}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-200 hover:bg-white/[0.08] cursor-pointer"
                    >
                      <span>main (ufoo agent)</span>
                    </button>
                    {workers.map((w) => (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => {
                          setShowTargetMenu(false);
                          dispatch({
                            type: "SET_TARGET_AGENT",
                            agentId: w.id,
                            prefix: `›@${w.label} `,
                          });
                          void ufooBridge.sendCommand("agent.select", {
                            agent_id: w.id,
                            label: w.label,
                          });
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-white/[0.08] cursor-pointer"
                      >
                        <span className="truncate">@{w.label}</span>
                        <span className="font-mono text-[10px] text-zinc-500">
                          {w.external ? "ext" : w.type}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Model & Effort Selector */}
              <button
                type="button"
                onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: true })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 font-mono text-[11px] text-zinc-300 hover:bg-white/[0.07] transition-colors cursor-pointer"
                title="Configure Provider & Model"
              >
                <Cpu size={12} className="text-blue-400" />
                <span>{state.settings.agent_model || "gpt-6.1-sol"}</span>
              </button>

              <div className="inline-flex items-center rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5 text-[10.5px]">
                {["low", "medium", "high"].map((lvl) => {
                  const active = (state.settings.agent_thinking || "medium") === lvl;
                  return (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => void handleQuickThinking(lvl)}
                      className={`rounded-md px-1.5 py-0.5 capitalize transition-colors cursor-pointer ${
                        active ? "bg-white/[0.12] text-white font-medium" : "text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      {lvl}
                    </button>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => void handleNewConversation()}
                className="rounded-lg px-2 py-1 text-[11px] text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300 transition-colors cursor-pointer"
                title="Start a fresh main conversation (/session new)"
              >
                New Session
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {state.busy && (
                <button
                  type="button"
                  onClick={() => void ufooBridge.sendCommand("task.cancel", {})}
                  className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/15 px-2.5 py-1 text-[11.5px] font-medium text-rose-300 hover:bg-rose-500/25 transition-colors cursor-pointer"
                >
                  <Stop size={12} weight="fill" />
                  <span>Stop</span>
                </button>
              )}

              <button
                type="button"
                disabled={!input.trim()}
                onClick={() => void handleSend()}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-35 active:scale-95 transition-all cursor-pointer"
              >
                <ArrowUp size={15} weight="bold" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmbeddedWorkerCard({
  worker,
  frame,
  onMaximize,
  onOpenFile,
}: {
  worker: WorkerSummary;
  frame?: MultiPaneFrame;
  onMaximize: () => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <div className="flex h-full min-h-[260px] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#101013]">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              frame?.busy || worker.activity_state === "working"
                ? "bg-blue-400 animate-pulse"
                : "bg-emerald-400"
            }`}
          />
          <span className="font-mono text-[12px] font-medium text-zinc-100 truncate">
            {worker.label}
          </span>
          <span className="text-[11px] text-zinc-500 truncate">
            {frame?.status || worker.activity_detail || worker.activity_state || "ready"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {frame?.usage && (
            <span className="font-mono text-[10.5px] text-zinc-500 mr-1">{frame.usage}</span>
          )}
          <button
            type="button"
            onClick={onMaximize}
            title="Open in Single-Worker View"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
          >
            <ArrowsOutSimple size={13} />
          </button>
        </div>
      </div>

      <TranscriptStream
        entries={frame?.entries || []}
        planLines={frame?.plan || []}
        onOpenFile={onOpenFile}
        compact
        emptyTitle={`${worker.label} is ready`}
        emptySubtitle="Send a task directly below or delegate from ufoo agent."
      />

      <WorkerComposer
        agentId={worker.id}
        label={worker.label}
        busy={Boolean(frame?.busy || worker.activity_state === "working")}
        compact
      />
    </div>
  );
}

export function CenterStage() {
  const {
    state,
    dispatch,
    selectProjectMain,
    selectWorkerView,
    setWindowMode,
    selectSideWorker,
    openDocInInspector,
    continueInCli,
    notifyToast,
  } = useWorkspace();

  const currentProject = useMemo(
    () => state.projects.find((p) => p.root === state.activeRoot),
    [state.projects, state.activeRoot]
  );

  const workers = currentProject?.workers || [];
  const internalWorkers = useMemo(() => workers.filter((w) => w.internal), [workers]);

  const isWorkerSingle = state.stageTarget.kind === "worker_single" && Boolean(state.stageTarget.agentId);
  const selectedWorkerMeta = useMemo(
    () => workers.find((w) => w.id === state.stageTarget.agentId),
    [workers, state.stageTarget.agentId]
  );
  const isExternalWorker = isWorkerSingle && Boolean(
    selectedWorkerMeta?.external || (
      state.workerSingleFrame?.agent_id === state.stageTarget.agentId && state.workerSingleFrame.external
    )
  );

  const activeSideWorker = useMemo(() => {
    if (state.sideAgentId) {
      const exact = internalWorkers.find((w) => w.id === state.sideAgentId);
      if (exact) return exact;
    }
    return internalWorkers[0] || null;
  }, [internalWorkers, state.sideAgentId]);

  const handleRespondInteraction = async (answer: string, cancelled = false) => {
    if (!state.pendingInteraction) return;
    await ufooBridge.sendCommand("interaction.respond", {
      id: state.pendingInteraction.id,
      text: answer,
      cancelled,
    });
  };

  const handleLaunchInternalQuick = async (agent = "ucode") => {
    await ufooBridge.sendCommand("worker.launch", { agent });
    notifyToast(`Launching internal ${agent} worker…`);
  };

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-[#0c0c0e]">
      {/* Unified macOS Top Stage Bar */}
      <header
        data-tauri-drag-region
        className={`flex h-[44px] shrink-0 items-center justify-between border-b border-white/[0.06] bg-zinc-950/60 px-4 ${
          !state.leftSidebarOpen ? "pl-[82px]" : ""
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {!state.leftSidebarOpen && (
            <button
              type="button"
              onClick={() => dispatch({ type: "TOGGLE_LEFT_SIDEBAR" })}
              title="Show Sidebar (⌘B)"
              className="mr-1 flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-white cursor-pointer"
            >
              <SidebarSimple size={15} />
            </button>
          )}

          {isWorkerSingle ? (
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                onClick={() => currentProject && void selectProjectMain(currentProject.root)}
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
              >
                <ArrowLeft size={13} />
                <span>{currentProject?.label || "Project"}</span>
              </button>
              <span className="text-zinc-600">/</span>
              <span className="font-mono text-[13px] font-semibold text-zinc-100 truncate">
                {state.workerSingleFrame?.label || selectedWorkerMeta?.label || state.stageTarget.agentId}
              </span>
              {selectedWorkerMeta?.internal && (
                <span className="rounded-md border border-blue-400/25 bg-blue-500/15 px-1.5 py-0.5 font-mono text-[10px] text-blue-300">
                  INTERNAL · {selectedWorkerMeta.type || "worker"}
                </span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13.5px] font-semibold text-zinc-100 truncate">
                {state.scope === "controller"
                  ? "Ufoo"
                  : `${currentProject?.label || "Workspace"} · ufoo agent`}
              </span>
              {currentProject?.branch && (
                <span className="hidden sm:inline-flex items-center gap-1 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                  <GitBranch size={11} />
                  <span>{currentProject.branch}</span>
                </span>
              )}
              {state.busy && (
                <span className="text-[11.5px] text-blue-400 font-mono truncate">
                  {state.statusText}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {state.scope === "project" && (
            <button
              type="button"
              onClick={() =>
                void continueInCli(isWorkerSingle ? state.stageTarget.agentId : "")
              }
              title={isExternalWorker ? "Go to the worker’s window (⌘⇧T)" : "Hand off to CLI Terminal (⌘⇧T)"}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/[0.09] bg-white/[0.04] px-2.5 py-1 text-[11.5px] font-medium text-zinc-200 hover:border-blue-400/40 hover:bg-blue-500/15 transition-all active:scale-[0.98] cursor-pointer"
            >
              <TerminalWindow size={13} className="text-blue-400" />
              <span>{isExternalWorker ? "Go Window" : "CLI"}</span>
              <ArrowUpRight size={11} className="text-zinc-400" />
            </button>
          )}

          <button
            type="button"
            onClick={() => dispatch({ type: "TOGGLE_RIGHT_INSPECTOR" })}
            title="Toggle Workspace Inspector (⌘⌥B)"
            className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors cursor-pointer ${
              state.rightInspectorOpen
                ? "bg-white/[0.1] text-white"
                : "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200"
            }`}
          >
            <SidebarSimple size={15} className="rotate-180" />
          </button>
        </div>
      </header>

      {/* Stage Body: 4 Dynamic Presentations */}
      {isWorkerSingle ? (
        /* MODE 4: Single Worker Full-Width Stage (No Multi-Window Chrome) */
        <div className="flex flex-1 min-h-0 flex-col">
          <TranscriptStream
            entries={state.workerSingleFrame?.entries || []}
            planLines={state.workerSingleFrame?.plan || []}
            onOpenFile={(p) => void openDocInInspector(p)}
            emptyTitle={`${state.workerSingleFrame?.label || state.stageTarget.agentId} session`}
            emptySubtitle="Send a prompt below to interact directly with this worker."
          />

          <WorkerComposer
            agentId={state.stageTarget.agentId}
            label={state.workerSingleFrame?.label || selectedWorkerMeta?.label || state.stageTarget.agentId}
            busy={Boolean(state.workerSingleFrame?.busy)}
            external={isExternalWorker}
          />
        </div>
      ) : state.windowMode === "side" && state.scope === "project" ? (
        /* MODE 2: ufoo agent + Switchable Side Sub-Agent */
        <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.07]">
          <div className="lg:col-span-6 flex min-h-0 flex-col">
            <TranscriptStream
              entries={state.entries}
              planLines={state.planLines}
              pendingInteraction={state.pendingInteraction}
              onRespondInteraction={(ans, c) => void handleRespondInteraction(ans, c)}
              onOpenFile={(p) => void openDocInInspector(p)}
              onInspectWorkerInSide={(id) => void selectSideWorker(id)}
              compact
            />
            <MainComposer workers={workers} />
          </div>

          <div className="lg:col-span-6 flex min-h-0 flex-col bg-[#0e0e11]">
            {/* Side Worker Switcher Bar */}
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.06] px-3 gap-2 overflow-x-auto">
              <div className="flex items-center gap-1 min-w-0">
                {internalWorkers.length === 0 ? (
                  <span className="text-[12px] text-zinc-500">No active internal workers</span>
                ) : (
                  internalWorkers.map((w) => {
                    const selected = activeSideWorker?.id === w.id;
                    return (
                      <button
                        key={w.id}
                        type="button"
                        onClick={() => void selectSideWorker(w.id)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-[11.5px] transition-colors cursor-pointer ${
                          selected
                            ? "bg-blue-500/20 text-blue-200 border border-blue-400/30"
                            : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 border border-transparent"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            w.activity_state === "working" ? "bg-blue-400 animate-pulse" : "bg-emerald-400"
                          }`}
                        />
                        <span>{w.label}</span>
                      </button>
                    );
                  })
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => void handleLaunchInternalQuick("ucode")}
                  title="Launch internal ucode worker"
                  className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/[0.09] cursor-pointer"
                >
                  <Plus size={11} weight="bold" />
                  <span>ucode</span>
                </button>
                {activeSideWorker && currentProject && (
                  <button
                    type="button"
                    onClick={() => void selectWorkerView(currentProject.root, activeSideWorker.id)}
                    title="Expand to Single-Worker View"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-white cursor-pointer"
                  >
                    <ArrowsOutSimple size={13} />
                  </button>
                )}
              </div>
            </div>

            {activeSideWorker ? (
              <div className="flex flex-1 min-h-0 flex-col p-2.5">
                <EmbeddedWorkerCard
                  worker={activeSideWorker}
                  frame={state.paneFrames[activeSideWorker.id]}
                  onMaximize={() =>
                    currentProject && void selectWorkerView(currentProject.root, activeSideWorker.id)
                  }
                  onOpenFile={(p) => void openDocInInspector(p)}
                />
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                <div className="text-[13px] font-medium text-zinc-300">
                  Side pane ready for internal workers
                </div>
                <div className="mt-1 max-w-xs text-[12px] text-zinc-500">
                  Launch an internal worker (`ucode`, `codex`, or `claude`) to inspect and steer it alongside ufoo agent.
                </div>
                <div className="mt-3 flex items-center gap-2">
                  {["ucode", "codex", "claude"].map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => void handleLaunchInternalQuick(kind)}
                      className="rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 font-mono text-[12px] text-zinc-200 hover:bg-blue-500/20 hover:border-blue-400/35 transition-colors cursor-pointer"
                    >
                      + {kind}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : state.windowMode === "multi" && state.scope === "project" ? (
        /* MODE 3: ufoo agent + Multi Sub-Agent Grid */
        <div className="grid flex-1 min-h-0 grid-cols-1 lg:grid-cols-12 divide-y lg:divide-y-0 lg:divide-x divide-white/[0.07]">
          <div className="lg:col-span-5 flex min-h-0 flex-col">
            <TranscriptStream
              entries={state.entries}
              planLines={state.planLines}
              pendingInteraction={state.pendingInteraction}
              onRespondInteraction={(ans, c) => void handleRespondInteraction(ans, c)}
              onOpenFile={(p) => void openDocInInspector(p)}
              compact
            />
            <MainComposer workers={workers} />
          </div>

          <div className="lg:col-span-7 flex min-h-0 flex-col bg-[#0e0e11] overflow-y-auto p-3">
            {internalWorkers.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
                <div className="text-[13px] font-medium text-zinc-300">
                  Multi-agent grid ready
                </div>
                <div className="mt-1 max-w-xs text-[12px] text-zinc-500">
                  Launch multiple internal workers or run `/group run` to monitor all agents in parallel.
                </div>
                <div className="mt-3 flex items-center gap-2">
                  {["ucode", "codex", "claude"].map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => void handleLaunchInternalQuick(kind)}
                      className="rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 font-mono text-[12px] text-zinc-200 hover:bg-blue-500/20 transition-colors cursor-pointer"
                    >
                      + {kind}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div
                className={`grid gap-3 h-full ${
                  internalWorkers.length === 1 ? "grid-cols-1" : "grid-cols-1 xl:grid-cols-2"
                }`}
              >
                {internalWorkers.map((worker) => (
                  <EmbeddedWorkerCard
                    key={worker.id}
                    worker={worker}
                    frame={state.paneFrames[worker.id]}
                    onMaximize={() =>
                      currentProject && void selectWorkerView(currentProject.root, worker.id)
                    }
                    onOpenFile={(p) => void openDocInInspector(p)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* MODE 1: Main Only (ufoo agent full width) */
        <div className="flex flex-1 min-h-0 flex-col">
          <TranscriptStream
            entries={state.entries}
            planLines={state.planLines}
            pendingInteraction={state.pendingInteraction}
            onRespondInteraction={(ans, c) => void handleRespondInteraction(ans, c)}
            onOpenFile={(p) => void openDocInInspector(p)}
            onInspectWorkerInSide={(id) => void setWindowMode("side", id)}
          />
          <MainComposer workers={workers} />
        </div>
      )}
    </main>
  );
}
