import React, { useMemo, useState } from "react";
import {
  ArrowRight,
  BellSimple,
  Check,
  CheckCircle,
  PaperPlaneRight,
  ShieldWarning,
  TerminalWindow,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { useWorkspace } from "../store/workspaceStore";
import type { PendingInteraction, ProjectTreeNode } from "../types";
import { MarkdownBlock } from "./MarkdownBlock";

type RiskTier = "high" | "medium" | "standard";

function inferToolAndRisk(interaction: PendingInteraction): {
  toolLabel: string;
  risk: RiskTier;
} {
  const prompt = String(interaction.prompt || "");
  const explicitTool = String(interaction.toolName || "").trim();
  const explicitRisk = String(interaction.riskLevel || "").trim().toLowerCase();

  let toolLabel = explicitTool;
  if (!toolLabel) {
    if (/`[^`]*(?:rm |git |npm |cargo |curl |sh |bash |sudo )/.test(prompt) || /\b(?:shell|bash|command|terminal|exec)\b/i.test(prompt)) {
      toolLabel = "Shell";
    } else if (/\b(?:write|edit|patch|create|modify|delete)\b/i.test(prompt)) {
      toolLabel = "File Edit";
    } else if (interaction.kind === "approval") {
      toolLabel = "Tool Approval";
    } else if (interaction.kind === "choice") {
      toolLabel = "Decision";
    } else {
      toolLabel = "Input";
    }
  }

  let risk: RiskTier = "standard";
  if (explicitRisk === "high" || explicitRisk === "critical") {
    risk = "high";
  } else if (explicitRisk === "medium" || explicitRisk === "moderate") {
    risk = "medium";
  } else if (explicitRisk === "low" || explicitRisk === "standard") {
    risk = "standard";
  } else if (
    /\b(?:rm\s+-|sudo|git\s+push|force|--hard|drop\s+table|delete|shell|bash|exec)\b/i.test(
      `${explicitTool} ${prompt}`
    )
  ) {
    risk = "high";
  } else if (/\b(?:write|edit|patch|install|commit|merge|deploy)\b/i.test(`${explicitTool} ${prompt}`)) {
    risk = "medium";
  }

  return { toolLabel, risk };
}

