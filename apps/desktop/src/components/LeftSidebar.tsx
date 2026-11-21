import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  DotsThree,
  FolderOpen,
  FolderPlus,
  GearSix,
  GitBranch,
  GlobeSimple,
  MagnifyingGlass,
  Plus,
  SidebarSimple,
  X,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import type { ProjectTreeNode, WorkerSummary } from "../types";
import { WORKER_AGENTS, type WorkerAgent } from "../workerAgents";

const WORKER_MENU_ICONS: Record<WorkerAgent, string> = {
  codex: new URL("../assets/chatgpt.png", import.meta.url).href,
  claude: new URL("../assets/clawd.png", import.meta.url).href,
  ucode: new URL("../assets/ufoo-planet.png", import.meta.url).href,
};
const launchMenuItemClassName =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] text-zinc-200 hover:bg-blue-500/20 hover:text-white focus-visible:bg-blue-500/20 focus-visible:outline-none transition-colors cursor-pointer";
const launchMenuHeight = 131; // Four 28px rows, a separator, padding, and border.

function WorkerStatusDot({ worker }: { worker: WorkerSummary }) {
  if (worker.activity_state === "working" || worker.activity_state === "starting") {
    return (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
    );
  }
  if (worker.activity_state === "waiting_input" || worker.activity_state === "blocked") {
    return <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-400" />;
  }
  return (
    <span
      className={`inline-flex h-2 w-2 shrink-0 rounded-full ${
        worker.external ? "bg-teal-400/80" : "bg-emerald-400/80"
      }`}
    />
  );
}

