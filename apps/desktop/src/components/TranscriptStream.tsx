import React, { useEffect, useRef, useState } from "react";
import {
  Brain,
  CaretDown,
  CaretRight,
  CheckCircle,
  CirclesThreePlus,
  Lightning,
  Question,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import type { PendingInteraction, TranscriptEntry } from "../types";
import { MarkdownBlock } from "./MarkdownBlock";

interface TranscriptStreamProps {
  entries: TranscriptEntry[];
  planLines?: string[];
  pendingInteraction?: PendingInteraction | null;
  onRespondInteraction?: (answer: string, cancelled?: boolean) => void;
  onOpenFile?: (path: string) => void;
  onInspectWorkerInSide?: (agentHint: string) => void;
  compact?: boolean;
  emptyTitle?: string;
  emptySubtitle?: string;
}

function CollapsibleThinking({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(Boolean(entry.expanded));
  return (
    <div className="my-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <Brain size={13} className="text-zinc-400" />
        <span className="font-medium">Reasoning</span>
        {!open && entry.text && (
          <span className="truncate text-zinc-500 font-normal">
            {entry.text.replace(/\s+/g, " ").slice(0, 88)}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-white/[0.05] px-3.5 py-2.5 text-[12.5px] leading-relaxed text-zinc-400 whitespace-pre-wrap font-mono selectable-text">
          {entry.text}
        </div>
      )}
    </div>
  );
}

function CollapsibleToolRow({
  entry,
  onOpenFile,
}: {
  entry: TranscriptEntry;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(Boolean(entry.expanded));
  const cleanSummary = entry.text.replace(/\s*\(Ctrl\+O expand\)\s*$/i, "");
  const hasDetail = Boolean(entry.detail && entry.detail.trim());

  return (
    <div className="my-1 rounded-lg border border-white/[0.05] bg-zinc-900/50">
      <button
        type="button"
        onClick={() => hasDetail && setOpen(!open)}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-zinc-300 ${
          hasDetail ? "hover:bg-white/[0.03] cursor-pointer" : "cursor-default"
        }`}
      >
        {hasDetail ? (
          open ? <CaretDown size={11} className="text-zinc-500" /> : <CaretRight size={11} className="text-zinc-500" />
        ) : (
          <TerminalWindow size={12} className="text-zinc-500" />
        )}
        <span className="font-mono text-[12px] text-zinc-300 truncate">{cleanSummary}</span>
      </button>
      {open && hasDetail && (
        <div className="border-t border-white/[0.05] bg-black/30 px-3 py-2 font-mono text-[11.5px] leading-relaxed text-zinc-400 whitespace-pre-wrap overflow-x-auto selectable-text">
          <MarkdownBlock text={entry.detail || ""} onOpenFile={onOpenFile} />
        </div>
      )}
    </div>
  );
}

function InteractionCard({
  interaction,
  onRespond,
}: {
  interaction: PendingInteraction;
  onRespond?: (answer: string, cancelled?: boolean) => void;
}) {
  const [customReply, setCustomReply] = useState("");

  return (
    <div className="my-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
      <div className="rounded-[12px] bg-zinc-950/90 p-3.5">
        <div className="flex items-center gap-2 text-[12px] font-medium text-amber-400 mb-2">
          <Question size={15} weight="fill" />
          <span>Confirmation Required</span>
        </div>
        <div className="text-[13.5px] text-zinc-100 leading-relaxed mb-3 whitespace-pre-wrap selectable-text">
          {interaction.prompt}
        </div>
        {Array.isArray(interaction.options) && interaction.options.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {interaction.options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => onRespond?.(opt.key)}
                className="rounded-lg border border-white/[0.1] bg-white/[0.05] px-3 py-1.5 text-[12.5px] font-medium text-zinc-100 hover:border-blue-400/50 hover:bg-blue-500/15 active:scale-[0.98] transition-all cursor-pointer"
              >
                <span className="text-zinc-400 font-mono mr-1.5">{opt.key}.</span>
                {opt.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={customReply}
            onChange={(e) => setCustomReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && customReply.trim()) {
                onRespond?.(customReply.trim());
                setCustomReply("");
              }
            }}
            placeholder="Type an explicit answer or choose above…"
            className="flex-1 rounded-lg border border-white/[0.08] bg-zinc-900 px-3 py-1.5 text-[12.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-blue-500/50 focus:outline-none"
          />
          <button
            type="button"
            disabled={!customReply.trim()}
            onClick={() => {
              if (customReply.trim()) {
                onRespond?.(customReply.trim());
                setCustomReply("");
              }
            }}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-blue-500 disabled:opacity-40 transition-colors cursor-pointer"
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );
}

export function TranscriptStream({
  entries,
  planLines = [],
  pendingInteraction = null,
  onRespondInteraction,
  onOpenFile,
  onInspectWorkerInSide,
  compact = false,
  emptyTitle = "Ready to coordinate",
  emptySubtitle = "Ask ufoo agent to code directly, launch internal workers, or orchestrate a group.",
}: TranscriptStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, entries[entries.length - 1]?.text, pendingInteraction?.id]);

  return (
    <div className="flex-1 overflow-y-auto">
      {planLines.length > 0 && (
        <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-zinc-950/90 backdrop-blur-md px-4 py-2">
          <div className="flex items-center gap-2 text-[11.5px] font-medium text-zinc-400 mb-1">
            <CheckCircle size={13} className="text-blue-400" />
            <span>Active Plan</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {planLines.map((line, i) => (
              <span key={i} className="font-mono text-[11.5px] text-zinc-300">
                {line}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className={`mx-auto ${compact ? "px-3.5 py-3" : "max-w-3xl px-6 py-5"} space-y-3`}>
        {entries.length === 0 && !pendingInteraction && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03] text-zinc-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
              <CirclesThreePlus size={22} weight="duotone" />
            </div>
            <div className="text-[14.5px] font-medium text-zinc-200">{emptyTitle}</div>
            <div className="mt-1 max-w-md text-[12.5px] leading-relaxed text-zinc-500">
              {emptySubtitle}
            </div>
          </div>
        )}

        {entries.map((entry) => {
          if (entry.kind === "spacer" || entry.kind === "banner") return null;

          if (entry.kind === "thinking") {
            return <CollapsibleThinking key={entry.id} entry={entry} />;
          }

          if (entry.kind === "tool") {
            return <CollapsibleToolRow key={entry.id} entry={entry} onOpenFile={onOpenFile} />;
          }

          if (entry.kind === "user") {
            return (
              <div key={entry.id} className="flex justify-end pt-2">
                <div className="max-w-[85%] rounded-2xl rounded-br-md border border-white/[0.08] bg-zinc-800/85 px-4 py-2.5 text-[13.5px] leading-relaxed text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] selectable-text whitespace-pre-wrap">
                  {entry.text}
                </div>
              </div>
            );
          }

          if (entry.kind === "error") {
            return (
              <div
                key={entry.id}
                className="flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-rose-300 selectable-text"
              >
                <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-rose-400" />
                <div className="whitespace-pre-wrap">{entry.text}</div>
              </div>
            );
          }

          if (entry.kind === "system" || entry.kind === "meta" || entry.kind === "success") {
            const launchedMatch = entry.text.match(/Launched\s+[a-z0-9-]+:([^\s]+)/i);
            return (
              <div
                key={entry.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-1.5 text-[12px] text-zinc-400 selectable-text"
              >
                <span className="font-mono truncate">{entry.text}</span>
                {launchedMatch && onInspectWorkerInSide && (
                  <button
                    type="button"
                    onClick={() => onInspectWorkerInSide(launchedMatch[1])}
                    className="shrink-0 rounded bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-400 hover:bg-blue-500/25 transition-colors cursor-pointer"
                  >
                    Open in Side
                  </button>
                )}
              </div>
            );
          }

          // Assistant / Agent / Report message
          return (
            <div key={entry.id} className="pt-1">
              {(entry.speaker || entry.kind === "report") && (
                <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
                  <Lightning size={12} weight="fill" className="text-blue-400" />
                  <span>{entry.speaker || "ufoo"}</span>
                  {entry.streaming && (
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
                  )}
                </div>
              )}
              <div className="pl-0.5">
                <MarkdownBlock text={entry.text} onOpenFile={onOpenFile} />
              </div>
            </div>
          );
        })}

        {pendingInteraction && (
          <InteractionCard interaction={pendingInteraction} onRespond={onRespondInteraction} />
        )}
        <div ref={bottomRef} className="h-2" />
      </div>
    </div>
  );
}
