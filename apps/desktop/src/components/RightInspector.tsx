import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  BookOpenText,
  Brain,
  CheckCircle,
  FileCode,
  FileText,
  GitDiff,
  Plus,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import type { RightInspectorTab } from "../types";
import { MarkdownBlock } from "./MarkdownBlock";

function UnifiedDiffViewer({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return (
      <div className="p-6 text-center text-[12px] text-zinc-500">
        Working tree is clean or select a modified file above.
      </div>
    );
  }
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.55] selectable-text">
      {lines.map((line, idx) => {
        let cls = "text-zinc-300";
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
          cls = "bg-white/[0.03] text-zinc-400 font-medium";
        } else if (line.startsWith("@@")) {
          cls = "bg-blue-500/10 text-blue-300";
        } else if (line.startsWith("+")) {
          cls = "bg-emerald-500/12 text-emerald-300";
        } else if (line.startsWith("-")) {
          cls = "bg-rose-500/12 text-rose-300";
        }
        return (
          <div key={idx} className={`px-3 py-0.2 whitespace-pre ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function ChangesPane() {
  const { state, openDocInInspector } = useWorkspace();
  const snap = state.changesSnapshot;

  const refresh = async (filePath?: string, worktreeRoot?: string) => {
    await ufooBridge.sendCommand("workspace.changes", {
      ...(filePath !== undefined ? { filePath } : {}),
      ...(worktreeRoot ? { worktreeRoot } : {}),
    });
  };

  useEffect(() => {
    if (state.scope === "project" && !snap) {
      void refresh();
    }
  }, [state.activeRoot, state.scope]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2 text-[11.5px]">
        <div className="flex items-center gap-2 min-w-0">
          {snap && snap.worktrees.length > 1 ? (
            <select
              value={snap.worktreeRoot}
              onChange={(e) => void refresh("", e.target.value)}
              className="rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200 focus:outline-none"
            >
              {snap.worktrees.map((wt) => (
                <option key={wt.path} value={wt.path}>
                  {wt.branch || wt.path.split("/").pop()}
                </option>
              ))}
            </select>
          ) : (
            <span className="font-mono text-zinc-400 truncate">
              {snap?.branch ? `branch: ${snap.branch}` : "Working tree"}
            </span>
          )}

          {snap && (snap.totals.additions > 0 || snap.totals.deletions > 0) && (
            <span className="font-mono text-[11px]">
              <span className="text-emerald-400">+{snap.totals.additions}</span>{" "}
              <span className="text-rose-400">-{snap.totals.deletions}</span>
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => void refresh(snap?.selectedFile, snap?.worktreeRoot)}
          title="Refresh Git status"
          className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 cursor-pointer"
        >
          <ArrowsClockwise size={13} />
        </button>
      </div>

      {/* Changed Files List */}
      <div className="max-h-44 shrink-0 overflow-y-auto border-b border-white/[0.06]">
        {!snap || snap.files.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-zinc-500">
            No uncommitted changes
          </div>
        ) : (
          snap.files.map((file) => {
            const active = snap.selectedFile === file.path;
            return (
              <div
                key={file.path}
                onClick={() => void refresh(file.path, snap.worktreeRoot)}
                className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] cursor-pointer transition-colors ${
                  active
                    ? "bg-blue-500/18 text-white"
                    : "text-zinc-300 hover:bg-white/[0.04]"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-4 text-center font-mono text-[10.5px] font-semibold ${
                      file.kind === "added" || file.kind === "untracked"
                        ? "text-emerald-400"
                        : file.kind === "deleted"
                        ? "text-rose-400"
                        : "text-amber-400"
                    }`}
                  >
                    {file.code}
                  </span>
                  <span className="truncate font-mono text-[11.5px]">{file.path}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-[10.5px]">
                  {file.additions > 0 && <span className="text-emerald-400">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-rose-400">-{file.deletions}</span>}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void openDocInInspector(file.path);
                    }}
                    title="Open file in Docs"
                    className="text-zinc-500 hover:text-zinc-200 cursor-pointer"
                  >
                    <FileCode size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Unified Diff Body */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-[#0a0a0c]">
        <UnifiedDiffViewer diff={snap?.diff || ""} />
      </div>

      {/* Recent Worker Reports Summary */}
      {snap && snap.reports.length > 0 && (
        <div className="max-h-40 shrink-0 overflow-y-auto border-t border-white/[0.07] bg-zinc-950/80 p-2.5 space-y-1.5">
          <div className="text-[10.5px] font-semibold text-zinc-400 px-1">
            Recent Worker Reports ({snap.reports.length})
          </div>
          {snap.reports.slice(0, 6).map((rep) => (
            <div
              key={rep.entry_id}
              className="rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5 text-[11.5px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-medium text-zinc-200">{rep.agent_id}</span>
                <span
                  className={`rounded px-1.5 py-0.2 font-mono text-[10px] ${
                    rep.phase === "done"
                      ? "bg-emerald-500/15 text-emerald-300"
                      : rep.phase === "error"
                      ? "bg-rose-500/15 text-rose-300"
                      : "bg-blue-500/15 text-blue-300"
                  }`}
                >
                  {rep.phase}
                </span>
              </div>
              <div className="mt-0.5 text-zinc-400 line-clamp-2 selectable-text">
                {rep.summary || rep.message || rep.error}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DocsPane() {
  const { state } = useWorkspace();
  const snap = state.docsSnapshot;
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLDivElement>(null);

  const loadDoc = async (filePath?: string, q = query) => {
    await ufooBridge.sendCommand("workspace.docs", {
      ...(filePath ? { filePath } : {}),
      ...(q ? { query: q } : {}),
    });
  };

  useEffect(() => {
    if (state.scope === "project" && !snap) {
      void loadDoc();
    }
  }, [state.activeRoot, state.scope]);

  useEffect(() => {
    if (snap?.document?.anchorLine) {
      anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [snap?.document?.path, snap?.document?.anchorLine]);

  const doc = snap?.document;
  const isMarkdown = doc?.language === "markdown";

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="border-b border-white/[0.06] p-2.5 space-y-2">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            void loadDoc(snap?.selectedPath, e.target.value);
          }}
          placeholder="Search docs & workspace files…"
          className="w-full rounded-lg border border-white/[0.07] bg-zinc-900 px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-500 focus:border-blue-500/40 focus:outline-none"
        />

        {snap && snap.files.length > 0 && (
          <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
            {snap.files.slice(0, 18).map((f) => {
              const selected = snap.selectedPath === f.path;
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => void loadDoc(f.path)}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px] transition-colors cursor-pointer ${
                    selected
                      ? "bg-blue-500/20 text-blue-200 border border-blue-400/30"
                      : "bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 border border-transparent"
                  }`}
                >
                  <FileText size={11} />
                  <span className="truncate max-w-[160px]">{f.path}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3.5 bg-[#0a0a0c]">
        {!doc ? (
          <div className="py-10 text-center text-[12px] text-zinc-500">
            Select a document or click any file reference in chat.
          </div>
        ) : doc.error ? (
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-[12px] text-rose-300">
            {doc.error}
          </div>
        ) : isMarkdown ? (
          <div className="space-y-1">
            <div className="mb-2 pb-1.5 border-b border-white/[0.06] font-mono text-[11px] text-zinc-500">
              {doc.path}
            </div>
            <MarkdownBlock text={doc.content || ""} onOpenFile={(p) => void loadDoc(p)} />
          </div>
        ) : (
          <div>
            <div className="mb-2 pb-1.5 border-b border-white/[0.06] flex items-center justify-between font-mono text-[11px] text-zinc-500">
              <span>{doc.path}</span>
              <span>{doc.totalLines} lines</span>
            </div>
            <div className="font-mono text-[11.5px] leading-[1.55] selectable-text">
              {(doc.content || "").split("\n").map((line, i) => {
                const lineNum = (doc.startLine || 1) + i;
                const isAnchor = doc.anchorLine === lineNum;
                return (
                  <div
                    key={lineNum}
                    ref={isAnchor ? anchorRef : undefined}
                    className={`flex gap-3 px-1.5 rounded ${
                      isAnchor ? "bg-blue-500/20 text-white" : "text-zinc-300"
                    }`}
                  >
                    <span className="w-8 shrink-0 select-none text-right text-zinc-600">
                      {lineNum}
                    </span>
                    <span className="whitespace-pre overflow-x-auto">{line || " "}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ContextPane() {
  const { state, notifyToast } = useWorkspace();
  const snap = state.contextSnapshot;
  const [section, setSection] = useState<"decisions" | "memory">("decisions");
  const [creatingDecision, setCreatingDecision] = useState(false);
  const [decTitle, setDecTitle] = useState("");
  const [decBody, setDecBody] = useState("");
  const [creatingMem, setCreatingMem] = useState(false);
  const [memTitle, setMemTitle] = useState("");
  const [memBody, setMemBody] = useState("");
  const [memTags, setMemTags] = useState("");
  const [expandedFile, setExpandedFile] = useState("");

  const refreshContext = async () => {
    await ufooBridge.sendCommand("workspace.context", { operation: "snapshot" });
  };

  useEffect(() => {
    if (state.scope === "project" && !snap) {
      void refreshContext();
    }
  }, [state.activeRoot, state.scope]);

  const handleCreateDecision = async () => {
    if (!decTitle.trim()) return;
    await ufooBridge.sendCommand("workspace.context", {
      operation: "decision.create",
      title: decTitle.trim(),
      decision: decBody.trim() || decTitle.trim(),
    });
    setDecTitle("");
    setDecBody("");
    setCreatingDecision(false);
    notifyToast("Recorded architectural decision");
  };

  const handleToggleDecisionStatus = async (file: string, current: string) => {
    const next = current === "open" ? "resolved" : "open";
    await ufooBridge.sendCommand("workspace.context", {
      operation: "decision.set_status",
      file,
      status: next,
    });
  };

  const handleCreateMemory = async () => {
    if (!memTitle.trim() || !memBody.trim()) return;
    await ufooBridge.sendCommand("workspace.context", {
      operation: "memory.add",
      title: memTitle.trim(),
      body: memBody.trim(),
      tags: memTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    setMemTitle("");
    setMemBody("");
    setMemTags("");
    setCreatingMem(false);
    notifyToast("Saved durable project memory");
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
        <div className="inline-flex rounded-lg border border-white/[0.07] bg-zinc-900 p-0.5 text-[11.5px]">
          <button
            type="button"
            onClick={() => setSection("decisions")}
            className={`rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
              section === "decisions" ? "bg-white/[0.12] text-white font-medium" : "text-zinc-400"
            }`}
          >
            Decisions ({snap?.openDecisionCount ?? 0} open)
          </button>
          <button
            type="button"
            onClick={() => setSection("memory")}
            className={`rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
              section === "memory" ? "bg-white/[0.12] text-white font-medium" : "text-zinc-400"
            }`}
          >
            Memory ({snap?.memories.length ?? 0})
          </button>
        </div>

        <button
          type="button"
          onClick={() =>
            section === "decisions"
              ? setCreatingDecision(!creatingDecision)
              : setCreatingMem(!creatingMem)
          }
          className="inline-flex items-center gap-1 rounded-lg bg-blue-600/20 border border-blue-400/30 px-2 py-1 text-[11px] font-medium text-blue-300 hover:bg-blue-600/30 cursor-pointer"
        >
          <Plus size={11} weight="bold" />
          <span>New</span>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
        {section === "decisions" ? (
          <>
            {creatingDecision && (
              <div className="rounded-xl border border-white/[0.1] bg-zinc-900/90 p-3 space-y-2">
                <input
                  type="text"
                  value={decTitle}
                  onChange={(e) => setDecTitle(e.target.value)}
                  placeholder="Decision title…"
                  className="w-full rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-1.5 text-[12px] text-zinc-100 focus:outline-none"
                />
                <textarea
                  rows={3}
                  value={decBody}
                  onChange={(e) => setDecBody(e.target.value)}
                  placeholder="Decision rationale & implications…"
                  className="w-full resize-none rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-1.5 text-[12px] text-zinc-100 focus:outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreatingDecision(false)}
                    className="rounded-lg px-2.5 py-1 text-[11.5px] text-zinc-400 hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateDecision()}
                    className="rounded-lg bg-blue-600 px-3 py-1 text-[11.5px] font-medium text-white hover:bg-blue-500 cursor-pointer"
                  >
                    Save Decision
                  </button>
                </div>
              </div>
            )}

            {!snap || snap.decisions.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-zinc-500">
                No architectural decisions in `.ufoo/context/decisions/`
              </div>
            ) : (
              snap.decisions.map((dec) => {
                const isOpen = expandedFile === dec.file;
                return (
                  <div
                    key={dec.file}
                    className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3"
                  >
                    <div
                      onClick={() => setExpandedFile(isOpen ? "" : dec.file)}
                      className="flex items-start justify-between gap-2 cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-zinc-100 leading-snug">
                          {dec.title}
                        </div>
                        <div className="mt-1 font-mono text-[10.5px] text-zinc-500 truncate">
                          {dec.file}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleToggleDecisionStatus(dec.file, dec.status);
                        }}
                        className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] cursor-pointer ${
                          dec.status === "open"
                            ? "bg-amber-500/15 text-amber-300 border border-amber-400/25"
                            : "bg-emerald-500/15 text-emerald-300 border border-emerald-400/25"
                        }`}
                      >
                        <CheckCircle size={10} />
                        <span>{dec.status}</span>
                      </button>
                    </div>
                    {isOpen && (
                      <div className="mt-2.5 border-t border-white/[0.06] pt-2.5">
                        <MarkdownBlock text={dec.body} />
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </>
        ) : (
          <>
            {creatingMem && (
              <div className="rounded-xl border border-white/[0.1] bg-zinc-900/90 p-3 space-y-2">
                <input
                  type="text"
                  value={memTitle}
                  onChange={(e) => setMemTitle(e.target.value)}
                  placeholder="Memory title…"
                  className="w-full rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-1.5 text-[12px] text-zinc-100 focus:outline-none"
                />
                <textarea
                  rows={3}
                  value={memBody}
                  onChange={(e) => setMemBody(e.target.value)}
                  placeholder="Durable workspace fact…"
                  className="w-full resize-none rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-1.5 text-[12px] text-zinc-100 focus:outline-none"
                />
                <input
                  type="text"
                  value={memTags}
                  onChange={(e) => setMemTags(e.target.value)}
                  placeholder="Tags (comma-separated, e.g. runtime, auth)"
                  className="w-full rounded-lg border border-white/[0.08] bg-zinc-950 px-2.5 py-1.5 text-[12px] text-zinc-100 focus:outline-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCreatingMem(false)}
                    className="rounded-lg px-2.5 py-1 text-[11.5px] text-zinc-400 hover:text-white cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateMemory()}
                    className="rounded-lg bg-blue-600 px-3 py-1 text-[11.5px] font-medium text-white hover:bg-blue-500 cursor-pointer"
                  >
                    Save Memory
                  </button>
                </div>
              </div>
            )}

            {!snap || snap.memories.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-zinc-500">
                No durable entries in `.ufoo/memory/`
              </div>
            ) : (
              snap.memories.map((mem) => (
                <div
                  key={mem.id}
                  className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-zinc-100">{mem.title}</span>
                    <span className="font-mono text-[10px] text-zinc-500">{mem.id}</span>
                  </div>
                  <div className="text-[12px] leading-relaxed text-zinc-300 selectable-text whitespace-pre-wrap">
                    {mem.body}
                  </div>
                  {mem.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {mem.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}

const DEFAULT_INSPECTOR_WIDTH = 370;
const MIN_INSPECTOR_WIDTH = 260;
const MIN_CHAT_WIDTH = 360;

export function RightInspector() {
  const { state, dispatch } = useWorkspace();
  const visible = state.rightInspectorOpen && state.scope === "project";
  const inspector = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_INSPECTOR_WIDTH + MIN_CHAT_WIDTH);
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [resizing, setResizing] = useState(false);

  useLayoutEffect(() => {
    const container = inspector.current?.parentElement;
    if (!visible || !container) {
      setResizing(false);
      return;
    }
    const measure = () => setPanelWidth(container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      observer.disconnect();
      drag.current = null;
    };
  }, [visible]);

  if (!visible) return null;

  const maxWidth = Math.max(0, panelWidth - MIN_CHAT_WIDTH);
  const minWidth = Math.min(MIN_INSPECTOR_WIDTH, maxWidth);
  const clampWidth = (value: number) => Math.max(minWidth, Math.min(value, maxWidth));
  const width = clampWidth(preferredWidth);

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    setResizing(true);
  };

  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setPreferredWidth(clampWidth(gesture.startWidth + gesture.startX - event.clientX));
  };

  const finishResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
  };

  const resizeWithKeys = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const widths: Record<string, number> = {
      ArrowLeft: width + 16,
      ArrowRight: width - 16,
      Home: minWidth,
      End: maxWidth,
    };
    if (!Object.hasOwn(widths, event.key)) return;
    event.preventDefault();
    setPreferredWidth(clampWidth(widths[event.key]));
  };

  const changedCount = state.changesSnapshot?.files.length || 0;
  const openDecisionCount = state.contextSnapshot?.openDecisionCount || 0;

  const tabs: Array<{
    id: RightInspectorTab;
    label: string;
    badge?: number;
    icon: typeof GitDiff;
  }> = [
    { id: "changes", label: "Changes", badge: changedCount, icon: GitDiff },
    { id: "docs", label: "Docs", icon: BookOpenText },
    { id: "context", label: "Context", badge: openDecisionCount, icon: Brain },
  ];

  return (
    <aside
      id="workspace-inspector"
      ref={inspector}
      style={{ width }}
      className="relative flex h-full min-w-0 shrink-0 flex-col bg-[#111114] select-none"
    >
      <div
        role="separator"
        aria-label="Resize workspace inspector"
        aria-orientation="vertical"
        aria-controls="workspace-inspector"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onKeyDown={resizeWithKeys}
        data-resizing={resizing || undefined}
        className="group absolute -left-1.5 top-2 bottom-2 z-10 w-3 cursor-col-resize touch-none outline-none focus-visible:ring-1 focus-visible:ring-white/20"
      >
        <div className="pointer-events-none absolute left-1/2 top-1 h-5 w-px rounded-full bg-white/10 group-data-[resizing=true]:bg-blue-400/60" />
        <div className="pointer-events-none absolute left-1/2 top-11 bottom-0 w-px rounded-full bg-white/[0.07] group-data-[resizing=true]:bg-blue-400/60" />
      </div>
      {/* Top Drag Bar + Segmented Tabs */}
      <div
        data-tauri-drag-region
        className="flex h-[44px] shrink-0 items-center justify-between border-b border-white/[0.06] px-3"
      >
        <div className="flex items-center gap-1 w-full">
          {tabs.map(({ id, label, badge, icon: Icon }) => {
            const active = state.rightTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => dispatch({ type: "SET_RIGHT_TAB", tab: id })}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] font-medium transition-all cursor-pointer ${
                  active
                    ? "bg-white/[0.1] text-white shadow-sm"
                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                }`}
              >
                <Icon size={13} weight={active ? "fill" : "regular"} />
                <span>{label}</span>
                {typeof badge === "number" && badge > 0 && (
                  <span className="rounded-full bg-blue-500/20 px-1.5 py-0.2 font-mono text-[10px] text-blue-300">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {state.rightTab === "changes" && <ChangesPane />}
      {state.rightTab === "docs" && <DocsPane />}
      {state.rightTab === "context" && <ContextPane />}
    </aside>
  );
}
