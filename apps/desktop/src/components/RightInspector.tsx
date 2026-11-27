import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsClockwise,
  Columns,
  DotsThree,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  Minus,
  Plus,
  Rows,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import { ufooBridge } from "../bridge/ufooClient";
import type { DiffViewMode, DocFileItem, RightInspectorTab } from "../types";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";
import { MarkdownBlock } from "./MarkdownBlock";
import { RightSidebarIcon } from "./WindowChromeIcons";

function splitFilePath(relPath: string): { name: string; dir: string } {
  const clean = String(relPath || "").replace(/\\/g, "/");
  const idx = clean.lastIndexOf("/");
  if (idx === -1) return { name: clean, dir: "" };
  return { name: clean.slice(idx + 1), dir: clean.slice(0, idx) };
}

interface ParsedDiffRow {
  kind: "hunk" | "context" | "add" | "del" | "notice";
  oldLine?: number;
  newLine?: number;
  text: string;
}

function parseUnifiedDiff(diff: string): ParsedDiffRow[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const rows: ParsedDiffRow[] = [];
  let oldNum = 0;
  let newNum = 0;
  let sawHunk = false;

  for (const line of lines) {
    // Hide git plumbing metadata headers for a clean Cursor-style diff view
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename from") ||
      line.startsWith("rename to")
    ) {
      continue;
    }
    if (line.startsWith("@@")) {
      sawHunk = true;
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) {
        oldNum = Number.parseInt(m[1], 10);
        newNum = Number.parseInt(m[2], 10);
        const contextLabel = (m[3] || "").trim();
        rows.push({
          kind: "hunk",
          text: contextLabel ? `Line ${newNum} · ${contextLabel}` : `Line ${newNum}`,
        });
      } else {
        rows.push({ kind: "hunk", text: line });
      }
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }
    if (!sawHunk) {
      if (line.trim()) rows.push({ kind: "notice", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newLine: newNum++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", oldLine: oldNum++, text: line.slice(1) });
    } else {
      rows.push({
        kind: "context",
        oldLine: oldNum > 0 ? oldNum++ : undefined,
        newLine: newNum > 0 ? newNum++ : undefined,
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
    }
  }
  return rows;
}

function buildSplitRows(rows: ParsedDiffRow[]) {
  const out: Array<{
    type: "banner" | "pair";
    text?: string;
    left?: { line?: number; kind: "context" | "del" | "empty"; text: string };
    right?: { line?: number; kind: "context" | "add" | "empty"; text: string };
  }> = [];

  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "hunk" || r.kind === "notice") {
      out.push({ type: "banner", text: r.text });
      i += 1;
      continue;
    }
    if (r.kind === "context") {
      out.push({
        type: "pair",
        left: { line: r.oldLine, kind: "context", text: r.text },
        right: { line: r.newLine, kind: "context", text: r.text },
      });
      i += 1;
      continue;
    }
    const start = i;
    const dels: ParsedDiffRow[] = [];
    const adds: ParsedDiffRow[] = [];
    while (i < rows.length && rows[i].kind === "del") {
      dels.push(rows[i]);
      i += 1;
    }
    while (i < rows.length && rows[i].kind === "add") {
      adds.push(rows[i]);
      i += 1;
    }
    if (i === start) {
      i += 1;
      continue;
    }
    const maxLen = Math.max(dels.length, adds.length);
    for (let k = 0; k < maxLen; k += 1) {
      out.push({
        type: "pair",
        left: dels[k]
          ? { line: dels[k].oldLine, kind: "del", text: dels[k].text }
          : { kind: "empty", text: "" },
        right: adds[k]
          ? { line: adds[k].newLine, kind: "add", text: adds[k].text }
          : { kind: "empty", text: "" },
      });
    }
  }
  return out;
}

