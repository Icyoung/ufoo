import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowCounterClockwise,
  CaretDown,
  CaretRight,
  DeviceMobile,
  DotsThree,
  Folder,
  FolderOpen,
  FolderPlus,
  GearSix,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  PushPin,
  PushPinSlash,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { isTauriEnvironment, ufooBridge } from "../bridge/ufooClient";
import type { ArchivedSessionItem, ProjectTreeNode } from "../types";
import { WORKER_AGENTS } from "../workerAgents";
import { BrandIcon, buildProjectUcodeColorMap } from "./BrandIcon";
import { LeftSidebarIcon, NavBackIcon, NavForwardIcon } from "./WindowChromeIcons";

const menuItemClassName =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] text-zinc-200 hover:bg-white/[0.09] hover:text-white focus-visible:bg-white/[0.09] focus-visible:outline-none transition-colors cursor-pointer";

const dangerMenuItemClassName =
  "flex h-7 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12px] text-rose-400 hover:bg-rose-500/15 hover:text-rose-300 focus-visible:bg-rose-500/15 focus-visible:outline-none transition-colors cursor-pointer";

type MenuAnchor =
  | { kind: "element"; el: HTMLElement | null }
  | { kind: "point"; x: number; y: number };

function computeMenuPosition(
  anchor: MenuAnchor | null,
  menuEl: HTMLElement | null,
  fallbackHeight = 200
): React.CSSProperties {
  if (!anchor) return { top: 0, right: 8 };
  const margin = 8;
  const gap = 4;
  const menuHeight = menuEl ? menuEl.scrollHeight : fallbackHeight;
  const menuWidth = menuEl ? menuEl.offsetWidth || 176 : 176;

  if (anchor.kind === "point") {
    const spaceBelow = Math.max(0, window.innerHeight - anchor.y - margin);
    const spaceAbove = Math.max(0, anchor.y - margin);
    const openAbove = spaceBelow < menuHeight && spaceAbove >= spaceBelow;
    const left = Math.max(margin, Math.min(anchor.x, window.innerWidth - menuWidth - margin));
    if (openAbove) {
      return {
        left,
        bottom: Math.max(margin, window.innerHeight - anchor.y),
        maxHeight: Math.max(120, spaceAbove),
      };
    }
    return {
      left,
      top: Math.max(margin, anchor.y),
      maxHeight: Math.max(120, spaceBelow),
    };
  }

  const trigger = anchor.el;
  if (!trigger) return { top: 0, right: 8 };
  const rect = trigger.getBoundingClientRect();
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
  const spaceAbove = Math.max(0, rect.top - margin - gap);
  const openAbove = spaceBelow < menuHeight && spaceAbove >= spaceBelow;
  const right = Math.max(margin, window.innerWidth - rect.right);

  if (openAbove) {
    return {
      right,
      bottom: Math.max(margin, window.innerHeight - rect.top + gap),
      maxHeight: Math.max(120, spaceAbove),
    };
  }
  return {
    right,
    top: Math.max(margin, rect.bottom + gap),
    maxHeight: Math.max(120, spaceBelow),
  };
}

interface SessionMenuState {
  sessionId: string;
  label: string;
  section: "active" | "recoverable" | "archived";
  pinned: boolean;
  recoverable: boolean;
  worktreeBranch: string;
  anchor: MenuAnchor;
}

interface DeleteConfirmState {
  sessionId: string;
  label: string;
  worktreeBranch: string;
}