function ProjectGroup({ project }: { project: ProjectTreeNode }) {
  const { state, selectProjectMain, selectWorkerView, notifyToast } = useWorkspace();
  const [expanded, setExpanded] = useState(true);
  const [showRecov, setShowRecov] = useState(false);
  const [launchMenu, setLaunchMenu] = useState<React.CSSProperties | null>(null);
  const [launching, setLaunching] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!launchMenu) return;
    menu.current?.querySelector("button")?.focus();
    const dismiss = () => setLaunchMenu(null);
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !menuTrigger.current?.contains(target)) dismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismiss();
      menuTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [launchMenu]);

  const isCurrentProject = state.activeRoot === project.root && state.scope === "project";
  const isMainSelected = isCurrentProject && state.stageTarget.kind === "project_main";
  const selectedWorkerId =
    isCurrentProject && state.stageTarget.kind === "worker_single"
      ? state.stageTarget.agentId
      : "";

  const handleLaunchWorker = async (agent: WorkerAgent) => {
    setLaunchMenu(null);
    setLaunching(true);
    try {
      const result = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>(
        "worker.launch", { root: project.root, agent }
      );
      if (!result.ok) throw new Error(result.error || "Could not launch worker");
      notifyToast(`Launched ${WORKER_AGENTS.find(({ id }) => id === agent)?.label || agent}`);
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    } finally {
      setLaunching(false);
    }
  };

  const toggleLaunchMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (launchMenu) {
      setLaunchMenu(null);
      return;
    }
    const { top, right, bottom } = event.currentTarget.getBoundingClientRect();
    const vertical = window.innerHeight - bottom >= launchMenuHeight + 4
      ? { top: bottom + 4 }
      : { bottom: window.innerHeight - top + 4 };
    setLaunchMenu({ right: window.innerWidth - right, ...vertical });
  };

  const handleOpenInFinder = async () => {
    setLaunchMenu(null);
    menuTrigger.current?.focus();
    try {
      await ufooBridge.openProjectInFinder(project.root);
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCloseWorker = async (e: React.MouseEvent, workerId: string) => {
    e.stopPropagation();
    await ufooBridge.sendCommand("agent.close", { agent_id: workerId });
  };

  const handleResume = async (targetId: string) => {
    if (!isCurrentProject) {
      await selectProjectMain(project.root);
    }
    await ufooBridge.sendCommand("worker.resume", { id: targetId });
    notifyToast(`Resuming ${targetId}…`);
  };

  const handleArchive = async (e: React.MouseEvent, sessionId?: string) => {
    e.stopPropagation();
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; silent?: boolean; error?: string }>(
        sessionId ? "session.archive" : "project.archive",
        sessionId ? { root: project.root, session_id: sessionId } : { root: project.root }
      );
      if (res.ok && res.silent) return;
      notifyToast(res.ok ? (sessionId ? "Session archived" : "Folder archived") : (res.error || "Archive failed"));
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="mb-1.5">
      {/* Level 1: Project Root Node === ufoo agent */}
      <div
        onClick={() => void selectProjectMain(project.root)}
        className={`group relative grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-xl px-2 py-1.5 text-[13px] transition-colors cursor-pointer ${
          isMainSelected
            ? "bg-white/[0.11] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
            : "text-zinc-300 hover:bg-white/[0.05] hover:text-zinc-100"
        }`}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:text-zinc-200 cursor-pointer"
        >
          {expanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
        </button>

        <FolderOpen
          size={15}
          weight={isMainSelected ? "fill" : "regular"}
          className={isMainSelected ? "text-blue-400 shrink-0" : "text-zinc-400 shrink-0"}
        />

        <div className="flex min-w-0 items-center gap-1.5 leading-5">
          <span className="truncate font-medium">{project.label}</span>
          {project.waitingUser && (
            <span
              className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse"
              title="ufoo agent waiting for confirmation"
            />
          )}
          {project.mainBusy && !project.waitingUser && (
            <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-blue-400 border-t-transparent" />
          )}
        </div>

        <div className="relative flex items-center">
          <button
            type="button"
            onClick={(e) => void handleArchive(e)}
            title="Archive folder"
            aria-label={`Archive folder ${project.label}`}
            className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/[0.1] hover:text-white cursor-pointer"
          >
            <Archive size={13} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleLaunchWorker(state.defaultWorkerAgent);
            }}
            disabled={launching}
            aria-label="Launch default worker"
            title={`Launch ${WORKER_AGENTS.find(({ id }) => id === state.defaultWorkerAgent)?.label || state.defaultWorkerAgent}`}
            className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/[0.1] hover:text-white disabled:cursor-wait cursor-pointer"
          >
            <Plus size={12} weight="bold" />
          </button>
          <button
            ref={menuTrigger}
            type="button"
            onClick={toggleLaunchMenu}
            disabled={launching}
            aria-expanded={Boolean(launchMenu)}
            aria-controls={launchMenu ? menuId : undefined}
            aria-label="Worker launch options"
            title="Worker launch options"
            className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 hover:bg-white/[0.1] hover:text-white disabled:cursor-wait cursor-pointer"
          >
            <DotsThree size={15} weight="bold" />
          </button>

          {launchMenu && createPortal(
            <div
              ref={menu}
              id={menuId}
              style={launchMenu}
              onClick={(e) => e.stopPropagation()}
              className="fixed z-30 w-40 rounded-xl border border-white/[0.1] bg-zinc-900 p-1 shadow-xl"
            >
              {WORKER_AGENTS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => void handleLaunchWorker(id)}
                  className={launchMenuItemClassName}
                >
                  <img
                    src={WORKER_MENU_ICONS[id]}
                    alt=""
                    className={`size-4 shrink-0 object-contain ${id === "ucode" ? "" : "p-0.5"}`}
                  />
                  <span>Launch {id === "claude" ? "Claude" : label}</span>
                </button>
              ))}
              <div role="separator" className="my-1 border-t border-white/10" />
              <button
                type="button"
                onClick={() => void handleOpenInFinder()}
                className={launchMenuItemClassName}
              >
                <FolderOpen size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
                <span>Open in Finder</span>
              </button>
            </div>,
            document.body
          )}
        </div>
        {project.branch && (
          <div className="col-span-2 col-start-3 row-start-2 flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-zinc-500">
            <GitBranch size={10} className="shrink-0" />
            <span className="truncate" title={project.branch}>{project.branch}</span>
          </div>
        )}
      </div>

      {/* Level 2: Worker Agents under this Project */}
      {expanded && (project.workers.length > 0 || project.recoverable.length > 0) && (
        <div className="mt-0.5 ml-4 border-l border-white/[0.07] pl-2 space-y-0.5">
          {project.workers.map((worker) => {
            const isSelected = selectedWorkerId === worker.id;
            return (
              <div
                key={worker.id}
                onClick={() => void selectWorkerView(project.root, worker.id)}
                className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-all cursor-pointer ${
                  isSelected
                    ? "bg-blue-500/18 text-white border border-blue-400/30"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200 border border-transparent"
                }`}
              >
                <WorkerStatusDot worker={worker} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-zinc-200">{worker.label}</span>
                    {worker.group_template_alias && (
                      <span className="rounded bg-white/[0.07] px-1 py-0.2 font-mono text-[9.5px] text-zinc-400">
                        {worker.group_template_alias}
                      </span>
                    )}
                    {worker.external && (
                      <span className="rounded bg-teal-500/15 px-1 py-0.2 font-mono text-[9.5px] text-teal-300">
                        EXT
                      </span>
                    )}
                  </div>
                  {worker.activity_detail && (
                    <div className="truncate text-[10.5px] text-zinc-500">
                      {worker.activity_detail}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => void handleArchive(e, worker.id)}
                    title="Archive session"
                    aria-label={`Archive session ${worker.label}`}
                    className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.1] hover:text-white cursor-pointer"
                  >
                    <Archive size={13} />
                  </button>
                  {worker.internal && (
                    <button
                      type="button"
                      onClick={(e) => void handleCloseWorker(e, worker.id)}
                      title="Close internal worker"
                      className="flex h-4 w-4 items-center justify-center rounded text-zinc-500 hover:bg-white/[0.1] hover:text-rose-300 cursor-pointer"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          {project.recoverable.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowRecov(!showRecov)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
              >
                <ArrowCounterClockwise size={11} />
                <span>Recoverable</span>
              </button>
              {showRecov && (
                <div className="space-y-0.5 pl-2 pt-0.5">
                  {project.recoverable.map((rec) => (
                    <div
                      key={rec.id}
                      className="group flex items-center rounded-md text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                    >
                      <button
                        type="button"
                        onClick={() => void handleResume(rec.id)}
                        className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1 text-left text-[11.5px] cursor-pointer"
                      >
                        <span className="truncate font-mono">{rec.label || rec.id}</span>
                        <span className="text-[10px] text-blue-400">Resume</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => void handleArchive(e, rec.id)}
                        title="Archive session"
                        aria-label={`Archive session ${rec.label || rec.id}`}
                        className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-white/[0.1] hover:text-white cursor-pointer"
                      >
                        <Archive size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function LeftSidebar() {
  const { state, dispatch, notifyToast } = useWorkspace();
  const [filter, setFilter] = useState("");

  if (!state.leftSidebarOpen) return null;

  const handleAddProject = async () => {
    const picked = await ufooBridge.pickProjectFolder();
    if (!picked) return;
    const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("project.add", {
      root: picked,
    });
    if (res?.ok) {
      notifyToast(`Opened project ${picked.split("/").pop()}`);
    } else if (res?.error) {
      notifyToast(res.error);
    }
  };

  const handleSelectGlobalRouter = async () => {
    await ufooBridge.sendCommand("project.return_controller", {});
  };

  const needle = filter.trim().toLowerCase();
  const visibleProjects = needle
    ? state.projects.filter(
        (p) =>
          p.label.toLowerCase().includes(needle) ||
          p.workers.some((w) => w.label.toLowerCase().includes(needle))
      )
    : state.projects.slice();
  visibleProjects.sort((a, b) => a.label.localeCompare(b.label) || a.root.localeCompare(b.root));

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-white/[0.07] bg-zinc-950 select-none">
      {/* macOS Traffic Lights Inset + Drag Header */}
      <div
        data-tauri-drag-region
        className="flex h-[44px] shrink-0 items-center justify-end pl-[78px] pr-2.5 border-b border-white/[0.05]"
      >
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void handleAddProject()}
            title="Add Project Folder"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <FolderPlus size={15} />
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "TOGGLE_LEFT_SIDEBAR" })}
            title="Toggle Sidebar (⌘B)"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <SidebarSimple size={15} />
          </button>
        </div>
      </div>

      {/* Filter & Global Router */}
      <div className="px-2.5 pt-2.5 pb-1.5 space-y-1.5">
        <div className="relative flex items-center">
          <MagnifyingGlass size={13} className="absolute left-2.5 text-zinc-500 pointer-events-none" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter projects or workers…"
            className="w-full rounded-lg border border-white/[0.06] bg-white/[0.03] py-1.5 pl-7 pr-2.5 text-[12px] text-zinc-200 placeholder:text-zinc-500 focus:border-blue-500/40 focus:outline-none"
          />
        </div>

        <button
          type="button"
          onClick={() => void handleSelectGlobalRouter()}
          className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer ${
            state.scope === "controller"
              ? "bg-white/[0.11] text-white font-medium"
              : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          }`}
        >
          <GlobeSimple size={15} className={state.scope === "controller" ? "text-blue-400" : "text-zinc-400"} />
          <span>Ufoo</span>
        </button>
      </div>

      <div className="px-3 pt-2 pb-1 text-[10.5px] font-medium text-zinc-500">
        Workspaces & Workers
      </div>

      {/* Project + Worker 2-Level Tree */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {visibleProjects.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <div className="text-[12px] text-zinc-500">No projects registered yet</div>
            <button
              type="button"
              onClick={() => void handleAddProject()}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
            >
              <FolderPlus size={14} />
              <span>Open Folder…</span>
            </button>
          </div>
        ) : (
          visibleProjects.map((project) => <ProjectGroup key={project.id} project={project} />)
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-white/[0.06] bg-black/20 px-2.5 py-1.5 text-[11px] text-zinc-400">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              state.connected ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
            }`}
          />
          <span className="truncate">{state.connected ? "Online" : "Connecting…"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {state.cronTasks.length > 0 && (
            <span className="rounded bg-white/[0.06] px-1 font-mono text-[10px] text-zinc-300">
              {state.cronTasks.length} cron
            </span>
          )}
          <button
            type="button"
            onClick={() => dispatch({ type: "SET_SETTINGS_MODAL", open: true })}
            aria-label="Settings"
            title="Settings"
            className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/[0.06] hover:text-zinc-200 transition-colors cursor-pointer"
          >
            <GearSix size={13} />
          </button>
        </div>
      </footer>
    </aside>
  );
}
