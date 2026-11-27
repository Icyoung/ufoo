import React, { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChatCircleDots,
  Check,
  ListChecks,
  ShieldWarning,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";
import type { PendingInteraction } from "../types";
import { MarkdownBlock } from "./MarkdownBlock";

export interface AskInteractionDockProps {
  interaction: PendingInteraction | null | undefined;
  sourceLabel?: string;
  compact?: boolean;
  canDismiss?: boolean;
  onRespond: (answer: string, cancelled?: boolean, dismissAll?: boolean) => Promise<void> | void;
  onFocusInput?: () => void;
  onOpenFile?: (path: string) => void;
}

export function AskInteractionDock({
  interaction,
  sourceLabel = "",
  compact = false,
  canDismiss = false,
  onRespond,
  onFocusInput,
  onOpenFile,
}: AskInteractionDockProps) {
  const [submittingKey, setSubmittingKey] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const interactionKey = interaction
    ? `${interaction.id || ""}:${interaction.kind || ""}:${interaction.prompt || ""}`
    : "";

  useEffect(() => {
    setSubmittingKey(null);
    submittingRef.current = false;
  }, [interactionKey]);

  const kind = String(interaction?.kind || "chat").toLowerCase();
  const options = Array.isArray(interaction?.options) ? interaction.options : [];
  const isApproval = kind === "approval";
  const isChoice = !isApproval && options.length > 0;
  const allowFreeChat = interaction?.allowFreeChat !== false;
  const queueCount = Number(interaction?.queue_count) || 1;
  const toolName = String(interaction?.toolName || "").trim();

  const submitAnswer = async (
    answer: string,
    cancelled = false,
    dismissAll = false,
    busyToken = "__submit__"
  ) => {
    if (!interaction || submittingRef.current) return;
    submittingRef.current = true;
    setSubmittingKey(busyToken);
    try {
      await onRespond(answer, cancelled, dismissAll);
    } catch {
      submittingRef.current = false;
      setSubmittingKey(null);
    }
  };

  useEffect(() => {
    if (!interaction) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (submittingRef.current) return;
      if (e.isComposing || e.keyCode === 229) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = active?.tagName || "";
      const inEditable =
        tag === "TEXTAREA" ||
        tag === "INPUT" ||
        Boolean(active?.isContentEditable);
      const editableHasText =
        inEditable &&
        Boolean(
          ((active as HTMLInputElement | HTMLTextAreaElement)?.value || "").trim()
        );

      if (e.key === "Escape" && canDismiss && !editableHasText) {
        e.preventDefault();
        void submitAnswer("", true, false, "__dismiss__");
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !editableHasText) {
        if (options.length > 0) {
          e.preventDefault();
          void submitAnswer(options[0].key, false, false, options[0].key);
          return;
        }
        if (isApproval) {
          e.preventDefault();
          void submitAnswer("yes", false, false, "yes");
          return;
        }
      }

      // Quick 1..9 selection for choice lists (bare key when outside input, or Alt+1..9 anytime)
      if (isChoice && options.length > 0 && !e.metaKey && !e.ctrlKey) {
        const digitMatch = /^[1-9]$/.test(e.key);
        if (digitMatch && (!inEditable || e.altKey)) {
          const idx = Number(e.key) - 1;
          if (idx >= 0 && idx < options.length) {
            e.preventDefault();
            void submitAnswer(options[idx].key, false, false, options[idx].key);
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactionKey, isChoice, isApproval, canDismiss, options.length]);

  if (!interaction) return null;

  const isSubmitting = submittingKey !== null;

  const heading = isApproval
    ? "Approval needed"
    : isChoice
    ? "Choose an option"
    : kind === "settings"
    ? "Configure"
    : "Question";

  const shellTone = isApproval
    ? "border-amber-400/25 bg-[#161414]/95"
    : isChoice
    ? "border-sky-400/25 bg-[#12141a]/95"
    : "border-white/[0.13] bg-[#141418]/95";

  const shortcutHint = isApproval
    ? canDismiss
      ? "⌘⏎ · Esc"
      : "⌘⏎"
    : isChoice
    ? options.length > 1
      ? `1–${Math.min(options.length, 9)}${canDismiss ? " · Esc" : ""}`
      : `1${canDismiss ? " · Esc" : ""}`
    : canDismiss
    ? "Enter below · Esc"
    : "Enter below";

  return (
    <div
      className={`${compact ? "" : "mx-auto max-w-3xl"} mb-2 animate-peer-content-swap`}
      role="region"
      aria-label={heading}
    >
      <div
        className={`overflow-hidden rounded-2xl border ${shellTone} shadow-[0_-6px_24px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-md`}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.025] px-3.5 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {isApproval ? (
              <ShieldWarning size={14} weight="fill" className="shrink-0 text-amber-400" />
            ) : isChoice ? (
              <ListChecks size={14} weight="bold" className="shrink-0 text-sky-400" />
            ) : kind === "settings" ? (
              <SlidersHorizontal size={14} className="shrink-0 text-zinc-300" />
            ) : (
              <ChatCircleDots size={14} weight="fill" className="shrink-0 text-sky-400" />
            )}
            <span className="text-[12px] font-medium text-zinc-100 truncate">
              {heading}
            </span>
            {sourceLabel && (
              <span className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10.5px] text-zinc-400 truncate max-w-[140px]">
                {sourceLabel}
              </span>
            )}
            {toolName && (
              <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-200/90 truncate max-w-[160px]">
                {toolName}
              </span>
            )}
            {queueCount > 1 && (
              <span className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 shrink-0">
                1 / {queueCount}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {canDismiss && queueCount > 1 && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void submitAnswer("", true, true, "__dismiss_all__")}
                className="text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
              >
                Dismiss all ({queueCount})
              </button>
            )}
            <span className="hidden sm:inline font-mono text-[10px] text-zinc-500 select-none">
              {shortcutHint}
            </span>
            {canDismiss && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void submitAnswer("", true, false, "__dismiss__")}
                title={isApproval ? "Decline" : "Dismiss"}
                aria-label={isApproval ? "Decline" : "Dismiss"}
                className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-3.5 py-2.5">
          {interaction.prompt && (
            <div className="max-h-40 overflow-y-auto pr-1 text-[13px] leading-relaxed text-zinc-100 selectable-text">
              <MarkdownBlock text={interaction.prompt} onOpenFile={onOpenFile} />
            </div>
          )}

          {/* Choice list */}
          {isChoice && (
            <div className="mt-2.5 flex flex-col gap-1.5">
              {options.map((opt, idx) => {
                const keyBadge =
                  opt.key && opt.key.length <= 3 ? opt.key : String(idx + 1);
                const selectedThis = submittingKey === opt.key;
                return (
                  <button
                    key={`${opt.key}-${idx}`}
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void submitAnswer(opt.key, false, false, opt.key)}
                    className={`group flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-all cursor-pointer disabled:cursor-default ${
                      selectedThis
                        ? "border-sky-400/50 bg-sky-400/15 text-white"
                        : "border-white/[0.08] bg-white/[0.03] hover:border-sky-400/35 hover:bg-sky-400/[0.08] disabled:opacity-45"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-md border px-1 font-mono text-[11px] transition-colors ${
                        selectedThis
                          ? "border-sky-400/50 bg-sky-400/20 text-sky-200"
                          : "border-white/[0.1] bg-white/[0.05] text-zinc-400 group-hover:border-sky-400/40 group-hover:bg-sky-400/15 group-hover:text-sky-200"
                      }`}
                    >
                      {keyBadge}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium leading-snug text-zinc-100 group-hover:text-white">
                        {opt.label}
                      </div>
                      {opt.description && (
                        <div className="mt-0.5 text-[11.5px] leading-snug text-zinc-400">
                          {opt.description}
                        </div>
                      )}
                    </div>
                    <ArrowRight
                      size={13}
                      className="mt-1 shrink-0 text-zinc-500 opacity-0 group-hover:opacity-100 group-hover:text-sky-300 transition-opacity"
                    />
                  </button>
                );
              })}

              {allowFreeChat && (
                <div className="mt-0.5 flex items-center justify-between pt-1 text-[11px] text-zinc-500">
                  <button
                    type="button"
                    onClick={() => onFocusInput?.()}
                    className="text-left hover:text-zinc-300 transition-colors cursor-pointer"
                  >
                    Select an option above, or type a custom reply below
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Approval action bar */}
          {isApproval && (
            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2.5">
              <button
                type="button"
                onClick={() => onFocusInput?.()}
                className="text-[11.5px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              >
                {allowFreeChat
                  ? "Confirm below, or type custom instructions in the input"
                  : "Confirm to proceed"}
              </button>
              <div className="flex items-center gap-1.5">
                {options.length > 0 ? (
                  options.map((opt, idx) => {
                    const isPrimary = idx === 0;
                    return (
                      <button
                        key={`${opt.key}-${idx}`}
                        type="button"
                        disabled={isSubmitting}
                        onClick={() => void submitAnswer(opt.key, false, false, opt.key)}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 cursor-pointer ${
                          isPrimary
                            ? "bg-zinc-100 text-zinc-950 hover:bg-white"
                            : "border border-white/[0.1] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.09]"
                        }`}
                      >
                        {isPrimary && <Check size={12} weight="bold" />}
                        <span>{opt.label}</span>
                      </button>
                    );
                  })
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() =>
                        void submitAnswer(canDismiss ? "" : "no", canDismiss, false, "no")
                      }
                      className="rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-[12px] font-medium text-zinc-300 hover:bg-white/[0.08] hover:text-white disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => void submitAnswer("yes", false, false, "yes")}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-100 px-3 py-1.5 text-[12px] font-medium text-zinc-950 hover:bg-white disabled:opacity-40 transition-colors cursor-pointer"
                    >
                      <Check size={12} weight="bold" />
                      <span>Approve</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Free-reply Ask footer */}
          {!isApproval && !isChoice && (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.05] pt-2">
              <button
                type="button"
                onClick={() => onFocusInput?.()}
                className="inline-flex items-center gap-1.5 text-[11.5px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400/90 animate-pulse" />
                <span>Type your reply below and press Enter</span>
              </button>
              {canDismiss && (
                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => void submitAnswer("", true, false, "__dismiss__")}
                  className="rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