function ProjectGroup({ project }: { project: ProjectTreeNode }) {
  const { state, selectProjectMain, selectWorkerView, notifyToast } = useWorkspace();
  const [expanded, setExpanded] = useState(true);
  const [showRecov, setShowRecov] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Project folder launch menu
  const [launchMenuOpen, setLaunchMenuOpen] = useState(false);
  const [launchMenuStyle, setLaunchMenuStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const [launching, setLaunching] = useState(false);
  const menuId = useId();
  const menu = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  // Session menu + inline rename + delete confirmation
  const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);
  const [sessionMenuStyle, setSessionMenuStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  const [renamingId, setRenamingId] = useState<string>("");
  const [renameDraft, setRenameDraft] = useState<string>("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [deleteTarget, setDeleteTarget] = useState<DeleteConfirmState | null>(null);
  const [deleting, setDeleting] = useState(false);

  useLayoutEffect(() => {
    if (!launchMenuOpen) return;
    setLaunchMenuStyle(
      computeMenuPosition({ kind: "element", el: menuTrigger.current }, menu.current, 220)
    );
  }, [launchMenuOpen, state.engineCatalog]);

  useLayoutEffect(() => {
    if (!sessionMenu) return;
    setSessionMenuStyle(computeMenuPosition(sessionMenu.anchor, sessionMenuRef.current, 148));
  }, [sessionMenu]);

  useEffect(() => {
    if (!renamingId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingId]);

  useEffect(() => {
    if (!launchMenuOpen) return;
    menu.current?.querySelector("button")?.focus();
    const dismiss = () => setLaunchMenuOpen(false);
    const dismissOnScroll = (event: Event) => {
      if (menu.current?.contains(event.target as Node)) return;
      dismiss();
    };
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
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [launchMenuOpen]);

  useEffect(() => {
    if (!sessionMenu) return;
    sessionMenuRef.current?.querySelector("button")?.focus();
    const dismiss = () => setSessionMenu(null);
    const dismissOnScroll = (event: Event) => {
      if (sessionMenuRef.current?.contains(event.target as Node)) return;
      dismiss();
    };
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (sessionMenuRef.current?.contains(target)) return;
      if (sessionMenu.anchor.kind === "element" && sessionMenu.anchor.el?.contains(target)) return;
      dismiss();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      dismiss();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [sessionMenu]);

  useEffect(() => {
    if (!deleteTarget) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        event.preventDefault();
        setDeleteTarget(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteTarget, deleting]);

  const isCurrentProject = state.activeRoot === project.root && state.scope === "project";
  const isMainSelected = isCurrentProject && state.stageTarget.kind === "project_main";
  const selectedWorkerId =
    isCurrentProject && state.stageTarget.kind === "worker_single"
      ? state.stageTarget.agentId
      : "";

  const archivedList: ArchivedSessionItem[] = Array.isArray(project.archived) ? project.archived : [];
  const ucodeColorMap = useMemo(
    () => buildProjectUcodeColorMap(project.root, project.workers, archivedList),
    [project.root, project.workers, archivedList]
  );

  const handleLaunchWorker = async (agent: string) => {
    setLaunchMenuOpen(false);
    setLaunching(true);
    try {
      const result = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>(
        "worker.launch", { root: project.root, agent }
      );
      if (!result.ok) throw new Error(result.error || "Could not launch worker");
      const engineLabel = state.engineCatalog.find((e) => e.agentType === agent)?.label
        || WORKER_AGENTS.find(({ id }) => id === agent)?.label
        || agent;
      notifyToast(`Launched ${engineLabel}`);
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    } finally {
      setLaunching(false);
    }
  };

  const toggleLaunchMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setSessionMenu(null);
    if (launchMenuOpen) {
      setLaunchMenuOpen(false);
      return;
    }
    setLaunchMenuStyle(
      computeMenuPosition({ kind: "element", el: event.currentTarget }, null, 220)
    );
    setLaunchMenuOpen(true);
  };

  const openSessionMenu = (
    event: React.MouseEvent,
    info: Omit<SessionMenuState, "anchor">,
    fromContextMenu = false
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setLaunchMenuOpen(false);
    if (!fromContextMenu && sessionMenu?.sessionId === info.sessionId) {
      setSessionMenu(null);
      return;
    }
    const anchor: MenuAnchor = fromContextMenu
      ? { kind: "point", x: event.clientX, y: event.clientY }
      : { kind: "element", el: event.currentTarget as HTMLElement };
    setSessionMenuStyle(computeMenuPosition(anchor, null, 148));
    setSessionMenu({ ...info, anchor });
  };

  const handleOpenInFinder = async () => {
    setLaunchMenuOpen(false);
    menuTrigger.current?.focus();
    try {
      await ufooBridge.openProjectInFinder(project.root);
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const handleResume = async (targetId: string) => {
    if (!isCurrentProject) {
      await selectProjectMain(project.root);
    }
    await ufooBridge.sendCommand("worker.resume", { id: targetId });
    notifyToast(`Resuming ${targetId}…`);
  };

  const handleArchiveProject = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; silent?: boolean; error?: string }>(
        "project.archive",
        { root: project.root }
      );
      if (res.ok && res.silent) return;
      notifyToast(res.ok ? "Folder archived" : (res.error || "Archive failed"));
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSessionArchive = async (sessionId: string) => {
    setSessionMenu(null);
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; stopped?: boolean; error?: string }>(
        "session.archive",
        { root: project.root, session_id: sessionId }
      );
      if (!res?.ok) throw new Error(res?.error || "Archive failed");
      notifyToast("Session archived");
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSessionUnarchive = async (sessionId: string) => {
    setSessionMenu(null);
    try {
      const res = await ufooBridge.sendCommand<{
        ok: boolean;
        resumed?: boolean;
        active?: boolean;
        error?: string;
      }>("session.unarchive", { root: project.root, session_id: sessionId, resume: true });
      if (!res?.ok) throw new Error(res?.error || "Restore failed");
      notifyToast(res.resumed ? "Session restored & resuming…" : "Session restored");
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const handleSessionPin = async (sessionId: string, nextPinned: boolean) => {
    setSessionMenu(null);
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; pinned?: boolean; error?: string }>(
        "session.pin",
        { root: project.root, session_id: sessionId, pinned: nextPinned }
      );
      if (!res?.ok) throw new Error(res?.error || "Pin update failed");
      notifyToast(res.pinned ? "Session pinned" : "Session unpinned");
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const startInlineRename = (sessionId: string, currentLabel: string) => {
    setSessionMenu(null);
    setRenamingId(sessionId);
    setRenameDraft(currentLabel);
  };

  const commitInlineRename = async (sessionId: string, originalLabel: string) => {
    const next = renameDraft.trim();
    setRenamingId("");
    if (!next || next === originalLabel) return;
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; label?: string; error?: string }>(
        "session.rename",
        { root: project.root, session_id: sessionId, label: next }
      );
      if (!res?.ok) throw new Error(res?.error || "Rename failed");
      notifyToast(`Renamed to ${res.label || next}`);
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    }
  };

  const confirmDeleteSession = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await ufooBridge.sendCommand<{
        ok: boolean;
        worktree_removed?: boolean;
        worktree_kept?: string;
        error?: string;
      }>("session.delete", {
        root: project.root,
        session_id: deleteTarget.sessionId,
      });
      if (!res?.ok) throw new Error(res?.error || "Delete failed");
      setDeleteTarget(null);
      if (res.worktree_kept) {
        notifyToast("Session deleted (kept worktree with uncommitted changes)");
      } else {
        notifyToast("Session deleted");
      }
    } catch (error) {
      notifyToast(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  };

  const hasSubItems = project.workers.length > 0 || project.recoverable.length > 0 || archivedList.length > 0;

  return (
    <div className="mb-1.5">
      {/* Level 1: Project Root Node === ufoo agent */}
      <div
        onClick={() => void selectProjectMain(project.root)}
        className={`group relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 rounded-xl px-2 py-1.5 text-[13px] transition-colors cursor-pointer ${
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
          title={expanded ? "Collapse project" : "Expand project"}
          aria-label={expanded ? `Collapse ${project.label}` : `Expand ${project.label}`}
          aria-expanded={expanded}
          className={`flex h-5 w-5 items-center justify-center rounded transition-colors cursor-pointer ${
            isMainSelected
              ? "text-zinc-200 hover:bg-white/[0.08] hover:text-white"
              : "text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
          }`}
        >
          {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
        </button>

        <div className="flex min-w-0 items-center gap-1.5 leading-5">
          <span className="truncate font-medium">{project.label}</span>
          {project.waitingUser && (
            <span
              className="inline-flex h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse"
              title="ufoo waiting for confirmation"
            />
          )}
          {project.mainBusy && !project.waitingUser && (
            <span className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-400 border-t-transparent" />
          )}
        </div>

        <div className="relative flex items-center">
          <button
            type="button"
            onClick={(e) => void handleArchiveProject(e)}
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
            aria-expanded={launchMenuOpen}
            aria-controls={launchMenuOpen ? menuId : undefined}
            aria-label="Worker launch options"
            title="Worker launch options"
            className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 hover:bg-white/[0.1] hover:text-white disabled:cursor-wait cursor-pointer"
          >
            <DotsThree size={15} weight="bold" />
          </button>

          {launchMenuOpen && createPortal(
            <div
              ref={menu}
              id={menuId}
              style={launchMenuStyle}
              onClick={(e) => e.stopPropagation()}
              className="fixed z-50 w-48 overflow-y-auto rounded-xl border border-white/[0.1] bg-zinc-900 p-1 shadow-xl"
            >
              {WORKER_AGENTS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => void handleLaunchWorker(id)}
                  className={menuItemClassName}
                >
                  <BrandIcon brand={id} size={15} />
                  <span>Launch {id === "claude" ? "Claude" : label}</span>
                </button>
              ))}
              {state.engineCatalog.some((e) => e.kind === "acp" && e.available) && (
                <>
                  <div role="separator" className="my-1 border-t border-white/10" />
                  <div className="px-2.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    ACP Agents
                  </div>
                  {state.engineCatalog
                    .filter((e) => e.kind === "acp" && e.available)
                    .map((eng) => (
                      <button
                        key={eng.agentType}
                        type="button"
                        onClick={() => void handleLaunchWorker(eng.agentType)}
                        className={menuItemClassName}
                      >
                        <BrandIcon brand={eng.agentType} size={15} />
                        <span className="truncate">{eng.label.replace(/\s*\(ACP\)$/i, "")}</span>
                      </button>
                    ))}
                </>
              )}
              <div role="separator" className="my-1 border-t border-white/10" />
              <button
                type="button"
                onClick={() => void handleOpenInFinder()}
                className={menuItemClassName}
              >
                <span>Open in Finder</span>
              </button>
            </div>,
            document.body
          )}
        </div>
        {project.branch && (
          <div className="col-span-2 col-start-2 row-start-2 flex min-w-0 items-center font-mono text-[10.5px] text-zinc-500">
            <span className="truncate" title={project.branch}>{project.branch}</span>
          </div>
        )}
      </div>

      {/* Level 2: Worker Sessions under this Project */}
      {expanded && hasSubItems && (
        <div className="mt-0.5 pl-5 space-y-0.5">
          {project.workers.map((worker) => {
            const isSelected = selectedWorkerId === worker.id;
            const isMenuOpen = sessionMenu?.sessionId === worker.id;
            const isRenaming = renamingId === worker.id;
            return (
              <div
                key={worker.id}
                onClick={() => {
                  if (isRenaming) return;
                  void selectWorkerView(project.root, worker.id);
                }}
                onContextMenu={(e) =>
                  openSessionMenu(
                    e,
                    {
                      sessionId: worker.id,
                      label: worker.label,
                      section: "active",
                      pinned: Boolean(worker.pinned),
                      recoverable: false,
                      worktreeBranch: worker.worktree_branch || "",
                    },
                    true
                  )
                }
                className={`group flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-[12.5px] transition-colors cursor-pointer ${
                  isSelected
                    ? "bg-white/[0.1] text-white border border-white/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200 border border-transparent"
                }`}
              >
                <BrandIcon brand={worker.type} color={ucodeColorMap[worker.id]} size={14} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    {isRenaming ? (
                      <input
                        ref={renameInputRef}
                        type="text"
                        value={renameDraft}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void commitInlineRename(worker.id, worker.label)}
                        onKeyDown={(e) => {
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void commitInlineRename(worker.id, worker.label);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRenamingId("");
                          }
                        }}
                        aria-label="Rename session"
                        className="w-full min-w-0 rounded border border-white/[0.24] bg-zinc-950 px-1.5 py-0.5 text-[12px] font-medium text-white focus:outline-none"
                      />
                    ) : (
                      <span
                        title={
                          worker.worktree_branch
                            ? `${worker.label} · ${worker.worktree_branch}`
                            : worker.label
                        }
                        className={`min-w-0 truncate font-medium ${isSelected ? "text-white" : "text-zinc-200"}`}
                      >
                        {worker.label}
                      </span>
                    )}
                    {!isRenaming && worker.pinned && (
                      <PushPin
                        size={11}
                        weight="fill"
                        className="shrink-0 text-zinc-500"
                        aria-label="Pinned"
                      />
                    )}
                    {!isRenaming && worker.external ? (
                      <span className="shrink-0 whitespace-nowrap rounded bg-teal-500/15 px-1 py-0.5 font-mono text-[9.5px] leading-none text-teal-300">
                        MCP
                      </span>
                    ) : !isRenaming && worker.group_template_alias ? (
                      <span
                        title={
                          worker.worktree_branch
                            ? `Group: ${worker.group_template_alias} · Worktree: ${worker.worktree_branch}`
                            : `Group: ${worker.group_template_alias}`
                        }
                        className="shrink-0 whitespace-nowrap rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[9.5px] leading-none text-zinc-400 truncate max-w-[78px]"
                      >
                        {worker.group_template_alias}
                      </span>
                    ) : !isRenaming && worker.worktree_branch ? (
                      <span
                        title={`Worktree: ${worker.worktree_branch}`}
                        className="shrink-0 whitespace-nowrap rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] leading-none text-zinc-400 truncate max-w-[76px]"
                      >
                        {worker.worktree_branch.replace(/^ufoo\//, "")}
                      </span>
                    ) : null}
                  </div>
                </div>

                {!isRenaming && (
                  <button
                    type="button"
                    aria-expanded={isMenuOpen}
                    aria-label={`Session options for ${worker.label}`}
                    title="Session options"
                    onClick={(e) =>
                      openSessionMenu(e, {
                        sessionId: worker.id,
                        label: worker.label,
                        section: "active",
                        pinned: Boolean(worker.pinned),
                        recoverable: false,
                        worktreeBranch: worker.worktree_branch || "",
                      })
                    }
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.1] hover:text-white transition-opacity cursor-pointer ${
                      isMenuOpen
                        ? "opacity-100 bg-white/[0.1] text-white"
                        : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    }`}
                  >
                    <DotsThree size={15} weight="bold" />
                  </button>
                )}
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
                {showRecov ? <CaretDown size={10} /> : <CaretRight size={10} />}
                <span>Recoverable ({project.recoverable.length})</span>
              </button>
              {showRecov && (
                <div className="space-y-0.5 pl-2 pt-0.5">
                  {project.recoverable.map((rec) => {
                    const recLabel = rec.label || rec.id;
                    const isMenuOpen = sessionMenu?.sessionId === rec.id;
                    const isRenaming = renamingId === rec.id;
                    return (
                      <div
                        key={rec.id}
                        onContextMenu={(e) =>
                          openSessionMenu(
                            e,
                            {
                              sessionId: rec.id,
                              label: recLabel,
                              section: "recoverable",
                              pinned: false,
                              recoverable: true,
                              worktreeBranch: "",
                            },
                            true
                          )
                        }
                        className="group flex items-center rounded-md text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
                      >
                        {isRenaming ? (
                          <div className="flex-1 px-2 py-1">
                            <input
                              ref={renameInputRef}
                              type="text"
                              value={renameDraft}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setRenameDraft(e.target.value)}
                              onBlur={() => void commitInlineRename(rec.id, recLabel)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void commitInlineRename(rec.id, recLabel);
                                } else if (e.key === "Escape") {
                                  e.preventDefault();
                                  setRenamingId("");
                                }
                              }}
                              aria-label="Rename session"
                              className="w-full rounded border border-blue-400/50 bg-zinc-950 px-1.5 py-0.5 text-[11.5px] text-white focus:outline-none"
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleResume(rec.id)}
                            className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-1 text-left text-[11.5px] cursor-pointer"
                          >
                            <span className="flex min-w-0 items-center gap-1.5">
                              {!rec.id.startsWith("group:") && (
                                <BrandIcon
                                  brand={rec.type || rec.id}
                                  color={ucodeColorMap[rec.id]}
                                  size={13}
                                />
                              )}
                              <span className="truncate font-mono">{recLabel}</span>
                            </span>
                            <span className="shrink-0 text-[10px] text-blue-400">Resume</span>
                          </button>
                        )}
                        {!isRenaming && (
                          <button
                            type="button"
                            aria-expanded={isMenuOpen}
                            aria-label={`Session options for ${recLabel}`}
                            title="Session options"
                            onClick={(e) =>
                              openSessionMenu(e, {
                                sessionId: rec.id,
                                label: recLabel,
                                section: "recoverable",
                                pinned: false,
                                recoverable: true,
                                worktreeBranch: "",
                              })
                            }
                            className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.1] hover:text-white cursor-pointer ${
                              isMenuOpen
                                ? "opacity-100 bg-white/[0.1] text-white"
                                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            }`}
                          >
                            <DotsThree size={15} weight="bold" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {archivedList.length > 0 && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowArchived(!showArchived)}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer"
              >
                {showArchived ? <CaretDown size={10} /> : <CaretRight size={10} />}
                <span>Archived ({archivedList.length})</span>
              </button>
              {showArchived && (
                <div className="space-y-0.5 pl-2 pt-0.5">
                  {archivedList.map((item) => {
                    const isMenuOpen = sessionMenu?.sessionId === item.id;
                    const isRenaming = renamingId === item.id;
                    return (
                      <div
                        key={item.id}
                        onContextMenu={(e) =>
                          openSessionMenu(
                            e,
                            {
                              sessionId: item.id,
                              label: item.label,
                              section: "archived",
                              pinned: false,
                              recoverable: Boolean(item.recoverable),
                              worktreeBranch: item.worktree_branch || "",
                            },
                            true
                          )
                        }
                        className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300"
                      >
                        <span className="opacity-65 shrink-0">
                          <BrandIcon brand={item.type} color={ucodeColorMap[item.id]} size={13} />
                        </span>
                        {isRenaming ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            value={renameDraft}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => void commitInlineRename(item.id, item.label)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void commitInlineRename(item.id, item.label);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenamingId("");
                              }
                            }}
                            aria-label="Rename archived session"
                            className="flex-1 min-w-0 rounded border border-blue-400/50 bg-zinc-950 px-1.5 py-0.5 text-[11.5px] text-white focus:outline-none"
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-[11.5px]">
                            {item.label}
                          </span>
                        )}
                        {!isRenaming && (
                          <button
                            type="button"
                            aria-expanded={isMenuOpen}
                            aria-label={`Archived session options for ${item.label}`}
                            title="Session options"
                            onClick={(e) =>
                              openSessionMenu(e, {
                                sessionId: item.id,
                                label: item.label,
                                section: "archived",
                                pinned: false,
                                recoverable: Boolean(item.recoverable),
                                worktreeBranch: item.worktree_branch || "",
                              })
                            }
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.1] hover:text-white cursor-pointer ${
                              isMenuOpen
                                ? "opacity-100 bg-white/[0.1] text-white"
                                : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            }`}
                          >
                            <DotsThree size={15} weight="bold" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Session Action Menu Portal */}
      {sessionMenu && createPortal(
        <div
          ref={sessionMenuRef}
          style={sessionMenuStyle}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-44 overflow-y-auto rounded-xl border border-white/[0.1] bg-zinc-900 p-1 shadow-xl"
        >
          <button
            type="button"
            onClick={() => startInlineRename(sessionMenu.sessionId, sessionMenu.label)}
            className={menuItemClassName}
          >
            <PencilSimple size={13} className="shrink-0 text-zinc-400" />
            <span>Rename</span>
          </button>

          {sessionMenu.section === "active" && (
            <button
              type="button"
              onClick={() => void handleSessionPin(sessionMenu.sessionId, !sessionMenu.pinned)}
              className={menuItemClassName}
            >
              {sessionMenu.pinned ? (
                <>
                  <PushPinSlash size={13} className="shrink-0 text-zinc-400" />
                  <span>Unpin</span>
                </>
              ) : (
                <>
                  <PushPin size={13} className="shrink-0 text-zinc-400" />
                  <span>Pin</span>
                </>
              )}
            </button>
          )}

          {sessionMenu.section === "archived" ? (
            <button
              type="button"
              onClick={() => void handleSessionUnarchive(sessionMenu.sessionId)}
              className={menuItemClassName}
            >
              <ArrowCounterClockwise size={13} className="shrink-0 text-zinc-400" />
              <span>{sessionMenu.recoverable ? "Unarchive & Resume" : "Unarchive"}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSessionArchive(sessionMenu.sessionId)}
              className={menuItemClassName}
            >
              <Archive size={13} className="shrink-0 text-zinc-400" />
              <span>Archive</span>
            </button>
          )}

          <div role="separator" className="my-1 border-t border-white/10" />

          <button
            type="button"
            onClick={() => {
              const target = {
                sessionId: sessionMenu.sessionId,
                label: sessionMenu.label,
                worktreeBranch: sessionMenu.worktreeBranch,
              };
              setSessionMenu(null);
              setDeleteTarget(target);
            }}
            className={dangerMenuItemClassName}
          >
            <Trash size={13} className="shrink-0" />
            <span>Delete</span>
          </button>
        </div>,
        document.body
      )}

      {/* Permanent Delete Confirmation Modal */}
      {deleteTarget && createPortal(
        <div
          onClick={() => {
            if (!deleting) setDeleteTarget(null);
          }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Delete session"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[380px] rounded-2xl border border-white/[0.1] bg-[#121216] p-5 shadow-2xl space-y-3"
          >
            <div className="space-y-1.5">
              <h3 className="text-[14px] font-semibold text-zinc-100">
                Delete “{deleteTarget.label}”?
              </h3>
              <p className="text-[12px] leading-relaxed text-zinc-400">
                This stops the session if running and permanently removes its registration, pin, and local state. Use <span className="text-zinc-200">Archive</span> instead if you want to keep history and restore it later.
              </p>
              {deleteTarget.worktreeBranch && (
                <p className="text-[11.5px] leading-relaxed text-zinc-500">
                  Managed worktree (<span className="font-mono text-zinc-300">{deleteTarget.worktreeBranch}</span>) will only be removed if it has no uncommitted changes.
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDeleteSession()}
                className="rounded-lg bg-rose-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-rose-500 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export function LeftSidebar({ mobileDrawer = false }: { mobileDrawer?: boolean } = {}) {
  const {
    state,
    dispatch,
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    selectController,
    notifyToast,
  } = useWorkspace();

  if (!mobileDrawer && !state.leftSidebarOpen) return null;

  const handleAddProject = async () => {
    const picked = await ufooBridge.pickProjectFolder();
    if (!picked) return;
    const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("project.add", {
      root: picked,
    });
    if (res?.ok) {
      notifyToast(`Opened project ${picked.split("/").pop()}`);
      if (mobileDrawer) dispatch({ type: "SET_MOBILE_DRAWER", open: false });
    } else if (res?.error) {
      notifyToast(res.error);
    }
  };

  const handleSelectGlobalRouter = async () => {
    await selectController();
  };

  const visibleProjects = state.projects.slice();
  visibleProjects.sort((a, b) => a.label.localeCompare(b.label) || a.root.localeCompare(b.root));

  return (
    <aside
      className={
        mobileDrawer
          ? "flex h-full w-[280px] max-w-[84vw] shrink-0 flex-col border-r border-white/[0.1] bg-zinc-950 select-none shadow-2xl safe-top safe-bottom"
          : "hidden md:flex h-full w-[264px] shrink-0 flex-col border-r border-white/[0.07] bg-zinc-950 select-none"
      }
    >
      {/* Header: Mobile Drawer Close vs macOS Traffic Lights Inset + Drag Header */}
      {mobileDrawer ? (
        <div className="flex h-[48px] shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
          <div className="flex items-center gap-2 min-w-0">
            <BrandIcon brand="ufoo" size={16} />
            <span className="text-[13px] font-semibold tracking-wider text-zinc-100">UFOO</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                dispatch({ type: "SET_MOBILE_DRAWER", open: false });
                dispatch({ type: "SET_COMMAND_PALETTE", open: true });
              }}
              title="Search & Commands"
              aria-label="Search & Commands"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <MagnifyingGlass size={16} />
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_MOBILE_DRAWER", open: false })}
              title="Close Menu"
              aria-label="Close Menu"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div
          data-tauri-drag-region
          className={`flex h-[44px] shrink-0 items-center justify-between gap-1 pr-2.5 ${
            isTauriEnvironment() ? "pl-[78px]" : "pl-2.5"
          }`}
        >
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!canGoBack}
              onClick={() => void goBack()}
              title="Back (⌘[)"
              aria-label="Go Back"
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                canGoBack
                  ? "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 cursor-pointer"
                  : "text-zinc-700 cursor-default"
              }`}
            >
              <NavBackIcon />
            </button>
            <button
              type="button"
              disabled={!canGoForward}
              onClick={() => void goForward()}
              title="Forward (⌘])"
              aria-label="Go Forward"
              className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                canGoForward
                  ? "text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 cursor-pointer"
                  : "text-zinc-700 cursor-default"
              }`}
            >
              <NavForwardIcon />
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => dispatch({ type: "SET_COMMAND_PALETTE", open: true })}
              title="Search & Commands (⌘K)"
              aria-label="Search & Commands"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <MagnifyingGlass size={16} />
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "TOGGLE_LEFT_SIDEBAR" })}
              title="Toggle Sidebar (⌘B)"
              aria-label="Toggle Sidebar"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              <LeftSidebarIcon active />
            </button>
          </div>
        </div>
      )}

      {/* Global Overview */}
      <div className="px-2.5 pt-1.5 pb-1.5">
        <button
          type="button"
          onClick={() => void handleSelectGlobalRouter()}
          className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] transition-colors cursor-pointer ${
            state.scope === "controller"
              ? "bg-white/[0.11] text-white font-semibold"
              : "text-zinc-400 hover:bg-white/[0.05] hover:text-zinc-200"
          }`}
        >
          <BrandIcon brand="ufoo" size={15} />
          <span className="tracking-wider font-semibold">UFOO</span>
        </button>
      </div>

      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] font-medium text-zinc-500">Projects</span>
        <button
          type="button"
          onClick={() => void handleAddProject()}
          title="Add Project Folder"
          aria-label="Add Project Folder"
          className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.08] hover:text-zinc-100 transition-colors cursor-pointer"
        >
          <FolderPlus size={14} />
        </button>
      </div>

      {/* Project + Worker 2-Level Tree with bottom scroll gradient mask */}
      <div className="relative flex flex-1 min-h-0 flex-col">
        <div className="flex-1 overflow-y-auto px-2 pt-1 pb-7">
          {visibleProjects.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <div className="text-[12px] text-zinc-500">No projects registered yet</div>
              <button
                type="button"
                onClick={() => void handleAddProject()}
                className="mt-2.5 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-white/[0.08] transition-colors cursor-pointer"
              >
                Open Folder…
              </button>
            </div>
          ) : (
            visibleProjects.map((project) => <ProjectGroup key={project.root} project={project} />)
          )}
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-zinc-950 via-zinc-950/80 to-transparent"
        />
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 text-[11px] text-zinc-400">
        <button
          type="button"
          onClick={() => {
            dispatch({ type: "SET_MOBILE_DRAWER", open: false });
            dispatch({ type: "SET_SETTINGS_MODAL", open: true, tab: "remote" });
          }}
          aria-label="Remote Access & Mobile Pairing"
          title="Remote Access & Mobile Pairing"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
        >
          <DeviceMobile size={15} />
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          {state.cronTasks.length > 0 && (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
              {state.cronTasks.length} cron
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "SET_MOBILE_DRAWER", open: false });
              dispatch({ type: "SET_SETTINGS_MODAL", open: true, tab: "general" });
            }}
            aria-label="Settings"
            title="Settings (⌘,)"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <GearSix size={15} />
          </button>
        </div>
      </footer>
    </aside>
  );
}
