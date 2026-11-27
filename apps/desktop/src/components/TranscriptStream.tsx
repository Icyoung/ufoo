import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, CaretRight, CaretUp, Check, Copy, Eraser, FileText, Image as ImageIcon, X } from "@phosphor-icons/react";
import type { PendingInteraction, SessionChangedFile, TranscriptEntry } from "../types";
import { BrandIcon } from "./BrandIcon";
import { MarkdownBlock } from "./MarkdownBlock";

const ufooWatermarkSrc = new URL("../assets/ufoo-watermark.png", import.meta.url).href;

interface TranscriptStreamProps {
  entries: TranscriptEntry[];
  planLines?: string[];
  pendingInteraction?: PendingInteraction | null;
  onRespondInteraction?: (answer: string, cancelled?: boolean, dismissAll?: boolean) => void;
  onOpenFile?: (path: string) => void;
  onInspectWorkerInSide?: (agentHint: string) => void;
  onClearConversation?: () => Promise<void> | void;
  busy?: boolean;
  statusText?: string;
  changedFiles?: SessionChangedFile[];
  defaultSpeaker?: string;
  defaultSpeakerBrand?: string;
  defaultSpeakerColor?: string;
  workerBrandMap?: Record<string, string>;
  workerColorMap?: Record<string, string>;
  compact?: boolean;
  emptyHint?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
}

function normalizeSpeakerDisplay(raw?: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^ufoo-agent$/i.test(s) || s.endsWith(":ufoo-agent")) return "ufoo";
  return s;
}

function parseAttributedSpeakerLine(raw: string): { speaker: string; body: string } | null {
  const match = String(raw || "").match(/^([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,47})\s*·\s+([\s\S]+)$/);
  if (!match) return null;
  const speaker = match[1].trim();
  const body = match[2].replace(/^\n+/, "");
  if (!speaker || !body.trim()) return null;
  // Avoid mis-parsing generic status prefixes like "Cron · ..." or "Error · ..."
  if (/^(?:cron|loop|error|warning|info|status|system|session|settings|worktree|branch|git|http|https)$/i.test(speaker)) {
    return null;
  }
  return { speaker, body };
}

function cleanToolSummary(raw: string): string {
  let text = String(raw || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/^\s*•\s*/, "")
    .replace(/\s*\(Ctrl\+O expand\)\s*$/i, "")
    .trim();
  // Unwrap noisy shell wrappers like `/bin/zsh -lc '...'` or `/bin/bash -lc "..."`
  const shellMatch = text.match(
    /^((?:Failed:\s*)?(?:Ran|Run|Bash|Exec)\s+)(?:\/usr\/bin\/env\s+)?(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|cl|c)\s+([\s\S]+)$/i
  );
  if (shellMatch) {
    let inner = shellMatch[2].trim();
    if (
      (inner.startsWith("\"") && inner.endsWith("\"") && inner.length >= 2) ||
      (inner.startsWith("'") && inner.endsWith("'") && inner.length >= 2)
    ) {
      inner = inner.slice(1, -1);
    } else if (inner.startsWith("\"") || inner.startsWith("'")) {
      inner = inner.slice(1);
    }
    text = `${shellMatch[1]}${inner}`;
  }
  return text.replace(/\s+/g, " ").trim() || "Tool call";
}