function formatAgo(iso?: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function ApprovalCard({
  interaction,
  projectLabel,
  onRespond,
  onOpenFile,
}: {
  interaction: PendingInteraction;
  projectLabel: string;
  onRespond: (id: string, answer: string, cancelled?: boolean) => Promise<void>;
  onOpenFile?: (path: string) => void;
}) {
  const [replyText, setReplyText] = useState("");
  const [showCustomReply, setShowCustomReply] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { toolLabel, risk } = useMemo(() => inferToolAndRisk(interaction), [interaction]);
  const options = Array.isArray(interaction.options) ? interaction.options : [];
  const allowFreeChat = interaction.allowFreeChat !== false;
  const kind = String(interaction.kind || "approval").toLowerCase();
  const denyLabel = kind === "approval" ? "Deny" : "Dismiss";

  const riskBadge =
    risk === "high"
      ? {
          label: "High Risk",
          cls: "border-rose-500/35 bg-rose-500/15 text-rose-300",
        }
      : risk === "medium"
      ? {
          label: "Medium",
          cls: "border-amber-500/35 bg-amber-500/15 text-amber-300",
        }
      : {
          label: "Standard",
          cls: "border-white/[0.1] bg-white/[0.05] text-zinc-300",
        };

  const handleAction = async (answer: string, cancelled = false) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onRespond(interaction.id, answer, cancelled);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="overflow-hidden rounded-2xl border border-white/[0.1] bg-[#131317] shadow-[0_12px_32px_rgba(0,0,0,0.4)]">
      {/* Header Metadata Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] bg-white/[0.02] px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${riskBadge.cls}`}
          >
            {risk === "high" ? (
              <ShieldWarning size={11} weight="fill" />
            ) : (
              <Wrench size={11} />
            )}
            <span>{riskBadge.label}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-zinc-900 px-2 py-0.5 font-mono text-[10.5px] text-zinc-200">
            <TerminalWindow size={11} className="text-zinc-400" />
            <span>{toolLabel}</span>
          </span>
          {projectLabel && (
            <span className="truncate rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-zinc-400 max-w-[140px]">
              {projectLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10.5px] text-zinc-500 shrink-0">
          {interaction.agentId && (
            <span className="font-mono truncate max-w-[110px]">{interaction.agentId}</span>
          )}
          {interaction.createdAt && <span>{formatAgo(interaction.createdAt)}</span>}
        </div>
      </div>

      {/* Prompt Body */}
      <div className="px-4 py-3.5 space-y-3.5">
        <div className="rounded-xl border border-white/[0.06] bg-black/30 px-3.5 py-2.5 text-[13px] leading-relaxed text-zinc-200 selectable-text">
          <MarkdownBlock text={interaction.prompt} onOpenFile={onOpenFile} />
        </div>

        {/* Thumb-Friendly Action Row */}
        <div className="space-y-2">
          {options.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {options.map((opt, idx) => (
                <button
                  key={opt.key}
                  type="button"
                  disabled={submitting}
                  onClick={() => void handleAction(opt.key, false)}
                  className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-semibold active:scale-[0.98] disabled:opacity-45 transition-all cursor-pointer ${
                    idx === 0
                      ? "bg-emerald-500 text-zinc-950 hover:bg-emerald-400 shadow-[0_6px_20px_rgba(16,185,129,0.28)]"
                      : "border border-white/[0.12] bg-white/[0.06] text-zinc-100 hover:bg-white/[0.11]"
                  }`}
                >
                  {idx === 0 && <Check size={15} weight="bold" />}
                  <span className="truncate">{opt.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleAction("allow", false)}
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-[13.5px] font-semibold text-zinc-950 shadow-[0_6px_20px_rgba(16,185,129,0.28)] hover:bg-emerald-400 active:scale-[0.98] disabled:opacity-45 transition-all cursor-pointer"
            >
              <Check size={16} weight="bold" />
              <span>Allow</span>
            </button>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void handleAction("", true)}
              className="flex min-h-[42px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-[13px] font-medium text-rose-200 hover:bg-rose-500/20 active:scale-[0.98] disabled:opacity-45 transition-all cursor-pointer"
            >
              <X size={14} weight="bold" />
              <span>{denyLabel}</span>
            </button>

            {allowFreeChat && !showCustomReply && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowCustomReply(true)}
                className="flex min-h-[42px] items-center justify-center rounded-xl border border-white/[0.09] bg-white/[0.04] px-3.5 py-2 text-[12.5px] font-medium text-zinc-300 hover:bg-white/[0.09] hover:text-white transition-colors cursor-pointer"
              >
                Reply…
              </button>
            )}
          </div>

          {allowFreeChat && showCustomReply && (
            <div className="flex items-center gap-2 pt-1">
              <input
                type="text"
                autoFocus
                disabled={submitting}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && replyText.trim()) {
                    e.preventDefault();
                    const text = replyText.trim();
                    setReplyText("");
                    void handleAction(text, false);
                  }
                }}
                placeholder="Type custom instruction or reply…"
                className="h-10 min-w-0 flex-1 rounded-xl border border-white/[0.1] bg-zinc-950 px-3 text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none"
              />
              <button
                type="button"
                disabled={submitting || !replyText.trim()}
                onClick={() => {
                  if (!replyText.trim()) return;
                  const text = replyText.trim();
                  setReplyText("");
                  void handleAction(text, false);
                }}
                className="flex h-10 shrink-0 items-center justify-center gap-1 rounded-xl bg-blue-600 px-3.5 text-[12.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-40 cursor-pointer"
              >
                <PaperPlaneRight size={14} weight="bold" />
                <span>Send</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function ApprovalInbox({
  onCloseModal,
}: {
  onCloseModal?: () => void;
} = {}) {
  const {
    state,
    dispatch,
    selectProjectMain,
    respondInteraction,
    openDocInInspector,
    notifyToast,
  } = useWorkspace();

  const items: PendingInteraction[] = useMemo(() => {
    if (state.pendingInteractions.length > 0) return state.pendingInteractions;
    return state.pendingInteraction ? [state.pendingInteraction] : [];
  }, [state.pendingInteractions, state.pendingInteraction]);

  const waitingOtherProjects: ProjectTreeNode[] = useMemo(
    () =>
      state.projects.filter(
        (p) => p.waitingUser && p.root !== state.activeRoot
      ),
    [state.projects, state.activeRoot]
  );

  const resolveProjectLabel = (root?: string): string => {
    const target = root || state.activeRoot;
    if (!target) return "";
    const found = state.projects.find((p) => p.root === target);
    if (found) return found.label;
    return target.split("/").filter(Boolean).pop() || target;
  };

  const handleRespond = async (id: string, answer: string, cancelled = false) => {
    try {
      await respondInteraction(id, answer, cancelled, false);
      notifyToast(cancelled ? "Request declined" : "Response sent");
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDismissAll = async () => {
    try {
      await respondInteraction(items[0]?.id || "", "", true, true);
      notifyToast("Dismissed all pending requests");
    } catch (err) {
      notifyToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSwitchProject = async (project: ProjectTreeNode) => {
    await selectProjectMain(project.root);
    notifyToast(`Switched to ${project.label}`);
  };

  const totalAttention = items.length + waitingOtherProjects.length;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[#0c0c0e]">
      {/* Inbox Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <BellSimple size={16} weight="duotone" className="text-amber-400 shrink-0" />
          <h2 className="text-[14px] font-semibold text-zinc-100 truncate">
            Approval Inbox
          </h2>
          {totalAttention > 0 && (
            <span className="rounded-full bg-amber-500/20 border border-amber-400/30 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-amber-300">
              {totalAttention}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {items.length > 1 && (
            <button
              type="button"
              onClick={() => void handleDismissAll()}
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1 text-[11.5px] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200 transition-colors cursor-pointer"
            >
              Dismiss all
            </button>
          )}
          {onCloseModal && (
            <button
              type="button"
              onClick={onCloseModal}
              aria-label="Close approval inbox"
              className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Scrollable Approval Queue */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {totalAttention === 0 ? (
          <div className="flex h-full min-h-[260px] flex-col items-center justify-center text-center px-6 space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
              <CheckCircle size={26} weight="duotone" />
            </div>
            <div className="space-y-1">
              <div className="text-[14.5px] font-semibold text-zinc-100">
                All caught up
              </div>
              <p className="max-w-xs text-[12.5px] leading-relaxed text-zinc-500">
                No tool approvals or agent confirmation prompts are waiting for you right now.
              </p>
            </div>
            {!onCloseModal && (
              <button
                type="button"
                onClick={() => dispatch({ type: "SET_MOBILE_TAB", tab: "chat" })}
                className="mt-1 rounded-xl border border-white/[0.1] bg-white/[0.05] px-4 py-2 text-[12.5px] font-medium text-zinc-200 hover:bg-white/[0.1] transition-colors cursor-pointer"
              >
                Return to Chat
              </button>
            )}
          </div>
        ) : (
          <>
            {items.length > 0 && (
              <div className="space-y-3">
                {items.map((interaction) => (
                  <ApprovalCard
                    key={interaction.id}
                    interaction={interaction}
                    projectLabel={resolveProjectLabel(interaction.projectRoot)}
                    onRespond={handleRespond}
                    onOpenFile={(filePath) => {
                      void openDocInInspector(filePath);
                      dispatch({ type: "SET_MOBILE_TAB", tab: "changes" });
                      onCloseModal?.();
                    }}
                  />
                ))}
              </div>
            )}

            {waitingOtherProjects.length > 0 && (
              <div className="space-y-2.5 pt-1">
                <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500 px-1">
                  Other Projects Waiting for You
                </div>
                {waitingOtherProjects.map((proj) => (
                  <div
                    key={proj.root}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400 animate-pulse" />
                        <span className="truncate text-[13px] font-semibold text-zinc-100">
                          {proj.label}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-zinc-400">
                        {proj.branch || proj.root}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSwitchProject(proj)}
                      className="inline-flex min-h-[38px] shrink-0 items-center gap-1.5 rounded-xl bg-amber-400 px-3.5 py-2 text-[12px] font-semibold text-zinc-950 hover:bg-amber-300 active:scale-[0.98] transition-all cursor-pointer"
                    >
                      <span>Switch & Review</span>
                      <ArrowRight size={13} weight="bold" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