function DiffViewer({ diff, mode }: { diff: string; mode: DiffViewMode }) {
  const parsed = useMemo(() => (diff.trim() ? parseUnifiedDiff(diff) : []), [diff]);
  const splitRows = useMemo(() => (mode === "split" ? buildSplitRows(parsed) : []), [parsed, mode]);

  if (!diff.trim() || parsed.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-zinc-500">
        Select a changed file above to review its diff.
      </div>
    );
  }

  if (mode === "split") {
    return (
      <div className="overflow-x-auto py-1 font-mono text-[11px] leading-[1.6] selectable-text">
        {splitRows.map((row, idx) => {
          if (row.type === "banner") {
            return (
              <div
                key={idx}
                className="my-1 border-y border-white/[0.05] bg-white/[0.025] px-3 py-0.5 text-[10.5px] text-zinc-500"
              >
                {row.text}
              </div>
            );
          }
          return (
            <div key={idx} className="grid grid-cols-2 divide-x divide-white/[0.05]">
              <div
                className={`flex min-w-0 px-2 whitespace-pre overflow-hidden ${
                  row.left?.kind === "del"
                    ? "bg-rose-500/[0.11] text-rose-200/95"
                    : row.left?.kind === "empty"
                    ? "bg-white/[0.012] text-zinc-700"
                    : "text-zinc-300"
                }`}
              >
                <span className="w-7 shrink-0 select-none text-right pr-2 text-[10px] text-zinc-600">
                  {row.left?.line ?? ""}
                </span>
                <span className="truncate">{row.left?.text || " "}</span>
              </div>
              <div
                className={`flex min-w-0 px-2 whitespace-pre overflow-hidden ${
                  row.right?.kind === "add"
                    ? "bg-emerald-500/[0.11] text-emerald-200/95"
                    : row.right?.kind === "empty"
                    ? "bg-white/[0.012] text-zinc-700"
                    : "text-zinc-300"
                }`}
              >
                <span className="w-7 shrink-0 select-none text-right pr-2 text-[10px] text-zinc-600">
                  {row.right?.line ?? ""}
                </span>
                <span className="truncate">{row.right?.text || " "}</span>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto py-1 font-mono text-[11.5px] leading-[1.62] selectable-text">
      {parsed.map((row, idx) => {
        if (row.kind === "hunk" || row.kind === "notice") {
          return (
            <div
              key={idx}
              className="my-1 border-y border-white/[0.05] bg-white/[0.025] px-3 py-0.5 text-[10.5px] text-zinc-500"
            >
              {row.text}
            </div>
          );
        }
        const cls =
          row.kind === "add"
            ? "bg-emerald-500/[0.1] text-emerald-200/95"
            : row.kind === "del"
            ? "bg-rose-500/[0.1] text-rose-200/95"
            : "text-zinc-300/90";
        const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
        const markerCls =
          row.kind === "add"
            ? "text-emerald-400/80"
            : row.kind === "del"
            ? "text-rose-400/80"
            : "text-transparent";
        return (
          <div key={idx} className={`flex px-2 whitespace-pre ${cls}`}>
            <span className="w-8 shrink-0 select-none text-right pr-2 text-[10px] text-zinc-600">
              {row.newLine ?? row.oldLine ?? ""}
            </span>
            <span className={`w-3.5 shrink-0 select-none ${markerCls}`}>{marker}</span>
            <span>{row.text || " "}</span>
          </div>
        );
      })}
    </div>
  );
}

function ChangesPane() {
  const { state, dispatch, openDocInInspector, notifyToast } = useWorkspace();
  const snap = state.changesSnapshot;
  const [commitMsg, setCommitMsg] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState("");
  const [confirmRemoveWorktree, setConfirmRemoveWorktree] = useState<"" | "confirm" | "force">("");

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

  const activeWorktree = snap?.worktrees.find((wt) => wt.path === snap.worktreeRoot);
  const isIsolatedWorktree = Boolean(activeWorktree && !activeWorktree.isMain);
  const selectedEntry = snap?.files.find((f) => f.path === snap.selectedFile) || null;
  const hasChanges = Boolean(snap && snap.files.length > 0);

  useEffect(() => {
    setConfirmRemoveWorktree("");
  }, [activeWorktree?.path]);

  const runGitAction = async (cmd: string, payload: Record<string, any>, successMsg: string) => {
    setGitBusy(true);
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string; url?: string; sha?: string }>(cmd, {
        worktreeRoot: snap?.worktreeRoot || "",
        ...payload,
      });
      if (!res?.ok) {
        notifyToast(res?.error || `${cmd} failed`);
        return res;
      }
      if (res.url) notifyToast(`PR created: ${res.url}`);
      else if (res.sha) notifyToast(`${successMsg} (${res.sha})`);
      else notifyToast(successMsg);
      return res;
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setGitBusy(false);
    }
  };

  const handleSuggestCommit = async () => {
    const res = await ufooBridge.sendCommand<{ ok: boolean; message?: string }>("workspace.git.suggest_commit", {
      worktreeRoot: snap?.worktreeRoot || "",
    });
    if (res?.ok && res.message) {
      setCommitMsg(res.message);
    } else {
      notifyToast("No changes to summarize");
    }
  };

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    const res = await runGitAction("workspace.git.commit", { message: commitMsg.trim() }, "Committed");
    if (res?.ok) setCommitMsg("");
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Calm Single Summary Bar */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3 text-[11.5px]">
        <div className="flex items-center gap-2 min-w-0">
          {snap && snap.worktrees.length > 1 ? (
            <select
              value={snap.worktreeRoot}
              onChange={(e) => void refresh("", e.target.value)}
              className="rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-200 focus:outline-none max-w-[155px]"
            >
              {snap.worktrees.map((wt) => (
                <option key={wt.path} value={wt.path}>
                  {wt.isMain ? "main · " : "wt · "}
                  {wt.branch || wt.path.split("/").pop()}
                </option>
              ))}
            </select>
          ) : (
            <span className="font-mono text-[11px] text-zinc-400 truncate">
              {snap?.branch || "Working tree"}
            </span>
          )}

          {hasChanges && snap && (
            <span className="shrink-0 font-mono text-[10.5px] text-zinc-500">
              {snap.files.length} {snap.files.length === 1 ? "file" : "files"}
              {(snap.totals.additions > 0 || snap.totals.deletions > 0) && (
                <>
                  {" · "}
                  <span className="text-emerald-400">+{snap.totals.additions}</span>{" "}
                  <span className="text-rose-400">-{snap.totals.deletions}</span>
                </>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {hasChanges && (
            <button
              type="button"
              onClick={() =>
                dispatch({
                  type: "SET_DIFF_VIEW_MODE",
                  mode: state.diffViewMode === "unified" ? "split" : "unified",
                })
              }
              title={state.diffViewMode === "unified" ? "Switch to Split Diff" : "Switch to Unified Diff"}
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
            >
              {state.diffViewMode === "unified" ? <Columns size={13} /> : <Rows size={13} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh(snap?.selectedFile, snap?.worktreeRoot)}
            title="Refresh"
            className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <ArrowsClockwise size={13} />
          </button>
        </div>
      </div>

      {/* Contextual Isolated Worktree Strip */}
      {isIsolatedWorktree && activeWorktree && (
        <div className="flex items-center justify-between gap-2 border-b border-blue-500/20 bg-blue-500/[0.05] px-3 py-1.5 text-[11px]">
          <span className="truncate font-mono text-blue-300">
            {activeWorktree.branch}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              disabled={gitBusy}
              onClick={() =>
                void runGitAction(
                  "workspace.worktree.merge",
                  { branch: activeWorktree.branch, worktreePath: activeWorktree.path, removeAfter: true },
                  `Merged ${activeWorktree.branch}`
                )
              }
              className="rounded-md bg-blue-600/85 px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-40 cursor-pointer"
            >
              Merge
            </button>
            {confirmRemoveWorktree ? (
              <>
                <button
                  type="button"
                  disabled={gitBusy}
                  onClick={async () => {
                    const useForce = confirmRemoveWorktree === "force";
                    const res = await runGitAction(
                      "workspace.worktree.remove",
                      { worktreePath: activeWorktree.path, branch: activeWorktree.branch, force: useForce },
                      "Worktree removed"
                    );
                    if (res?.ok) {
                      setConfirmRemoveWorktree("");
                    } else if ((res as { dirty?: boolean } | null)?.dirty && !useForce) {
                      setConfirmRemoveWorktree("force");
                    } else {
                      setConfirmRemoveWorktree("");
                    }
                  }}
                  title={
                    confirmRemoveWorktree === "force"
                      ? "Discard uncommitted changes and remove worktree"
                      : "Confirm removing clean worktree"
                  }
                  className="rounded-md bg-rose-600/85 px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-rose-500 disabled:opacity-40 cursor-pointer"
                >
                  {confirmRemoveWorktree === "force" ? "Force delete" : "Remove"}
                </button>
                <button
                  type="button"
                  disabled={gitBusy}
                  onClick={() => setConfirmRemoveWorktree("")}
                  className="rounded-md px-1.5 py-0.5 text-[10.5px] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 cursor-pointer"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={gitBusy}
                onClick={() => setConfirmRemoveWorktree(hasChanges ? "force" : "confirm")}
                title={hasChanges ? "Remove worktree (has uncommitted changes)" : "Remove worktree"}
                className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-400 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-40 cursor-pointer"
              >
                <Trash size={11} />
              </button>
            )}
          </div>
        </div>
      )}

      {!hasChanges ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="text-[12.5px] font-medium text-zinc-300">Working tree clean</div>
          <div className="mt-1 text-[11.5px] text-zinc-500">
            File edits from ufoo or workers will appear here for review.
          </div>
          {snap?.isGitRepo && (
            <div className="mt-4 flex items-center gap-3 text-[11.5px]">
              <button
                type="button"
                disabled={gitBusy}
                onClick={() => void runGitAction("workspace.git.push", {}, "Pushed branch")}
                className="text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer"
              >
                Push branch
              </button>
              <span className="text-zinc-700">·</span>
              <button
                type="button"
                disabled={gitBusy}
                onClick={() => void runGitAction("workspace.git.create_pr", {}, "PR created")}
                className="text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer"
              >
                Create PR
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Clean Cursor-style Changed File List */}
          <div className="max-h-48 shrink-0 overflow-y-auto border-b border-white/[0.06] py-1">
            {snap!.files.map((file) => {
              const active = snap!.selectedFile === file.path;
              const awaitingDiscard = confirmDiscard === file.path;
              const { name, dir } = splitFilePath(file.path);
              return (
                <div
                  key={file.path}
                  onClick={() => void refresh(file.path, snap!.worktreeRoot)}
                  onDoubleClick={() => void openDocInInspector(file.path)}
                  className={`group flex items-center justify-between gap-2 px-3 py-1.5 text-[12px] cursor-pointer transition-colors ${
                    active ? "bg-white/[0.08] text-white" : "text-zinc-300 hover:bg-white/[0.04]"
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${
                        file.kind === "added" || file.kind === "untracked"
                          ? "text-emerald-400"
                          : file.kind === "deleted"
                          ? "text-rose-400"
                          : "text-amber-400"
                      }`}
                    >
                      {file.code}
                    </span>
                    <div className="flex items-baseline gap-1.5 min-w-0">
                      <span className="truncate font-medium text-[12px]">{name}</span>
                      {dir && (
                        <span className="truncate text-[10.5px] text-zinc-500">{dir}</span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 font-mono text-[10.5px]">
                    {file.staged && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/90" title="Staged" />
                    )}
                    <div className="flex items-center gap-1 group-hover:hidden">
                      {file.additions > 0 && <span className="text-emerald-400">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="text-rose-400">-{file.deletions}</span>}
                    </div>
                    <div className="hidden group-hover:flex items-center gap-0.5">
                      {file.staged ? (
                        <button
                          type="button"
                          disabled={gitBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void runGitAction("workspace.git.unstage", { filePath: file.path }, `Unstaged ${name}`);
                          }}
                          title="Unstage"
                          className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.1] hover:text-white cursor-pointer"
                        >
                          <Minus size={11} />
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={gitBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            void runGitAction("workspace.git.stage", { filePath: file.path }, `Staged ${name}`);
                          }}
                          title="Stage"
                          className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-white/[0.1] hover:text-emerald-300 cursor-pointer"
                        >
                          <Plus size={11} />
                        </button>
                      )}
                      {awaitingDiscard ? (
                        <button
                          type="button"
                          disabled={gitBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDiscard("");
                            void runGitAction(
                              "workspace.git.discard",
                              { filePath: file.path, kind: file.kind },
                              `Reverted ${name}`
                            );
                          }}
                          className="rounded bg-rose-600 px-1.5 py-0.2 text-[9.5px] font-sans font-medium text-white hover:bg-rose-500 cursor-pointer"
                        >
                          Revert
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={gitBusy}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDiscard(file.path);
                          }}
                          title="Discard changes"
                          className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:bg-rose-500/20 hover:text-rose-300 cursor-pointer"
                        >
                          <ArrowCounterClockwise size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected File Diff Header */}
          {selectedEntry && (
            <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-white/[0.05] bg-[#0b0b0d] px-3 text-[11px]">
              <span className="truncate font-mono text-zinc-400">{selectedEntry.path}</span>
              <button
                type="button"
                onClick={() => void openDocInInspector(selectedEntry.path)}
                className="shrink-0 text-[11px] text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer"
              >
                Open
              </button>
            </div>
          )}

          {/* Clean Unified / Split Diff Canvas */}
          <div className="flex-1 min-h-0 overflow-y-auto bg-[#0a0a0c]">
            <DiffViewer diff={snap?.diff || ""} mode={state.diffViewMode} />
          </div>

          {/* Compact Contextual Commit Footer */}
          {snap?.isGitRepo && (
            <div className="shrink-0 border-t border-white/[0.06] bg-zinc-950/90 px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <div className="relative flex flex-1 items-center min-w-0">
                  <input
                    type="text"
                    value={commitMsg}
                    onChange={(e) => setCommitMsg(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commitMsg.trim()) {
                        e.preventDefault();
                        void handleCommit();
                      }
                    }}
                    placeholder="Commit message (⌘⏎)…"
                    className="w-full rounded-lg border border-white/[0.08] bg-zinc-900 py-1.5 pl-2.5 pr-11 text-[11.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/45 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={gitBusy}
                    onClick={() => void handleSuggestCommit()}
                    title="Auto-fill commit message"
                    className="absolute right-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 disabled:opacity-40 cursor-pointer"
                  >
                    Auto
                  </button>
                </div>
                <button
                  type="button"
                  disabled={gitBusy || !commitMsg.trim()}
                  onClick={() => void handleCommit()}
                  className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-[11.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-35 cursor-pointer"
                >
                  Commit
                </button>
              </div>
              <div className="flex items-center justify-end gap-3 text-[11px] text-zinc-500">
                <button
                  type="button"
                  disabled={gitBusy}
                  onClick={() => void runGitAction("workspace.git.push", {}, "Pushed branch")}
                  className="hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  Push
                </button>
                <span className="text-zinc-700">·</span>
                <button
                  type="button"
                  disabled={gitBusy}
                  onClick={() =>
                    void runGitAction("workspace.git.create_pr", { title: commitMsg.trim() }, "PR created")
                  }
                  className="hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  Create PR
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  file?: DocFileItem;
  children: TreeNode[];
}

function buildFileTree(files: DocFileItem[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let cursor = root;
    let acc = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      acc = acc ? `${acc}/${part}` : part;
      const isLast = i === parts.length - 1;
      let existing = cursor.children.find((c) => c.name === part && c.isDir === !isLast);
      if (!existing) {
        existing = {
          name: part,
          path: acc,
          isDir: !isLast,
          ...(isLast ? { file } : {}),
          children: [],
        };
        cursor.children.push(existing);
      }
      cursor = existing;
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    });
    for (const n of nodes) {
      if (n.isDir) sortNodes(n.children);
    }
  };
  sortNodes(root.children);
  return root.children;
}

function FileTreeRows({
  nodes,
  depth = 0,
  selectedPath,
  expandedDirs,
  onToggleDir,
  onSelectFile,
}: {
  nodes: TreeNode[];
  depth?: number;
  selectedPath: string;
  expandedDirs: Record<string, boolean>;
  onToggleDir: (dirPath: string) => void;
  onSelectFile: (filePath: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.isDir) {
          const isOpen = expandedDirs[node.path] ?? depth === 0;
          return (
            <React.Fragment key={`dir:${node.path}`}>
              <button
                type="button"
                onClick={() => onToggleDir(node.path)}
                style={{ paddingLeft: 12 + depth * 14 }}
                className="flex w-full items-center gap-2 py-1 pr-3 text-left text-[12px] text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200 transition-colors cursor-pointer"
              >
                {isOpen ? (
                  <FolderOpen size={14} className="shrink-0 text-zinc-400" />
                ) : (
                  <Folder size={14} className="shrink-0 text-zinc-500" />
                )}
                <span className="truncate font-medium">{node.name}</span>
              </button>
              {isOpen && (
                <FileTreeRows
                  nodes={node.children}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  onToggleDir={onToggleDir}
                  onSelectFile={onSelectFile}
                />
              )}
            </React.Fragment>
          );
        }

        const active = node.path === selectedPath;
        return (
          <button
            key={`file:${node.path}`}
            type="button"
            onClick={() => onSelectFile(node.path)}
            style={{ paddingLeft: 16 + depth * 14 }}
            className={`flex w-full items-center justify-between gap-2 py-1 pr-3 text-left text-[12px] transition-colors cursor-pointer ${
              active
                ? "bg-white/[0.09] text-white font-medium"
                : "text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
            }`}
          >
            <span className="truncate">{node.name}</span>
            {node.file?.isMarkdown && (
              <span className="shrink-0 font-mono text-[9.5px] text-zinc-500">md</span>
            )}
          </button>
        );
      })}
    </>
  );
}

function DocsPane() {
  const { state, notifyToast } = useWorkspace();
  const snap = state.docsSnapshot;
  const [query, setQuery] = useState("");
  const [browsingFiles, setBrowsingFiles] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
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

  // Whenever an external click (e.g., file link in chat or Changes -> Open) loads a document, show the reader
  useEffect(() => {
    if (snap?.document?.path) {
      setBrowsingFiles(false);
    }
  }, [snap?.document?.path, snap?.document?.anchorLine]);

  useEffect(() => {
    if (!browsingFiles && snap?.document?.anchorLine) {
      anchorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [browsingFiles, snap?.document?.path, snap?.document?.anchorLine]);

  const doc = snap?.document;
  const isMarkdown = doc?.language === "markdown";
  const showExplorer = browsingFiles || !doc;

  const pinnedFiles = useMemo(
    () => (snap?.files || []).filter((f) => f.pinned),
    [snap?.files]
  );

  const fileTree = useMemo(
    () => buildFileTree(snap?.files || []),
    [snap?.files]
  );

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => ({
      ...prev,
      [dirPath]: !(prev[dirPath] ?? !dirPath.includes("/")),
    }));
  };

  const handleOpenFile = (filePath: string) => {
    setBrowsingFiles(false);
    void loadDoc(filePath, "");
    setQuery("");
  };

  const handleCopyPath = async (p: string) => {
    try {
      await navigator.clipboard.writeText(p);
      notifyToast(`Copied ${p}`);
    } catch {
      // ignore clipboard failures
    }
  };

  if (showExplorer) {
    const searching = Boolean(query.trim());
    return (
      <div className="flex flex-1 min-h-0 flex-col">
        {/* Clean Quick-Open Search Header */}
        <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-2.5 py-2">
          {doc && (
            <button
              type="button"
              onClick={() => setBrowsingFiles(false)}
              title="Back to document"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-100 cursor-pointer"
            >
              <ArrowLeft size={13} />
            </button>
          )}
          <div className="relative flex flex-1 items-center min-w-0">
            <MagnifyingGlass size={13} className="absolute left-2.5 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                void loadDoc(snap?.selectedPath, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape" && doc) {
                  setBrowsingFiles(false);
                }
              }}
              placeholder="Search files…"
              className="w-full rounded-lg border border-white/[0.07] bg-zinc-900/90 py-1.5 pl-7 pr-7 text-[12px] text-zinc-200 placeholder:text-zinc-500 focus:border-blue-500/45 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  void loadDoc(snap?.selectedPath, "");
                }}
                className="absolute right-2 text-zinc-500 hover:text-zinc-200 cursor-pointer"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* File Tree or Flat Search Matches */}
        <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
          {!snap || snap.files.length === 0 ? (
            <div className="py-10 text-center text-[12px] text-zinc-500">
              No matching files
            </div>
          ) : searching ? (
            <div className="space-y-0.5">
              {snap.files.slice(0, 60).map((f) => {
                const { name, dir } = splitFilePath(f.path);
                const active = snap.selectedPath === f.path;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => handleOpenFile(f.path)}
                    className={`flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition-colors cursor-pointer ${
                      active
                        ? "bg-white/[0.09] text-white font-medium"
                        : "text-zinc-200 hover:bg-white/[0.04]"
                    }`}
                  >
                    <span className="truncate">{name}</span>
                    {dir && <span className="truncate font-mono text-[10.5px] text-zinc-500">{dir}</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="space-y-3">
              {pinnedFiles.length > 0 && (
                <div>
                  <div className="px-3 pb-1 text-[10.5px] font-medium text-zinc-500">
                    Key Files
                  </div>
                  {pinnedFiles.map((f) => {
                    const { name, dir } = splitFilePath(f.path);
                    const active = snap.selectedPath === f.path;
                    return (
                      <button
                        key={`pin:${f.path}`}
                        type="button"
                        onClick={() => handleOpenFile(f.path)}
                        className={`flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition-colors cursor-pointer ${
                          active
                            ? "bg-white/[0.09] text-white font-medium"
                            : "text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100"
                        }`}
                      >
                        <span className="truncate">{name}</span>
                        {dir && <span className="truncate font-mono text-[10.5px] text-zinc-500">{dir}</span>}
                      </button>
                    );
                  })}
                </div>
              )}

              <div>
                <div className="px-3 pb-1 text-[10.5px] font-medium text-zinc-500">
                  Workspace Files
                </div>
                <FileTreeRows
                  nodes={fileTree}
                  selectedPath={snap.selectedPath || ""}
                  expandedDirs={expandedDirs}
                  onToggleDir={toggleDir}
                  onSelectFile={handleOpenFile}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const { name: docName, dir: docDir } = splitFilePath(doc.path);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      {/* Full-Height Reader Top Bar with Breadcrumb & 1-Click File Explorer */}
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-2.5 text-[11.5px]">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setBrowsingFiles(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 transition-colors cursor-pointer"
          >
            <ArrowLeft size={12} />
            <span>Files</span>
          </button>
          <span className="text-zinc-700">/</span>
          <button
            type="button"
            onClick={() => setBrowsingFiles(true)}
            title={doc.path}
            className="flex items-baseline gap-1 min-w-0 truncate text-left hover:text-white cursor-pointer"
          >
            {docDir && <span className="truncate text-[11px] text-zinc-500">{docDir}/</span>}
            <span className="truncate font-medium text-zinc-200">{docName}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0 text-[10.5px] text-zinc-500">
          {doc.totalLines ? <span className="font-mono">{doc.totalLines}L</span> : null}
          <button
            type="button"
            onClick={() => void handleCopyPath(doc.path)}
            className="rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 cursor-pointer"
          >
            Copy
          </button>
        </div>
      </div>

      {/* Full-Height Editorial Markdown or Crisp Code Canvas */}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto bg-[#0a0a0c]">
        {doc.error ? (
          <div className="m-3 rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-[12px] text-rose-300">
            {doc.error}
          </div>
        ) : doc.preview && doc.absolutePath ? (
          <WorkspaceFilePreview key={doc.absolutePath + doc.preview.revision} filePath={doc.absolutePath}
            mime={doc.preview.mime} revision={doc.preview.revision} size={doc.sizeBytes || 0} />
        ) : isMarkdown ? (
          <div className="min-w-0 px-5 py-4">
            <MarkdownBlock text={doc.content || ""} onOpenFile={(p) => handleOpenFile(p)} />
          </div>
        ) : (
          <div className="py-2.5 font-mono text-[11.5px] leading-[1.6] selectable-text">
            {(doc.content || "").split("\n").map((line, i) => {
              const lineNum = (doc.startLine || 1) + i;
              const isAnchor = doc.anchorLine === lineNum;
              return (
                <div
                  key={lineNum}
                  ref={isAnchor ? anchorRef : undefined}
                  className={`flex px-2 ${
                    isAnchor
                      ? "bg-blue-500/15 border-l-2 border-blue-400 text-white"
                      : "text-zinc-300"
                  }`}
                >
                  <span className="w-9 shrink-0 select-none text-right pr-3 text-[10.5px] text-zinc-600">
                    {lineNum}
                  </span>
                  <span className="whitespace-pre overflow-x-auto">{line || " "}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const DECISION_STATUSES: ReadonlyArray<{
  id: "open" | "resolved" | "archived" | "superseded";
  label: string;
  pillClass: string;
}> = [
  {
    id: "open",
    label: "open",
    pillClass: "bg-amber-500/15 text-amber-300 border-amber-400/25",
  },
  {
    id: "resolved",
    label: "resolved",
    pillClass: "bg-emerald-500/15 text-emerald-300 border-emerald-400/25",
  },
  {
    id: "archived",
    label: "archived",
    pillClass: "bg-white/[0.06] text-zinc-400 border-white/[0.1]",
  },
  {
    id: "superseded",
    label: "superseded",
    pillClass: "bg-white/[0.05] text-zinc-500 border-white/[0.08]",
  },
];

type DecisionFilter = "all" | "open" | "resolved" | "archived";

type DecisionConfirmAction =
  | { kind: "delete_one"; file: string; title: string }
  | { kind: "clear_closed"; count: number }
  | { kind: "clear_all"; count: number };

function decisionPillClass(status: string): string {
  return (
    DECISION_STATUSES.find((s) => s.id === status)?.pillClass ||
    "bg-white/[0.06] text-zinc-400 border-white/[0.1]"
  );
}

function ContextPane() {
  const { state, notifyToast } = useWorkspace();
  const snap = state.contextSnapshot;
  const [section, setSection] = useState<"decisions" | "memory">("decisions");
  const [statusFilter, setStatusFilter] = useState<DecisionFilter>("all");
  const [creatingDecision, setCreatingDecision] = useState(false);
  const [decTitle, setDecTitle] = useState("");
  const [decBody, setDecBody] = useState("");
  const [creatingMem, setCreatingMem] = useState(false);
  const [memTitle, setMemTitle] = useState("");
  const [memBody, setMemBody] = useState("");
  const [memTags, setMemTags] = useState("");
  const [expandedFile, setExpandedFile] = useState("");
  const [statusMenuFile, setStatusMenuFile] = useState("");
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [confirmAction, setConfirmAction] = useState<DecisionConfirmAction | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const refreshContext = async () => {
    await ufooBridge.sendCommand("workspace.context", { operation: "snapshot" });
  };

  useEffect(() => {
    if (state.scope === "project" && !snap) {
      void refreshContext();
    }
  }, [state.activeRoot, state.scope]);

  useEffect(() => {
    if (!statusMenuFile && !moreMenuOpen) return;
    const dismiss = () => {
      setStatusMenuFile("");
      setMoreMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [statusMenuFile, moreMenuOpen]);

  useEffect(() => {
    if (!confirmAction) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !actionBusy) setConfirmAction(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmAction, actionBusy]);

  const allDecisions = snap?.decisions || [];
  const openCount = snap?.openDecisionCount ?? allDecisions.filter((d) => d.status === "open").length;
  const closedCount = allDecisions.filter((d) => d.status !== "open").length;

  const filteredDecisions = useMemo(() => {
    if (statusFilter === "all") return allDecisions;
    if (statusFilter === "resolved") {
      return allDecisions.filter((d) => d.status === "resolved" || d.status === "superseded");
    }
    return allDecisions.filter((d) => d.status === statusFilter);
  }, [allDecisions, statusFilter]);

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

  const handleSetDecisionStatus = async (file: string, nextStatus: string) => {
    setStatusMenuFile("");
    try {
      const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("workspace.context", {
        operation: "decision.set_status",
        file,
        status: nextStatus,
      });
      if (!res?.ok) throw new Error(res?.error || "Failed to update status");
      notifyToast(`Decision marked ${nextStatus}`);
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleTidyDecisions = async () => {
    if (openCount === 0 || tidying) return;
    setTidying(true);
    try {
      const res = await ufooBridge.sendCommand<{
        ok: boolean;
        openCount?: number;
        error?: string;
      }>("workspace.context", {
        operation: "decision.tidy",
      });
      if (!res?.ok) {
        notifyToast(res?.error || "Unable to tidy decisions");
        return;
      }
      notifyToast(`ufoo is tidying ${res.openCount || openCount} open decision(s)…`);
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setTidying(false);
    }
  };

  const handleRunConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionBusy(true);
    try {
      if (confirmAction.kind === "delete_one") {
        const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("workspace.context", {
          operation: "decision.delete",
          file: confirmAction.file,
        });
        if (!res?.ok) throw new Error(res?.error || "Failed to delete decision");
        if (expandedFile === confirmAction.file) setExpandedFile("");
        notifyToast("Decision deleted");
      } else {
        const scope = confirmAction.kind === "clear_closed" ? "closed" : "all";
        const res = await ufooBridge.sendCommand<{ ok: boolean; error?: string }>("workspace.context", {
          operation: "decision.clear",
          scope,
        });
        if (!res?.ok) throw new Error(res?.error || "Failed to clear decisions");
        setExpandedFile("");
        notifyToast(scope === "all" ? "Cleared all decisions" : "Cleared archived & resolved decisions");
      }
      setConfirmAction(null);
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    } finally {
      setActionBusy(false);
    }
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
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
        <div className="inline-flex rounded-lg border border-white/[0.07] bg-zinc-900 p-0.5 text-[11.5px]">
          <button
            type="button"
            onClick={() => setSection("decisions")}
            className={`rounded-md px-2.5 py-1 transition-colors cursor-pointer ${
              section === "decisions" ? "bg-white/[0.12] text-white font-medium" : "text-zinc-400"
            }`}
          >
            Decisions ({openCount})
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
          className="rounded-lg border border-white/[0.1] bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-white/[0.1] hover:text-white transition-colors cursor-pointer"
        >
          + New
        </button>
      </div>

      {section === "decisions" && (
        <div className="flex items-center justify-between gap-2 border-b border-white/[0.05] bg-black/15 px-3 py-1.5">
          <div className="flex items-center gap-0.5 text-[11px]">
            {(
              [
                { id: "all", label: "All" },
                { id: "open", label: "Open" },
                { id: "resolved", label: "Resolved" },
                { id: "archived", label: "Archived" },
              ] as ReadonlyArray<{ id: DecisionFilter; label: string }>
            ).map((tab) => {
              const active = statusFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setStatusFilter(tab.id)}
                  className={`rounded-md px-2 py-0.5 transition-colors cursor-pointer ${
                    active
                      ? "bg-white/[0.1] text-zinc-100 font-medium"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="relative flex items-center gap-1 shrink-0">
            <button
              type="button"
              disabled={openCount === 0 || tidying}
              onClick={() => void handleTidyDecisions()}
              title="让 ufoo 逐条分析未关闭 Decision：需继续处理的保持 open，过时/临时/已解决的自动归档，并在有长期价值时弹窗询问是否存入 Memory"
              className="rounded-md border border-white/[0.09] bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-zinc-200 hover:bg-white/[0.1] hover:text-white disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              {tidying ? "Tidying…" : "Tidy"}
            </button>

            <button
              type="button"
              disabled={allDecisions.length === 0}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMoreMenuOpen((v) => !v)}
              title="More decision actions"
              aria-label="More decision actions"
              className="flex h-6 w-6 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              <DotsThree size={15} weight="bold" />
            </button>

            {moreMenuOpen && (
              <div
                onPointerDown={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-1 z-40 w-48 rounded-xl border border-white/[0.1] bg-zinc-900 p-1 shadow-xl"
              >
                <button
                  type="button"
                  disabled={closedCount === 0}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setConfirmAction({ kind: "clear_closed", count: closedCount });
                  }}
                  className="flex h-7 w-full items-center justify-between rounded-lg px-2.5 text-left text-[11.5px] text-zinc-200 hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  <span>Clear Closed / Archived</span>
                  <span className="font-mono text-[10px] text-zinc-500">{closedCount}</span>
                </button>
                <div role="separator" className="my-1 border-t border-white/[0.08]" />
                <button
                  type="button"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    setConfirmAction({ kind: "clear_all", count: allDecisions.length });
                  }}
                  className="flex h-7 w-full items-center justify-between rounded-lg px-2.5 text-left text-[11.5px] text-rose-400 hover:bg-rose-500/15 hover:text-rose-300 cursor-pointer"
                >
                  <span>Clear All Decisions</span>
                  <span className="font-mono text-[10px] text-rose-400/70">{allDecisions.length}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
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
                    className="rounded-lg bg-white/[0.14] px-3 py-1 text-[11.5px] font-medium text-white hover:bg-white/[0.2] cursor-pointer"
                  >
                    Save Decision
                  </button>
                </div>
              </div>
            )}

            {filteredDecisions.length === 0 ? (
              <div className="py-8 text-center text-[12px] text-zinc-500">
                {allDecisions.length === 0
                  ? "No decisions in `.ufoo/context/decisions/`"
                  : `No ${statusFilter} decisions`}
              </div>
            ) : (
              filteredDecisions.map((dec) => {
                const isOpen = expandedFile === dec.file;
                const statusOpen = statusMenuFile === dec.file;
                return (
                  <div
                    key={dec.file}
                    className="group rounded-xl border border-white/[0.07] bg-white/[0.02] p-3"
                  >
                    <div
                      onClick={() => setExpandedFile(isOpen ? "" : dec.file)}
                      className="flex items-start justify-between gap-2 cursor-pointer"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-medium text-zinc-100 leading-snug">
                          {dec.title}
                        </div>
                        <div className="mt-1 font-mono text-[10.5px] text-zinc-500 truncate">
                          {dec.file}
                        </div>
                        {dec.resolution_note && (
                          <div className="mt-1 text-[11px] text-zinc-500 line-clamp-2">
                            {dec.resolution_note}
                          </div>
                        )}
                      </div>

                      <div
                        className="relative flex shrink-0 items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => setStatusMenuFile(statusOpen ? "" : dec.file)}
                          title="Change decision status"
                          className={`whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] transition-opacity hover:opacity-90 cursor-pointer ${decisionPillClass(
                            dec.status
                          )}`}
                        >
                          {dec.status}
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({
                              kind: "delete_one",
                              file: dec.file,
                              title: dec.title,
                            })
                          }
                          title="Delete decision"
                          aria-label={`Delete decision ${dec.title}`}
                          className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-rose-500/15 hover:text-rose-300 transition-all cursor-pointer"
                        >
                          <Trash size={12} />
                        </button>

                        {statusOpen && (
                          <div className="absolute right-0 top-full mt-1 z-40 w-32 rounded-xl border border-white/[0.1] bg-zinc-900 p-1 shadow-xl">
                            {DECISION_STATUSES.map((opt) => {
                              const selected = dec.status === opt.id;
                              return (
                                <button
                                  key={opt.id}
                                  type="button"
                                  onClick={() => void handleSetDecisionStatus(dec.file, opt.id)}
                                  className={`flex h-6.5 w-full items-center justify-between rounded-lg px-2 font-mono text-[11px] transition-colors cursor-pointer ${
                                    selected
                                      ? "bg-white/[0.1] text-white"
                                      : "text-zinc-300 hover:bg-white/[0.06]"
                                  }`}
                                >
                                  <span>{opt.label}</span>
                                  {selected && <span className="text-[10px] text-zinc-300">✓</span>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
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
                    className="rounded-lg bg-white/[0.14] px-3 py-1 text-[11.5px] font-medium text-white hover:bg-white/[0.2] cursor-pointer"
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

      {confirmAction &&
        createPortal(
          <div
            onClick={() => {
              if (!actionBusy) setConfirmAction(null);
            }}
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Confirm decision deletion"
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[380px] rounded-2xl border border-white/[0.1] bg-[#121216] p-5 shadow-2xl space-y-3"
            >
              <div className="space-y-1.5">
                <h3 className="text-[14px] font-semibold text-zinc-100">
                  {confirmAction.kind === "delete_one"
                    ? `Delete “${confirmAction.title}”?`
                    : confirmAction.kind === "clear_closed"
                    ? `Clear ${confirmAction.count} closed decision(s)?`
                    : `Clear all ${confirmAction.count} decision(s)?`}
                </h3>
                <p className="text-[12px] leading-relaxed text-zinc-400">
                  {confirmAction.kind === "delete_one"
                    ? "This permanently removes the decision markdown file from `.ufoo/context/decisions/` and rebuilds the index."
                    : confirmAction.kind === "clear_closed"
                    ? "This permanently removes all archived, resolved, and superseded decision files. Open decisions will remain untouched."
                    : "This permanently removes every decision file in `.ufoo/context/decisions/` and cannot be undone."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => setConfirmAction(null)}
                  className="rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => void handleRunConfirmedAction()}
                  className="rounded-lg bg-rose-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-rose-500 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {actionBusy
                    ? "Removing…"
                    : confirmAction.kind === "delete_one"
                    ? "Delete"
                    : "Clear"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

const DEFAULT_INSPECTOR_WIDTH = 370;
const MIN_INSPECTOR_WIDTH = 260;
const MIN_CHAT_WIDTH = 360;

export function RightInspector({ mobileFullWidth = false }: { mobileFullWidth?: boolean } = {}) {
  const { state, dispatch } = useWorkspace();
  const visible = mobileFullWidth ? true : state.rightInspectorOpen && state.scope === "project";
  const inspector = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_INSPECTOR_WIDTH + MIN_CHAT_WIDTH);
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [resizing, setResizing] = useState(false);

  useLayoutEffect(() => {
    const container = inspector.current?.parentElement;
    if (mobileFullWidth || !visible || !container) {
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
  }, [visible, mobileFullWidth]);

  if (!visible) return null;

  if (mobileFullWidth && state.scope !== "project") {
    return (
      <div className="flex h-full w-full flex-1 flex-col items-center justify-center bg-[#111114] px-6 text-center">
        <div className="text-[13.5px] font-medium text-zinc-200">No project selected</div>
        <p className="mt-1 max-w-xs text-[12px] text-zinc-500">
          Open the project menu to pick a workspace and review its Git changes, docs, and context.
        </p>
        <button
          type="button"
          onClick={() => dispatch({ type: "SET_MOBILE_DRAWER", open: true })}
          className="mt-3 rounded-xl border border-white/[0.1] bg-white/[0.05] px-4 py-2 text-[12.5px] font-medium text-zinc-200 hover:bg-white/[0.1] cursor-pointer"
        >
          Browse Projects
        </button>
      </div>
    );
  }

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
  }> = [
    { id: "changes", label: "Changes", badge: changedCount },
    { id: "docs", label: "Files" },
    { id: "context", label: "Context", badge: openDecisionCount },
  ];

  return (
    <aside
      id={mobileFullWidth ? "workspace-inspector-mobile" : "workspace-inspector"}
      ref={inspector}
      style={mobileFullWidth ? undefined : { width }}
      className={
        mobileFullWidth
          ? "relative flex h-full w-full min-w-0 flex-1 flex-col bg-[#111114] select-none"
          : "relative hidden md:flex h-full min-w-0 shrink-0 flex-col bg-[#111114] select-none"
      }
    >
      {!mobileFullWidth && (
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
      )}
      {/* Top Drag Bar + Segmented Tabs + Pinned Right Sidebar Toggle */}
      <div
        data-tauri-drag-region={!mobileFullWidth ? true : undefined}
        className="flex h-[44px] shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pl-3 pr-2.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {tabs.map(({ id, label, badge }) => {
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
        {!mobileFullWidth && (
          <button
            type="button"
            onClick={() => dispatch({ type: "TOGGLE_RIGHT_INSPECTOR" })}
            title="Hide Workspace Inspector (⌘⌥B)"
            aria-label="Hide Workspace Inspector"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-zinc-200 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
          >
            <RightSidebarIcon active />
          </button>
        )}
      </div>

      {state.rightTab === "changes" && <ChangesPane />}
      {state.rightTab === "docs" && <DocsPane />}
      {state.rightTab === "context" && <ContextPane />}
    </aside>
  );
}