function stripAnsi(raw: string): string {
  return String(raw || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function splitFileDisplay(relPath: string): { name: string; dir: string } {
  const clean = String(relPath || "").replace(/\\/g, "/");
  const idx = clean.lastIndexOf("/");
  if (idx === -1) return { name: clean, dir: "" };
  return { name: clean.slice(idx + 1), dir: clean.slice(0, idx) };
}

function describeClusterSummary(items: TranscriptEntry[]): string {
  const tools = items.filter((i) => i.kind === "tool");
  const thoughts = items.filter((i) => i.kind === "thinking");
  if (tools.length === 0) {
    return thoughts.length > 1 ? `Thought (${thoughts.length} steps)` : "Thought";
  }

  let commands = 0;
  let edits = 0;
  let reads = 0;
  let messages = 0;
  let other = 0;
  for (const t of tools) {
    const name = String(t.tool_name || "").toLowerCase();
    const text = cleanToolSummary(t.text).toLowerCase();
    if (name === "bash" || name === "shell" || text.startsWith("bash ") || text.startsWith("ran ") || text.startsWith("failed: bash ") || text.startsWith("failed: ran ")) {
      commands += 1;
    } else if (
      /patch|edit|write|create|delete/.test(name) ||
      /^(?:edit|edited|apply patch|patched|write|wrote|updated|created|deleted)\b/.test(text)
    ) {
      edits += 1;
    } else if (/read|grep|glob|search|find|list|ls/.test(name) || /^(?:read|grep|glob|explored|searched|listed)\b/.test(text)) {
      reads += 1;
    } else if (/dispatch_message|report_agent_status/.test(name) || /^(?:send message|report status)\b/.test(text)) {
      messages += 1;
    } else {
      other += 1;
    }
  }

  const parts: string[] = [];
  if (thoughts.length > 0 && tools.length <= 2) parts.push("Thought");
  if (commands > 0) parts.push(`${commands} ${commands === 1 ? "command" : "commands"}`);
  if (edits > 0) parts.push(`${edits} ${edits === 1 ? "edit" : "edits"}`);
  if (reads > 0) parts.push(`${reads} ${reads === 1 ? "read" : "reads"}`);
  if (messages > 0) parts.push(`${messages} ${messages === 1 ? "agent msg" : "agent msgs"}`);
  if (other > 0) parts.push(`${other} ${other === 1 ? "tool" : "tools"}`);

  if (tools.length === 1 && thoughts.length === 0) {
    return cleanToolSummary(tools[0].text);
  }
  const lead = `${tools.length} ${tools.length === 1 ? "step" : "steps"}`;
  return parts.length > 0 ? `${lead} · ${parts.join(", ")}` : lead;
}

function Spinner({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-zinc-400 border-t-transparent ${className}`}
    />
  );
}

function ActivityStepRow({
  entry,
  onOpenFile,
}: {
  entry: TranscriptEntry;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (entry.kind === "thinking") {
    const preview = stripAnsi(entry.text || "").replace(/\s+/g, " ").trim();
    return (
      <div className="text-[11.5px]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200 transition-colors cursor-pointer"
        >
          {open ? <CaretDown size={10} className="shrink-0 text-zinc-500" /> : <CaretRight size={10} className="shrink-0 text-zinc-500" />}
          <span className="font-medium text-zinc-400 shrink-0">Thought</span>
          {!open && preview && <span className="truncate text-zinc-500">{preview.slice(0, 96)}</span>}
        </button>
        {open && preview && (
          <div className="ml-4 mt-1 mb-1.5 rounded-lg border border-white/[0.05] bg-black/25 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap selectable-text">
            {stripAnsi(entry.text || "")}
          </div>
        )}
      </div>
    );
  }

  const summary = cleanToolSummary(entry.text);
  const detail = stripAnsi(entry.detail || "").trim();
  const hasDetail = detail.length > 0 && detail !== summary;
  const isRunning = entry.tool_status === "running";
  const isError = entry.tool_status === "error" || /^failed:/i.test(summary);

  return (
    <div className="text-[11.5px]">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${
          hasDetail ? "hover:bg-white/[0.04] cursor-pointer" : "cursor-default"
        }`}
      >
        {isRunning ? (
          <Spinner className="h-2.5 w-2.5" />
        ) : isError ? (
          <X size={11} weight="bold" className="shrink-0 text-rose-400" />
        ) : (
          <Check size={11} weight="bold" className="shrink-0 text-zinc-500" />
        )}
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${
            isRunning ? "text-zinc-100" : isError ? "text-rose-300" : "text-zinc-400"
          }`}
        >
          {summary}
        </span>
        {hasDetail && (
          <span className="shrink-0 text-zinc-600">
            {open ? <CaretDown size={10} /> : <CaretRight size={10} />}
          </span>
        )}
      </button>
      {open && hasDetail && (
        <div className="ml-5 mt-1 mb-1.5 max-h-64 overflow-auto rounded-lg border border-white/[0.05] bg-black/35 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-400 whitespace-pre-wrap selectable-text">
          <MarkdownBlock text={detail} onOpenFile={onOpenFile} />
        </div>
      )}
    </div>
  );
}

function ActivityCluster({
  items,
  isLive,
  statusText,
  onOpenFile,
}: {
  items: TranscriptEntry[];
  isLive: boolean;
  statusText?: string;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tools = items.filter((i) => i.kind === "tool");
  const runningTool = [...tools].reverse().find((t) => t.tool_status === "running");
  const latestTool = runningTool || tools[tools.length - 1] || null;
  const latestItem = runningTool || items[items.length - 1];
  const errorCount = tools.filter((t) => t.tool_status === "error" || /^failed:/i.test(cleanToolSummary(t.text))).length;

  const liveHeadline = (() => {
    if (latestTool) return cleanToolSummary(latestTool.text);
    if (latestItem?.kind === "thinking") {
      const preview = stripAnsi(latestItem.text || "").replace(/\s+/g, " ").trim();
      return preview ? `Thinking · ${preview.slice(0, 72)}` : "Thinking…";
    }
    return statusText || "Working…";
  })();

  const completedSummary = describeClusterSummary(items);

  return (
    <div className="my-1">
      {isLive ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-left transition-colors hover:bg-white/[0.05] cursor-pointer"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Spinner className="h-3 w-3" />
            <span className="truncate font-mono text-[12px] text-zinc-200">{liveHeadline}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-500">
            {tools.length > 0 && (
              <span className="font-mono">
                {tools.length} {tools.length === 1 ? "step" : "steps"}
              </span>
            )}
            {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
          </div>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1 text-left text-[11.5px] text-zinc-400 hover:border-white/[0.11] hover:bg-white/[0.05] hover:text-zinc-200 transition-colors cursor-pointer"
        >
          {expanded ? (
            <CaretDown size={11} className="shrink-0 text-zinc-400" />
          ) : (
            <CaretRight size={11} className="shrink-0 text-zinc-400" />
          )}
          <span className="truncate font-mono">{completedSummary}</span>
          {errorCount > 0 && (
            <span className="shrink-0 text-[11px] text-rose-400">· {errorCount} failed</span>
          )}
        </button>
      )}

      {expanded && (
        <div className="ml-2 mt-1 border-l border-white/[0.08] pl-2.5 py-0.5 space-y-0.5">
          {items.map((item) => (
            <ActivityStepRow key={item.id} entry={item} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

const DEFAULT_VISIBLE_TURN_FILES = 5;

function TurnFilesEditedCard({
  files,
  onOpenFile,
}: {
  files: SessionChangedFile[];
  onOpenFile?: (path: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!files || files.length === 0) return null;

  const badgeStyle = (kind: string) => {
    const k = String(kind || "").toLowerCase();
    if (k === "added" || k === "add") return { letter: "A", cls: "text-emerald-400" };
    if (k === "deleted" || k === "delete") return { letter: "D", cls: "text-rose-400" };
    return { letter: "M", cls: "text-amber-400" };
  };

  const visible = showAll ? files : files.slice(0, DEFAULT_VISIBLE_TURN_FILES);
  const hiddenCount = Math.max(0, files.length - visible.length);

  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <div className="flex items-center justify-between border-b border-white/[0.05] px-3 py-1.5 text-[11px]">
        <span className="font-medium text-zinc-400">Files Edited</span>
        <span className="font-mono text-[10.5px] text-zinc-500">
          {files.length} {files.length === 1 ? "file" : "files"}
        </span>
      </div>
      <div className="divide-y divide-white/[0.04]">
        {visible.map((file) => {
          const { name, dir } = splitFileDisplay(file.path);
          const badge = badgeStyle(file.kind);
          return (
            <button
              key={file.path}
              type="button"
              onClick={() => onOpenFile?.(file.open_path || file.path)}
              title={`Open ${file.path} in Docs`}
              className="flex w-full items-center justify-between gap-2.5 px-3 py-1.5 text-left hover:bg-white/[0.045] transition-colors cursor-pointer"
            >
              <div className="flex min-w-0 items-baseline gap-2 font-mono text-[11.5px]">
                <span className={`shrink-0 text-[10.5px] font-semibold ${badge.cls}`}>{badge.letter}</span>
                <span className="truncate text-zinc-200">{name}</span>
                {dir && <span className="truncate text-[10.5px] text-zinc-500">{dir}</span>}
              </div>
              {(file.additions !== undefined || file.deletions !== undefined) && (
                <div className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px]">
                  {file.additions ? <span className="text-emerald-400">+{file.additions}</span> : null}
                  {file.deletions ? <span className="text-rose-400">-{file.deletions}</span> : null}
                </div>
              )}
            </button>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex w-full items-center justify-center border-t border-white/[0.05] py-1.5 text-[11px] text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Show {hiddenCount} more {hiddenCount === 1 ? "file" : "files"}
        </button>
      )}
    </div>
  );
}

function InteractionCard({
  interaction,
  onRespond,
  onOpenFile,
}: {
  interaction: PendingInteraction;
  onRespond?: (answer: string, cancelled?: boolean, dismissAll?: boolean) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [customReply, setCustomReply] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setCustomReply("");
    setSubmitting(false);
  }, [interaction.id]);

  const submitAnswer = (answer: string, cancelled = false, dismissAll = false) => {
    if (submitting) return;
    setSubmitting(true);
    onRespond?.(answer, cancelled, dismissAll);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.key === "Escape") {
        e.preventDefault();
        submitAnswer("", true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (customReply.trim()) {
          const text = customReply.trim();
          setCustomReply("");
          submitAnswer(text, false);
        } else if (interaction.options && interaction.options.length > 0) {
          submitAnswer(interaction.options[0].key, false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interaction.id, interaction.options, customReply, submitting]);

  const kind = String(interaction.kind || "").toLowerCase();
  const heading =
    kind === "approval"
      ? "Approval needed"
      : kind === "choice"
      ? "Input needed"
      : kind === "settings"
      ? "Configure"
      : "Waiting for reply";
  const dismissLabel = kind === "approval" ? "Decline" : "Dismiss";
  const queueCount = Number(interaction.queue_count) || 1;
  const options = Array.isArray(interaction.options) ? interaction.options : [];
  const allowFreeChat = interaction.allowFreeChat !== false;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/[0.1] bg-[#141417]">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] bg-white/[0.02] px-3.5 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[12px] font-medium text-zinc-200">{heading}</span>
          {queueCount > 1 && (
            <span className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
              1 / {queueCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {queueCount > 1 && (
            <button
              type="button"
              disabled={submitting}
              onClick={() => submitAnswer("", true, true)}
              className="text-[11px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
            >
              Dismiss all ({queueCount})
            </button>
          )}
          <span className="font-mono text-[10px] text-zinc-600 select-none">
            ⌘⏎ · Esc
          </span>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submitAnswer("", true)}
            title={dismissLabel}
            aria-label={dismissLabel}
            className="flex h-5 w-5 items-center justify-center rounded-md text-zinc-500 hover:bg-white/[0.07] hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="space-y-3 px-3.5 py-3">
        <div className="text-[13px] leading-relaxed text-zinc-200 selectable-text">
          <MarkdownBlock text={interaction.prompt} onOpenFile={onOpenFile} />
        </div>

        {options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {options.map((opt, idx) => (
              <button
                key={opt.key}
                type="button"
                disabled={submitting}
                onClick={() => submitAnswer(opt.key, false)}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 cursor-pointer ${
                  idx === 0
                    ? "bg-zinc-100 text-zinc-950 hover:bg-white"
                    : "border border-white/[0.1] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.09]"
                }`}
              >
                <span className={`font-mono mr-1.5 ${idx === 0 ? "text-zinc-500" : "text-zinc-500"}`}>
                  {opt.key}.
                </span>
                {opt.label}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          {allowFreeChat && (
            <input
              type="text"
              disabled={submitting}
              value={customReply}
              onChange={(e) => setCustomReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && customReply.trim()) {
                  const text = customReply.trim();
                  setCustomReply("");
                  submitAnswer(text, false);
                }
              }}
              placeholder={options.length > 0 ? "Or type a reply…" : "Type your reply…"}
              className="flex-1 rounded-lg border border-white/[0.08] bg-black/30 px-3 py-1.5 text-[12.5px] text-zinc-100 placeholder:text-zinc-500 focus:border-white/[0.2] focus:outline-none disabled:opacity-40"
            />
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={() => submitAnswer("", true)}
            className="rounded-lg border border-white/[0.08] bg-transparent px-2.5 py-1.5 text-[12px] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 disabled:opacity-40 transition-colors cursor-pointer"
          >
            {dismissLabel}
          </button>
          {allowFreeChat && (
            <button
              type="button"
              disabled={submitting || !customReply.trim()}
              onClick={() => {
                if (customReply.trim()) {
                  const text = customReply.trim();
                  setCustomReply("");
                  submitAnswer(text, false);
                }
              }}
              className="rounded-lg bg-zinc-100 px-3 py-1.5 text-[12px] font-medium text-zinc-950 hover:bg-white disabled:opacity-35 transition-colors cursor-pointer"
            >
              Reply
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ParsedAttachmentTag {
  kind: "image" | "file";
  name: string;
}

interface PeerAgentMessage {
  entry: TranscriptEntry;
  speakerKey: string;
  speakerLabel: string;
  rawSpeaker: string;
  senderId: string;
  senderType: string;
  bodyText: string;
  attachments: ParsedAttachmentTag[];
  streaming: boolean;
}

function parseUserAttachmentTags(raw: string): {
  bodyText: string;
  attachments: ParsedAttachmentTag[];
} {
  const parsedAtts: ParsedAttachmentTag[] = [];
  const lines = raw.split("\n");
  const lastLine = lines[lines.length - 1] || "";
  let bodyText = raw;
  const tagRegex = /\[(image|file):\s*([^\]]+)\]/g;
  if (lastLine.trim() && lastLine.replace(tagRegex, "").trim() === "") {
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(lastLine)) !== null) {
      parsedAtts.push({
        kind: m[1] === "image" ? "image" : "file",
        name: m[2].trim(),
      });
    }
    if (parsedAtts.length > 0) {
      bodyText = lines.slice(0, -1).join("\n").trimEnd();
    }
  }
  return { bodyText, attachments: parsedAtts };
}

function isExternalUserSender(entry: TranscriptEntry): boolean {
  const senderKind = entry.sender_kind || "user";
  return (
    senderKind === "peer" ||
    senderKind === "coordinator" ||
    Boolean(entry.sender_id && senderKind !== "user")
  );
}

function extractPeerAgentMessage(
  entry: TranscriptEntry,
  defaultSpeakerNorm: string
): PeerAgentMessage | null {
  const cleanText = stripAnsi(entry.text || "");

  // 1. Incoming peer / coordinator bus message delivered on kind="user"
  if (entry.kind === "user") {
    if (!isExternalUserSender(entry)) return null;
    const senderKind = entry.sender_kind || "peer";
    const rawSenderLabel =
      entry.sender_label ||
      (senderKind === "coordinator" ? "ufoo" : entry.sender_id || "agent");
    const speakerLabel = normalizeSpeakerDisplay(rawSenderLabel) || "agent";
    const { bodyText, attachments } = parseUserAttachmentTags(cleanText);
    const senderId = String(entry.sender_id || "").trim();
    const senderType = String(entry.sender_type || (senderKind === "coordinator" ? "ufoo" : "")).trim();
    return {
      entry,
      speakerKey: (speakerLabel || senderId).toLowerCase(),
      speakerLabel,
      rawSpeaker: rawSenderLabel,
      senderId,
      senderType,
      bodyText,
      attachments,
      streaming: Boolean(entry.streaming),
    };
  }

  // 2. Attributed system/meta/success lines from another agent (e.g. "backend · ...")
  if (entry.kind === "system" || entry.kind === "meta" || entry.kind === "success") {
    const attributed = parseAttributedSpeakerLine(cleanText);
    if (!attributed) return null;
    const speakerLabel = normalizeSpeakerDisplay(attributed.speaker);
    if (!speakerLabel) return null;
    if (defaultSpeakerNorm && speakerLabel.toLowerCase() === defaultSpeakerNorm) return null;
    const senderId = String(entry.sender_id || "").trim();
    return {
      entry,
      speakerKey: (speakerLabel || senderId).toLowerCase(),
      speakerLabel,
      rawSpeaker: attributed.speaker,
      senderId,
      senderType: String(entry.sender_type || "").trim(),
      bodyText: attributed.body,
      attachments: [],
      streaming: Boolean(entry.streaming),
    };
  }

  // 3. Assistant / Agent / Report / Bus entries authored by another agent (speaker !== defaultSpeaker)
  if (
    entry.kind === "assistant" ||
    entry.kind === "agent" ||
    entry.kind === "report" ||
    entry.kind === "bus"
  ) {
    const attributedFallback = !entry.speaker ? parseAttributedSpeakerLine(cleanText) : null;
    const rawSpeaker = entry.speaker || attributedFallback?.speaker || "";
    const speakerLabel = normalizeSpeakerDisplay(rawSpeaker);
    if (!speakerLabel) return null;
    if (defaultSpeakerNorm && speakerLabel.toLowerCase() === defaultSpeakerNorm) return null;
    const displayBody = attributedFallback ? attributedFallback.body : cleanText;
    const senderId = String(entry.sender_id || "").trim();
    return {
      entry,
      speakerKey: (speakerLabel || senderId).toLowerCase(),
      speakerLabel,
      rawSpeaker,
      senderId,
      senderType: String(entry.sender_type || "").trim(),
      bodyText: displayBody,
      attachments: [],
      streaming: Boolean(entry.streaming),
    };
  }

  return null;
}

function PeerAgentAttachments({
  attachments,
  hasBody,
}: {
  attachments: ParsedAttachmentTag[];
  hasBody: boolean;
}) {
  if (!attachments.length) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${hasBody ? "mt-2" : ""}`}>
      {attachments.map((att, idx) => (
        <span
          key={`${att.name}-${idx}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-black/25 px-2 py-1 text-[11.5px] text-zinc-200"
        >
          {att.kind === "image" ? (
            <ImageIcon size={12} className="shrink-0 text-zinc-400" />
          ) : (
            <FileText size={12} className="shrink-0 text-zinc-400" />
          )}
          <span className="max-w-[180px] truncate">{att.name}</span>
        </span>
      ))}
    </div>
  );
}

