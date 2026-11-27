import React, { useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import type { PermissionMode, WindowMode } from "../types";
import { BrandIcon, buildProjectUcodeColorMap } from "./BrandIcon";

interface PaletteAction {
  id: string;
  section: string;
  label: string;
  brand?: string;
  brandColor?: string;
  hint?: string;
  keywords: string;
  run: () => void | Promise<void>;
}

export function CommandPalette() {
  const {
    state,
    dispatch,
    selectProjectMain,
    selectWorkerView,
    setWindowMode,
    setPermissionMode,
    launchWorkerEngine,
  } = useWorkspace();
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.commandPaletteOpen) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state.commandPaletteOpen]);

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [];

    for (const proj of state.projects) {
      const projColorMap = buildProjectUcodeColorMap(proj.root, proj.workers, proj.archived || []);
      list.push({
        id: `proj:${proj.root}`,
        section: "Workspace",
        label: `${proj.label} · ufoo`,
        hint: proj.branch || proj.root,
        keywords: `project workspace ${proj.label} ${proj.branch}`,
        run: () => selectProjectMain(proj.root),
      });
      for (const worker of proj.workers) {
        list.push({
          id: `worker:${proj.root}:${worker.id}`,
          section: "Worker",
          label: `${worker.label} (${proj.label})`,
          brand: worker.type,
          brandColor: projColorMap[worker.id],
          hint: worker.worktree_branch || worker.type,
          keywords: `worker agent ${worker.label} ${worker.type} ${proj.label}`,
          run: () => selectWorkerView(proj.root, worker.id),
        });
      }
    }

    if (state.scope === "project") {
      for (const engine of state.engineCatalog) {
        if (engine.kind === "acp" && !engine.available) continue;
        list.push({
          id: `launch:${engine.agentType}`,
          section: "Launch",
          label: `New ${engine.label} worker`,
          brand: engine.agentType,
          hint: engine.kind.toUpperCase(),
          keywords: `launch new worker start ${engine.label} ${engine.agentType} ${engine.kind}`,
          run: () => launchWorkerEngine(engine.agentType, state.activeRoot),
        });
      }

      const layouts: Array<{ id: WindowMode; label: string }> = [
        { id: "main", label: "Layout: Main" },
        { id: "side", label: "Layout: Side" },
        { id: "multi", label: "Layout: Multi" },
      ];
      for (const l of layouts) {
        list.push({
          id: `layout:${l.id}`,
          section: "View",
          label: l.label,
          hint: "⌘W",
          keywords: `window layout mode ${l.id} ${l.label}`,
          run: () => setWindowMode(l.id),
        });
      }

      const perms: Array<{ id: PermissionMode; label: string }> = [
        { id: "supervised", label: "Permission: Supervised" },
        { id: "auto_edit", label: "Permission: Auto-Edit" },
        { id: "full_access", label: "Permission: Full Access" },
      ];
      for (const p of perms) {
        list.push({
          id: `perm:${p.id}`,
          section: "Safety",
          label: p.label,
          keywords: `permission safety approval ${p.id} ${p.label}`,
          run: () => setPermissionMode(p.id),
        });
      }
    }

    list.push({
      id: "action:onboarding",
      section: "Action",
      label: "Run Setup & Auth Wizard",
      hint: "Engines · CLI · MCP",
      keywords: "onboarding setup wizard auth login welcome",
      run: () => dispatch({ type: "SET_ONBOARDING_OPEN", open: true }),
    });

    list.push({
      id: "action:settings",
      section: "Action",
      label: "Open Settings",
      hint: "⌘,",
      keywords: "settings config worktree model acp",
      run: () => dispatch({ type: "SET_SETTINGS_MODAL", open: true }),
    });

    return list;
  }, [
    state.projects,
    state.scope,
    state.activeRoot,
    state.engineCatalog,
    selectProjectMain,
    selectWorkerView,
    launchWorkerEngine,
    setWindowMode,
    setPermissionMode,
    dispatch,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.section.toLowerCase().includes(q) ||
        a.keywords.toLowerCase().includes(q)
    );
  }, [actions, query]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  if (!state.commandPaletteOpen) return null;

  const execute = (action?: PaletteAction) => {
    if (!action) return;
    dispatch({ type: "SET_COMMAND_PALETTE", open: false });
    void action.run();
  };

  return (
    <div
      onClick={() => dispatch({ type: "SET_COMMAND_PALETTE", open: false })}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[14vh] p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/[0.12] bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-3.5 py-2.5">
          <MagnifyingGlass size={14} className="text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                dispatch({ type: "SET_COMMAND_PALETTE", open: false });
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                execute(filtered[selectedIdx]);
              }
            }}
            placeholder="Jump to workspace, launch worker, switch layout…"
            className="flex-1 bg-transparent text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          <kbd className="rounded border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
            ⌘K
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-zinc-500">
              No matching commands
            </div>
          ) : (
            filtered.map((item, idx) => {
              const active = idx === selectedIdx;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setSelectedIdx(idx)}
                  onClick={() => execute(item)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[12.5px] transition-colors cursor-pointer ${
                    active ? "bg-white/[0.1] text-white" : "text-zinc-300 hover:bg-white/[0.05]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {item.brand && <BrandIcon brand={item.brand} color={item.brandColor} size={14} />}
                    <span className="truncate font-medium">{item.label}</span>
                    <span className="text-[10.5px] text-zinc-500 shrink-0">{item.section}</span>
                  </div>
                  {item.hint && (
                    <span className="font-mono text-[10.5px] text-zinc-500 truncate max-w-[150px]">
                      {item.hint}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