const MAX_VISIBLE_STACKED_AVATARS = 6;

function PeerAgentStackCard({
  items,
  resolveSpeakerBrand,
  resolveSpeakerColor,
  onOpenFile,
}: {
  items: PeerAgentMessage[];
  resolveSpeakerBrand: (speakerName?: string, explicitBrand?: string) => string;
  resolveSpeakerColor: (speakerName?: string, senderId?: string, explicitColor?: string) => string;
  onOpenFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Single peer message renders cleanly without unnecessary stack chrome
  if (items.length === 1) {
    const only = items[0];
    const brand = resolveSpeakerBrand(only.rawSpeaker, only.senderType);
    const color = resolveSpeakerColor(only.rawSpeaker, only.senderId);
    return (
      <div className="pt-1">
        <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
          <BrandIcon brand={brand} color={color} size={14} />
          <span>{only.speakerLabel}</span>
          {only.streaming && <Spinner className="h-2.5 w-2.5" />}
        </div>
        {only.bodyText && (
          <div className="pl-0.5">
            <MarkdownBlock text={only.bodyText} onOpenFile={onOpenFile} />
          </div>
        )}
        <div className="pl-0.5">
          <PeerAgentAttachments attachments={only.attachments} hasBody={Boolean(only.bodyText)} />
        </div>
      </div>
    );
  }

  const latest = items[items.length - 1];

  // Build unique avatar stack ordered newest-first so index 0 is LEFTMOST and HIGHEST z-index
  const stackedSpeakers: Array<{
    key: string;
    label: string;
    brand: string;
    color: string;
    latestEntryId: string;
  }> = [];
  const seenKeys = new Set<string>();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (seenKeys.has(item.speakerKey)) continue;
    seenKeys.add(item.speakerKey);
    stackedSpeakers.push({
      key: item.speakerKey,
      label: item.speakerLabel,
      brand: resolveSpeakerBrand(item.rawSpeaker, item.senderType),
      color: resolveSpeakerColor(item.rawSpeaker, item.senderId),
      latestEntryId: item.entry.id,
    });
  }

  const visibleAvatars = stackedSpeakers.slice(0, MAX_VISIBLE_STACKED_AVATARS);
  const overflowCount = Math.max(0, stackedSpeakers.length - visibleAvatars.length);
  const otherAgentsCount = Math.max(0, stackedSpeakers.length - 1);

  const handleCollapsedBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (expanded) return;
    const selection = window.getSelection?.()?.toString() || "";
    if (selection.trim()) return;
    const target = e.target as HTMLElement | null;
    if (target && target.closest("a, button, code, pre")) return;
    setExpanded(true);
  };

  return (
    <div
      className={`my-1.5 overflow-hidden rounded-2xl border transition-colors ${
        expanded
          ? "border-white/[0.11] bg-[#121216]/95 shadow-[0_8px_28px_rgba(0,0,0,0.35)]"
          : "border-white/[0.08] bg-white/[0.025] hover:border-white/[0.13] hover:bg-white/[0.035]"
      }`}
    >
      {/* Top Bar: Overlapping Avatars (leftmost on top) + Latest Speaker + Simple Expand/Collapse Icon */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse" : "Expand"}
        title={expanded ? "Collapse" : "Expand"}
        className={`flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors cursor-pointer ${
          expanded ? "border-b border-white/[0.07] bg-white/[0.02]" : "border-b border-white/[0.05]"
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {/* Overlapping Avatar Stack: Leftmost has highest z-index */}
          <div className="flex shrink-0 items-center" aria-label="Participating agents">
            {visibleAvatars.map((av, idx) => {
              const isTop = idx === 0;
              return (
                <span
                  key={isTop ? `${av.key}-${av.latestEntryId}` : av.key}
                  title={av.label}
                  style={{ zIndex: visibleAvatars.length + 2 - idx }}
                  className={`relative inline-flex h-6 w-6 items-center justify-center rounded-full ring-2 ring-[#111114] transition-all ${
                    idx > 0 ? "-ml-2" : ""
                  } ${
                    isTop
                      ? "bg-zinc-800/90 border border-white/[0.09] shadow-[0_2px_8px_rgba(0,0,0,0.45)] animate-peer-avatar-pop"
                      : "bg-zinc-900/95 border border-white/[0.05] opacity-80"
                  }`}
                >
                  <BrandIcon brand={av.brand} color={av.color} size={13} />
                </span>
              );
            })}
            {overflowCount > 0 && (
              <span
                style={{ zIndex: 1 }}
                className="relative -ml-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-zinc-900 px-1.5 font-mono text-[10px] font-medium text-zinc-400 ring-2 ring-[#111114]"
              >
                +{overflowCount}
              </span>
            )}
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-zinc-100">
              {latest.speakerLabel}
            </span>
            {latest.streaming && <Spinner className="h-2.5 w-2.5" />}
            <span className="truncate text-[11.5px] text-zinc-500">
              {otherAgentsCount > 0
                ? `+${otherAgentsCount} ${otherAgentsCount === 1 ? "agent" : "agents"} · ${items.length} updates`
                : `${items.length} updates`}
            </span>
          </div>
        </div>

        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors">
          {expanded ? <CaretUp size={13} /> : <CaretDown size={13} />}
        </span>
      </button>

      {/* Body: Latest Agent Message (collapsed) OR Full Chronological Conversation (expanded) */}
      {!expanded ? (
        <div
          key={latest.entry.id}
          onClick={handleCollapsedBodyClick}
          className="px-3.5 py-3 animate-peer-content-swap cursor-pointer"
        >
          {latest.bodyText && (
            <div className="text-[13px] leading-relaxed">
              <MarkdownBlock text={latest.bodyText} onOpenFile={onOpenFile} />
            </div>
          )}
          <PeerAgentAttachments
            attachments={latest.attachments}
            hasBody={Boolean(latest.bodyText)}
          />
        </div>
      ) : (
        <div className="space-y-4 px-3.5 py-3">
          {items.map((item) => {
            const brand = resolveSpeakerBrand(item.rawSpeaker, item.senderType);
            const color = resolveSpeakerColor(item.rawSpeaker, item.senderId);
            return (
              <div key={item.entry.id}>
                <div className="mb-1 flex items-center gap-2 min-w-0">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-900 ring-1 ring-white/[0.08]">
                    <BrandIcon brand={brand} color={color} size={12} />
                  </span>
                  <span className="truncate text-[12px] font-semibold text-zinc-200">
                    {item.speakerLabel}
                  </span>
                  {item.streaming && <Spinner className="h-2.5 w-2.5" />}
                </div>
                {item.bodyText && (
                  <div className="pl-7 text-[13px] leading-relaxed">
                    <MarkdownBlock text={item.bodyText} onOpenFile={onOpenFile} />
                  </div>
                )}
                <div className="pl-7">
                  <PeerAgentAttachments
                    attachments={item.attachments}
                    hasBody={Boolean(item.bodyText)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type StreamBlock =
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "cluster"; id: string; items: TranscriptEntry[] }
  | { type: "peer_cluster"; id: string; items: PeerAgentMessage[] };

interface ConversationTurn {
  id: string;
  userEntry: TranscriptEntry | null;
  blocks: StreamBlock[];
  editedFiles: SessionChangedFile[];
}

function groupConversationTurns(
  entries: TranscriptEntry[],
  sessionFallbackFiles: SessionChangedFile[],
  defaultSpeakerNorm = ""
): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let current: ConversationTurn | null = null;
  let currentFilesMap = new Map<string, SessionChangedFile>();
  const allSeenPaths = new Set<string>();

  const startTurn = (userEntry: TranscriptEntry | null, idx: number) => {
    currentFilesMap = new Map<string, SessionChangedFile>();
    current = {
      id: userEntry ? `turn-${userEntry.id}` : `turn-init-${idx}`,
      userEntry,
      blocks: [],
      editedFiles: [],
    };
    turns.push(current);
  };

  const addTurnFiles = (files?: SessionChangedFile[]) => {
    if (!files || !current) return;
    for (const file of files) {
      if (!file || !file.path) continue;
      const prev = currentFilesMap.get(file.path);
      const merged: SessionChangedFile = {
        ...prev,
        ...file,
        kind: prev?.kind === "added" && file.kind === "modified" ? "added" : (file.kind || prev?.kind || "modified"),
      };
      currentFilesMap.set(file.path, merged);
      allSeenPaths.add(file.path);
    }
    current.editedFiles = [...currentFilesMap.values()];
  };

  entries.forEach((entry, idx) => {
    if (entry.kind === "spacer" || entry.kind === "banner") return;

    // Human user message always opens a new conversation turn
    if (entry.kind === "user" && !isExternalUserSender(entry)) {
      startTurn(entry, idx);
      return;
    }

    if (!current) {
      startTurn(null, idx);
    }

    if (entry.kind === "thinking" || entry.kind === "tool") {
      if (entry.changed_files && entry.changed_files.length > 0) {
        addTurnFiles(entry.changed_files);
      }
      const prev = current!.blocks[current!.blocks.length - 1];
      if (prev && prev.type === "cluster") {
        prev.items.push(entry);
      } else {
        current!.blocks.push({ type: "cluster", id: `cluster-${entry.id}`, items: [entry] });
      }
      return;
    }

    // Consecutive messages from other agents dynamically stack into one PeerAgentStackCard
    const peerMsg = extractPeerAgentMessage(entry, defaultSpeakerNorm);
    if (peerMsg) {
      const prev = current!.blocks[current!.blocks.length - 1];
      if (prev && prev.type === "peer_cluster") {
        prev.items.push(peerMsg);
      } else {
        current!.blocks.push({
          type: "peer_cluster",
          id: `peer-${entry.id}`,
          items: [peerMsg],
        });
      }
      return;
    }

    current!.blocks.push({ type: "entry", entry });
  });

  // Merge any worktree/session files edited outside tracked tool calls onto the latest turn
  if (turns.length > 0 && Array.isArray(sessionFallbackFiles) && sessionFallbackFiles.length > 0) {
    const lastTurn = turns[turns.length - 1];
    const map = new Map<string, SessionChangedFile>(lastTurn.editedFiles.map((f) => [f.path, f]));
    for (const file of sessionFallbackFiles) {
      if (!file || !file.path) continue;
      if (!map.has(file.path) && !allSeenPaths.has(file.path)) {
        map.set(file.path, file);
      } else if (map.has(file.path)) {
        map.set(file.path, { ...map.get(file.path)!, ...file });
      }
    }
    lastTurn.editedFiles = [...map.values()];
  }

  return turns;
}

interface ContextMenuState {
  x: number;
  y: number;
  selectedText: string;
}

function TranscriptContextMenu({
  menu,
  lastAssistantText,
  canClear,
  onClear,
  onClose,
}: {
  menu: ContextMenuState;
  lastAssistantText: string;
  canClear: boolean;
  onClear?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(menu.x, window.innerWidth - rect.width - pad));
    const top = Math.max(pad, Math.min(menu.y, window.innerHeight - rect.height - pad));
    setPos({ left, top });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDismiss = () => onClose();
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [onClose]);

  const hasSelection = Boolean(menu.selectedText.trim());
  const hasLastReply = Boolean(lastAssistantText.trim());
  const hasCopyItems = hasSelection || hasLastReply;

  if (!hasCopyItems && !canClear) return null;

  return createPortal(
    <div
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 min-w-[172px] rounded-xl border border-white/[0.11] bg-[#18181c]/95 p-1 shadow-[0_12px_32px_rgba(0,0,0,0.48)] backdrop-blur-xl select-none"
    >
      {hasSelection && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(menu.selectedText);
            onClose();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-200 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
        >
          <Copy size={13} className="shrink-0 text-zinc-400" />
          <span>Copy</span>
        </button>
      )}
      {hasLastReply && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(lastAssistantText);
            onClose();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-200 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
        >
          <Copy size={13} className="shrink-0 text-zinc-400" />
          <span>Copy last reply</span>
        </button>
      )}
      {hasCopyItems && canClear && <div className="my-1 h-px bg-white/[0.06]" />}
      {canClear && (
        <button
          type="button"
          onClick={() => {
            onClose();
            void onClear?.();
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-zinc-200 hover:bg-white/[0.08] hover:text-white transition-colors cursor-pointer"
        >
          <Eraser size={13} className="shrink-0 text-zinc-400" />
          <span>Clear</span>
        </button>
      )}
    </div>,
    document.body
  );
}

export function TranscriptStream({
  entries,
  planLines = [],
  pendingInteraction = null,
  onRespondInteraction,
  onOpenFile,
  onClearConversation,
  busy = false,
  statusText = "",
  changedFiles = [],
  defaultSpeaker = "",
  defaultSpeakerBrand = "",
  defaultSpeakerColor = "",
  workerBrandMap = {},
  workerColorMap = {},
  compact = false,
  emptyHint,
  emptySubtitle,
}: TranscriptStreamProps) {
  const resolveSpeakerBrand = (speakerName?: string, explicitBrand?: string) => {
    if (explicitBrand) return explicitBrand;
    const raw = String(speakerName || "").trim();
    if (!raw) return defaultSpeakerBrand || "ufoo";
    const lower = raw.toLowerCase();
    if (workerBrandMap[raw]) return workerBrandMap[raw];
    if (workerBrandMap[lower]) return workerBrandMap[lower];
    if (lower === "ufoo" || lower === "ufoo-agent" || lower.endsWith(":ufoo-agent")) return "ufoo";
    return raw;
  };
  const resolveSpeakerColor = (speakerName?: string, senderId?: string, explicitColor?: string) => {
    if (explicitColor) return explicitColor;
    const id = String(senderId || "").trim();
    if (id) {
      if (workerColorMap[id]) return workerColorMap[id];
      const idLower = id.toLowerCase();
      if (workerColorMap[idLower]) return workerColorMap[idLower];
    }
    const raw = String(speakerName || "").trim();
    if (raw) {
      if (workerColorMap[raw]) return workerColorMap[raw];
      const lower = raw.toLowerCase();
      if (workerColorMap[lower]) return workerColorMap[lower];
      if (raw === defaultSpeaker && defaultSpeakerColor) return defaultSpeakerColor;
    }
    return "";
  };
  const defaultSpeakerNorm = normalizeSpeakerDisplay(defaultSpeaker).toLowerCase();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const turns = useMemo(
    () => groupConversationTurns(entries, changedFiles, defaultSpeakerNorm),
    [entries, changedFiles, defaultSpeakerNorm]
  );
  const isEmpty = turns.length === 0 && !pendingInteraction && !busy;
  const friendlyPrompt = emptyHint || emptySubtitle || "What do you want to do now?";

  const lastAssistantText = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (e && (e.kind === "assistant" || e.kind === "report" || e.kind === "agent")) {
        const clean = stripAnsi(e.text || "").trim();
        if (clean) return clean;
      }
    }
    return "";
  }, [entries]);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest("input, textarea, [contenteditable='true']")) {
      return;
    }
    const selectedText = window.getSelection?.()?.toString() || "";
    if (!onClearConversation && !selectedText.trim() && !lastAssistantText) {
      return;
    }
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, selectedText });
  };

  const lastTurn = turns[turns.length - 1];
  const lastBlock = lastTurn?.blocks[lastTurn.blocks.length - 1];
  const lastBlockIsLiveCluster =
    lastBlock?.type === "cluster" &&
    (busy || lastBlock.items.some((item) => item.tool_status === "running"));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length, entries[entries.length - 1]?.text, pendingInteraction?.id, busy]);

  return (
    <div
      onContextMenu={handleContextMenu}
      className={`flex-1 overflow-y-auto ${isEmpty ? "flex flex-col" : ""}`}
    >
      {planLines.length > 0 && (
        <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-zinc-950/90 backdrop-blur-md px-4 py-2">
          <div className="flex items-center gap-2 text-[11.5px] font-medium text-zinc-400 mb-1">
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

      {isEmpty ? (
        <div
          className={`flex flex-1 flex-col items-center justify-center px-6 text-center select-none ${
            compact ? "pb-10 pt-6" : "pb-20 pt-6"
          }`}
        >
          <img
            src={ufooWatermarkSrc}
            alt=""
            aria-hidden="true"
            className={`pointer-events-none object-contain grayscale brightness-[1.9] ${
              compact ? "h-24 w-24 opacity-[0.08]" : "h-44 w-44 opacity-[0.085]"
            }`}
          />
          <p
            className={`max-w-md font-medium tracking-[-0.015em] text-zinc-400 ${
              compact ? "mt-2 text-[14px]" : "mt-3 text-[18px]"
            }`}
          >
            {friendlyPrompt}
          </p>
        </div>
      ) : (
        <div className={`mx-auto ${compact ? "px-3.5 py-3" : "max-w-3xl px-6 py-5"} space-y-4`}>
          {turns.map((turn, turnIndex) => {
            const isLastTurn = turnIndex === turns.length - 1;
            const turnIsLive = isLastTurn && busy;

            return (
              <div key={turn.id} className="space-y-3">
                {turn.userEntry && (() => {
                  const raw = stripAnsi(turn.userEntry.text || "");
                  const senderKind = turn.userEntry.sender_kind || "user";
                  const isExternalSender =
                    senderKind === "peer" ||
                    senderKind === "coordinator" ||
                    Boolean(turn.userEntry.sender_id && senderKind !== "user");
                  const parsedAtts: Array<{ kind: "image" | "file"; name: string }> = [];
                  const lines = raw.split("\n");
                  const lastLine = lines[lines.length - 1] || "";
                  let bodyText = raw;
                  const tagRegex = /\[(image|file):\s*([^\]]+)\]/g;
                  if (lastLine.trim() && lastLine.replace(tagRegex, "").trim() === "") {
                    let m: RegExpExecArray | null;
                    while ((m = tagRegex.exec(lastLine)) !== null) {
                      parsedAtts.push({
                        kind: m[1] === "image" ? "image" : "file",
                        name: m[2].trim(),
                      });
                    }
                    if (parsedAtts.length > 0) {
                      bodyText = lines.slice(0, -1).join("\n").trimEnd();
                    }
                  }

                  if (isExternalSender) {
                    const rawSenderLabel =
                      turn.userEntry.sender_label ||
                      (senderKind === "coordinator" ? "ufoo" : turn.userEntry.sender_id || "agent");
                    const senderLabel = normalizeSpeakerDisplay(rawSenderLabel) || "agent";
                    const senderBrand = resolveSpeakerBrand(
                      rawSenderLabel,
                      turn.userEntry.sender_type || (senderKind === "coordinator" ? "ufoo" : "")
                    );
                    const senderColor = resolveSpeakerColor(rawSenderLabel, turn.userEntry.sender_id);
                    return (
                      <div className="pt-1">
                        <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
                          <BrandIcon brand={senderBrand} color={senderColor} size={14} />
                          <span>{senderLabel}</span>
                        </div>
                        {bodyText && (
                          <div className="pl-0.5">
                            <MarkdownBlock text={bodyText} onOpenFile={onOpenFile} />
                          </div>
                        )}
                        {parsedAtts.length > 0 && (
                          <div className={`flex flex-wrap gap-1.5 pl-0.5 ${bodyText ? "mt-2" : ""}`}>
                            {parsedAtts.map((att, idx) => (
                              <span
                                key={`${att.name}-${idx}`}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-black/25 px-2 py-1 text-[11.5px] text-zinc-200"
                              >
                                {att.kind === "image" ? (
                                  <ImageIcon size={12} className="shrink-0 text-zinc-400" />
                                ) : (
                                  <FileText size={12} className="shrink-0 text-zinc-400" />
                                )}
                                <span className="max-w-[180px] truncate">{att.name}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }

                  const cleanUserBody = bodyText.replace(/^›\s+/, "");

                  return (
                    <div className="flex justify-end pt-1">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-white/[0.08] bg-zinc-800/85 px-4 py-2.5 text-[13.5px] leading-relaxed text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] selectable-text">
                        {cleanUserBody && <div className="whitespace-pre-wrap">{cleanUserBody}</div>}
                        {parsedAtts.length > 0 && (
                          <div className={`flex flex-wrap gap-1.5 ${cleanUserBody ? "mt-2" : ""}`}>
                            {parsedAtts.map((att, idx) => (
                              <span
                                key={`${att.name}-${idx}`}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.1] bg-black/25 px-2 py-1 text-[11.5px] text-zinc-200"
                              >
                                {att.kind === "image" ? (
                                  <ImageIcon size={12} className="shrink-0 text-zinc-400" />
                                ) : (
                                  <FileText size={12} className="shrink-0 text-zinc-400" />
                                )}
                                <span className="max-w-[180px] truncate">{att.name}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {turn.blocks.map((block, blockIndex) => {
                  if (block.type === "cluster") {
                    const isVeryLastBlock = isLastTurn && blockIndex === turn.blocks.length - 1;
                    const clusterHasRunning = block.items.some((item) => item.tool_status === "running");
                    const isLive = isVeryLastBlock && (busy || clusterHasRunning);
                    return (
                      <ActivityCluster
                        key={block.id}
                        items={block.items}
                        isLive={isLive}
                        statusText={statusText}
                        onOpenFile={onOpenFile}
                      />
                    );
                  }

                  if (block.type === "peer_cluster") {
                    return (
                      <PeerAgentStackCard
                        key={block.id}
                        items={block.items}
                        resolveSpeakerBrand={resolveSpeakerBrand}
                        resolveSpeakerColor={resolveSpeakerColor}
                        onOpenFile={onOpenFile}
                      />
                    );
                  }

                  const { entry } = block;
                  const cleanText = stripAnsi(entry.text || "");

                  if (entry.kind === "error") {
                    return (
                      <div
                        key={entry.id}
                        className="rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-2.5 text-[12.5px] text-rose-300 selectable-text"
                      >
                        <div className="whitespace-pre-wrap">{cleanText}</div>
                      </div>
                    );
                  }

                  if (entry.kind === "system" || entry.kind === "meta" || entry.kind === "success") {
                    const attributed = parseAttributedSpeakerLine(cleanText);
                    if (attributed) {
                      const speakerLabel = normalizeSpeakerDisplay(attributed.speaker);
                      const speakerBrand = resolveSpeakerBrand(attributed.speaker, entry.sender_type);
                      const speakerColor = resolveSpeakerColor(attributed.speaker, entry.sender_id);
                      return (
                        <div key={entry.id} className="pt-1">
                          <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
                            <BrandIcon brand={speakerBrand} color={speakerColor} size={14} />
                            <span>{speakerLabel}</span>
                          </div>
                          <div className="pl-0.5">
                            <MarkdownBlock text={attributed.body} onOpenFile={onOpenFile} />
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div
                        key={entry.id}
                        className="rounded-lg border border-white/[0.05] bg-white/[0.015] px-3 py-1.5 text-[12px] text-zinc-400 selectable-text"
                      >
                        <span className="font-mono whitespace-pre-wrap">{cleanText}</span>
                      </div>
                    );
                  }

                  // Assistant / Agent / Report / Bus message
                  const attributedFallback = !entry.speaker ? parseAttributedSpeakerLine(cleanText) : null;
                  const rawSpeaker = entry.speaker || attributedFallback?.speaker || defaultSpeaker || (entry.kind === "report" ? "ufoo" : "");
                  const speakerLabel = normalizeSpeakerDisplay(rawSpeaker);
                  const displayBody = attributedFallback ? attributedFallback.body : cleanText;
                  const speakerBrand = resolveSpeakerBrand(rawSpeaker, entry.sender_type || (rawSpeaker === defaultSpeaker ? defaultSpeakerBrand : ""));
                  const speakerColor = resolveSpeakerColor(
                    rawSpeaker,
                    entry.sender_id,
                    rawSpeaker === defaultSpeaker ? defaultSpeakerColor : ""
                  );
                  return (
                    <div key={entry.id} className="pt-1">
                      {speakerLabel && (
                        <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400">
                          <BrandIcon brand={speakerBrand} color={speakerColor} size={14} />
                          <span>{speakerLabel}</span>
                          {entry.streaming && <Spinner className="h-2.5 w-2.5" />}
                        </div>
                      )}
                      <div className="pl-0.5">
                        <MarkdownBlock text={displayBody} onOpenFile={onOpenFile} />
                      </div>
                    </div>
                  );
                })}

                {/* Per-turn Files Edited summary right at the end of this turn's history (AGY style) */}
                {turn.editedFiles.length > 0 && !turnIsLive && (
                  <TurnFilesEditedCard files={turn.editedFiles} onOpenFile={onOpenFile} />
                )}
              </div>
            );
          })}

          {busy && !lastBlockIsLiveCluster && !pendingInteraction && (
            <div className="flex items-center gap-2 pt-1 text-[12px] text-zinc-400 select-none">
              <Spinner className="h-3 w-3" />
              <span className="truncate">
                {statusText && statusText !== "ready" ? statusText : "Thinking…"}
              </span>
            </div>
          )}

          {pendingInteraction && (
            <InteractionCard
              interaction={pendingInteraction}
              onRespond={onRespondInteraction}
              onOpenFile={onOpenFile}
            />
          )}
          <div ref={bottomRef} className="h-2" />
        </div>
      )}
      {contextMenu && (
        <TranscriptContextMenu
          menu={contextMenu}
          lastAssistantText={lastAssistantText}
          canClear={Boolean(onClearConversation)}
          onClear={onClearConversation}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
