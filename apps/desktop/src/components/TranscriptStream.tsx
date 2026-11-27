import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaretDown, CaretRight, CaretUp, Copy, Eraser, FileText, Image as ImageIcon } from "@phosphor-icons/react";
import type { PendingInteraction, PlanItem, PlanItemStatus, SessionChangedFile, TranscriptEntry } from "../types";
import { BrandIcon } from "./BrandIcon";
import { DotGridLoader } from "./DotGridLoader";
import { MarkdownBlock } from "./MarkdownBlock";

const ufooWatermarkSrc = new URL("../assets/ufoo-watermark.png", import.meta.url).href;

interface TranscriptStreamProps {
  entries: TranscriptEntry[];
  planLines?: string[];
  planItems?: PlanItem[];
  pendingInteraction?: PendingInteraction | null;
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
    .replace(/^Failed:\s*/i, "")
    .replace(/\s*\(Ctrl\+O expand\)\s*$/i, "")
    .trim();
  // Unwrap noisy shell wrappers like `/bin/zsh -lc '...'` or `/bin/bash -lc "..."`
  const shellMatch = text.match(
    /^((?:Ran|Run|Bash|Exec)\s+)(?:\/usr\/bin\/env\s+)?(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|cl|c)\s+([\s\S]+)$/i
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

function isPlanBookkeepingTool(entry: TranscriptEntry): boolean {
  if (entry.kind !== "tool") return false;
  const summary = cleanToolSummary(entry.text);
  if (entry.tool_status === "error" || /^failed:/i.test(summary)) return false;
  const toolName = String(entry.tool_name || "").trim().toLowerCase();
  if (toolName === "plan_graph" || toolName === "plan" || toolName === "todowrite" || toolName === "update_plan") {
    return true;
  }
  return /^(?:plan graph|update plan|updating plan|todowrite)$/i.test(summary);
}

function parsePlanLinesFallback(lines: string[]): PlanItem[] {
  const cleaned = (Array.isArray(lines) ? lines : [])
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
  if (cleaned.length === 0) return [];
  const hasRunningTaskLoop = cleaned.some((line) => /^TaskLoop\s+(?:writing|running|starting|working)\b/i.test(line));
  const parsed: PlanItem[] = [];
  for (const line of cleaned) {
    if (/^Plan\b(?:\s*·|\s*\()/i.test(line)) continue;
    if (/^TaskLoop\b/i.test(line)) continue;
    if (/^…\s*\+\d+\s+more\b/i.test(line)) continue;
    if (/^graphId=/i.test(line)) continue;
    const upcomingMatch = line.match(/^接下来\s*·\s*(.+)$/);
    if (upcomingMatch) {
      for (const part of upcomingMatch[1].split(/\s*·\s*/)) {
        const title = part.trim();
        if (title) parsed.push({ title, status: "pending" });
      }
      continue;
    }
    const markMatch = line.match(/^(?:[├└─\s]*)(✓|✔|→|▶|●|◐|○|✗|✘|⊘)\s+(?:\d+\s+)?(.+)$/);
    if (markMatch) {
      const mark = markMatch[1];
      const title = markMatch[2].trim();
      if (!title) continue;
      let status: PlanItemStatus = "pending";
      if (mark === "✓" || mark === "✔") status = "completed";
      else if (mark === "→" || mark === "▶" || mark === "●" || mark === "◐") status = "in_progress";
      else if (mark === "✗" || mark === "✘") status = "failed";
      else if (mark === "⊘") status = "skipped";
      parsed.push({ title, status });
    }
  }
  if (hasRunningTaskLoop && parsed.length > 0 && !parsed.some((item) => item.status === "in_progress")) {
    const firstPending = parsed.find((item) => item.status === "pending");
    if (firstPending) firstPending.status = "in_progress";
  }
  return parsed;
}

function PlanStepStatusIcon({ status, isLive }: { status: PlanItemStatus; isLive: boolean }) {
  if (status === "in_progress") {
    return <DotGridLoader size="sm" active={isLive} label="In progress" />;
  }
  if (status === "completed") {
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        aria-label="Completed"
        className="shrink-0"
      >
        <circle cx="8" cy="8" r="6.5" className="fill-emerald-400/12 stroke-emerald-400/85" strokeWidth="1.3" />
        <path
          d="M5.1 8.2L7.1 10.2L10.9 6.1"
          className="stroke-emerald-400"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        aria-label="Failed"
        className="shrink-0"
      >
        <circle cx="8" cy="8" r="6.5" className="fill-rose-400/10 stroke-rose-400/85" strokeWidth="1.3" />
        <path
          d="M5.75 5.75L10.25 10.25M10.25 5.75L5.75 10.25"
          className="stroke-rose-400"
          strokeWidth="1.45"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === "skipped") {
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 16 16"
        fill="none"
        aria-label="Skipped"
        className="shrink-0"
      >
        <circle cx="8" cy="8" r="6.5" className="stroke-zinc-600" strokeWidth="1.3" />
        <path d="M5.5 8H10.5" className="stroke-zinc-600" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-label="Pending"
      className="shrink-0"
    >
      <circle cx="8" cy="8" r="6.5" className="stroke-zinc-500/80" strokeWidth="1.3" />
    </svg>
  );
}

const DEFAULT_VISIBLE_PLAN_ITEMS = 8;

function PlanCard({
  items,
  isLive,
}: {
  items: PlanItem[];
  isLive: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  if (!items || items.length === 0) return null;

  const visible = showAll ? items : items.slice(0, DEFAULT_VISIBLE_PLAN_ITEMS);
  const hiddenCount = Math.max(0, items.length - visible.length);

  return (
    <div className="my-2 rounded-xl border border-white/[0.08] bg-[#111114]/90 px-4 py-3">
      <ul className="space-y-2.5">
        {visible.map((item, idx) => {
          const status = item.status || "pending";
          const textClass =
            status === "in_progress"
              ? "font-medium text-zinc-100"
              : status === "completed"
              ? "text-zinc-400"
              : status === "skipped"
              ? "text-zinc-500 line-through"
              : "text-zinc-200";
          return (
            <li key={item.id || `${idx}-${item.title}`} className="flex items-start gap-3">
              <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
                <PlanStepStatusIcon status={status} isLive={isLive} />
              </span>
              <span className={`min-w-0 flex-1 text-[13.5px] leading-[1.45] selectable-text ${textClass}`}>
                {item.title}
              </span>
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2.5 pl-7 text-[11.5px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Show {hiddenCount} more {hiddenCount === 1 ? "step" : "steps"}
        </button>
      )}
      {showAll && items.length > DEFAULT_VISIBLE_PLAN_ITEMS && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="mt-2.5 pl-7 text-[11.5px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Show less
        </button>
      )}
    </div>
  );
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
  return parts.join(", ");
}

function thinkingPreview(text: string): string {
  const clean = stripAnsi(text || "").trim();
  const headings = Array.from(clean.matchAll(/\*\*([^*]+?)\*\*/g));
  const latest = headings.at(-1)?.[1] || clean.split(/\n+/).at(-1) || "";
  return latest.replace(/\s+/g, " ").trim();
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
    const preview = thinkingPreview(entry.text);
    const isThinkingLive = Boolean(entry.streaming);
    return (
      <div className="text-[11.5px]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200 transition-colors cursor-pointer"
        >
          {open ? <CaretDown size={10} className="shrink-0 text-zinc-500" /> : <CaretRight size={10} className="shrink-0 text-zinc-500" />}
          {isThinkingLive ? (
            <span className="min-w-0 max-w-full truncate agy-text-shimmer">
              <span className="font-medium">Thinking</span>
              {!open && preview ? ` ${preview.slice(0, 96)}` : ""}
            </span>
          ) : (
            <>
              <span className="font-medium shrink-0 text-zinc-400">Thought</span>
              {!open && preview && (
                <span className="truncate text-zinc-500">
                  {preview.slice(0, 96)}
                </span>
              )}
            </>
          )}
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

  return (
    <div className="text-[11.5px]">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors ${
          hasDetail ? "hover:bg-white/[0.04] cursor-pointer" : "cursor-default"
        }`}
      >
        <span className="min-w-0 flex-1 overflow-hidden font-mono text-[11.5px]">
          <span
            className={`inline-block max-w-full truncate align-bottom ${
              isRunning ? "agy-text-shimmer" : "text-zinc-400"
            }`}
          >
            {summary}
          </span>
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
  const latest = items[items.length - 1];
  const liveHeadline = (() => {
    if (latest?.kind === "thinking") {
      const hint = thinkingPreview(latest.text);
      return hint || "Thinking…";
    }
    if (latest?.kind === "tool") {
      if (latest.tool_status !== "running" && statusText === "Thinking…") return statusText;
      return cleanToolSummary(latest.text);
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
          className="group flex max-w-full items-center gap-2 py-1 text-left text-[12.5px] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <span className="inline-block min-w-0 max-w-full truncate agy-text-shimmer">{liveHeadline}</span>
          <span className="shrink-0 text-zinc-500 group-hover:text-zinc-300">
            {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
          </span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group inline-flex max-w-full items-center gap-1.5 py-0.5 text-left text-[12px] text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <span className="truncate">{completedSummary}</span>
          <span className="shrink-0 text-zinc-600 group-hover:text-zinc-300">
            {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
          </span>
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
              title={`Open ${file.path} in Files`}
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
          {only.streaming && <DotGridLoader size="xs" />}
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
            {latest.streaming && <DotGridLoader size="xs" />}
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
                  {item.streaming && <DotGridLoader size="xs" />}
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
  | { type: "plan"; id: string; title?: string; items: PlanItem[] }
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
  defaultSpeakerNorm = "",
  fallbackPlanItems: PlanItem[] = []
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

    if (entry.kind === "plan") {
      const items = Array.isArray(entry.plan_items) && entry.plan_items.length > 0
        ? entry.plan_items
        : parsePlanLinesFallback(String(entry.text || "").split("\n"));
      if (items.length > 0) {
        current!.blocks.push({
          type: "plan",
          id: entry.id,
          title: entry.plan_title,
          items,
        });
      }
      return;
    }

    if (entry.kind === "thinking" || entry.kind === "tool") {
      if (entry.changed_files && entry.changed_files.length > 0) {
        addTurnFiles(entry.changed_files);
      }
      if (isPlanBookkeepingTool(entry)) {
        return;
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

  // If a live plan exists on frame metadata without an inline plan entry in the
  // latest turn (e.g. main chat plan.set or legacy frame), render it inline
  // above the trailing tool cluster instead of a top sticky bar.
  if (Array.isArray(fallbackPlanItems) && fallbackPlanItems.length > 0) {
    if (turns.length === 0) {
      startTurn(null, 0);
    }
    const lastTurn = turns[turns.length - 1];
    const hasInlinePlan = lastTurn.blocks.some((b) => b.type === "plan");
    if (!hasInlinePlan) {
      const planBlock: StreamBlock = {
        type: "plan",
        id: `${lastTurn.id}-fallback-plan`,
        items: fallbackPlanItems,
      };
      const lastBlockIdx = lastTurn.blocks.length - 1;
      if (lastBlockIdx >= 0 && lastTurn.blocks[lastBlockIdx].type === "cluster") {
        lastTurn.blocks.splice(lastBlockIdx, 0, planBlock);
      } else {
        lastTurn.blocks.push(planBlock);
      }
    }
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
  planItems = [],
  pendingInteraction = null,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const resumeTimer = useRef<number | null>(null);
  const followedTop = useRef(0);

  const followBottom = () => {
    const pane = scrollRef.current;
    if (!pane) return;
    pane.scrollTop = pane.scrollHeight;
    followedTop.current = pane.scrollTop;
  };

  const pauseFollowing = () => {
    if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => {
      resumeTimer.current = null;
      followBottom();
    }, 15_000);
  };

  useEffect(() => () => {
    if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current);
  }, []);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const fallbackPlanItems = useMemo(
    () => (Array.isArray(planItems) && planItems.length > 0 ? planItems : parsePlanLinesFallback(planLines)),
    [planItems, planLines]
  );
  const turns = useMemo(
    () => groupConversationTurns(entries, changedFiles, defaultSpeakerNorm, fallbackPlanItems),
    [entries, changedFiles, defaultSpeakerNorm, fallbackPlanItems]
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

  useLayoutEffect(() => {
    if (resumeTimer.current === null) followBottom();
  }, [entries.length, entries[entries.length - 1]?.text, pendingInteraction?.id, busy]);

  return (
    <div
      ref={scrollRef}
      onContextMenu={handleContextMenu}
      onWheel={(event) => { if (event.deltaY !== 0) pauseFollowing(); }}
      onScroll={(event) => {
        if (event.currentTarget.scrollTop !== followedTop.current || resumeTimer.current !== null) pauseFollowing();
      }}
      className={`flex-1 overflow-y-auto ${isEmpty ? "flex flex-col" : ""}`}
    >
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
                  let directTargetLabel = normalizeSpeakerDisplay(turn.userEntry.target_label || "");
                  let directTargetId = String(turn.userEntry.target_id || "").trim();
                  let directTargetType = String(turn.userEntry.target_type || "").trim();
                  let displayUserBody = cleanUserBody;

                  const leadingMention = cleanUserBody.match(/^@([a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63})\s+([\s\S]+)$/);
                  if (leadingMention) {
                    const mentionToken = leadingMention[1].trim();
                    const knownBrand = workerBrandMap[mentionToken] || workerBrandMap[mentionToken.toLowerCase()];
                    if (directTargetLabel || knownBrand) {
                      if (!directTargetLabel) directTargetLabel = normalizeSpeakerDisplay(mentionToken) || mentionToken;
                      if (!directTargetType && knownBrand) directTargetType = knownBrand;
                      displayUserBody = leadingMention[2];
                    }
                  }

                  const directTargetBrand = directTargetLabel
                    ? resolveSpeakerBrand(directTargetLabel, directTargetType)
                    : "";
                  const directTargetColor = directTargetLabel
                    ? resolveSpeakerColor(directTargetLabel, directTargetId)
                    : "";

                  return (
                    <div className="flex flex-col items-end pt-1">
                      {directTargetLabel && (
                        <div className="mb-1 mr-1 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-400 select-none">
                          <span className="text-zinc-500">to</span>
                          <BrandIcon brand={directTargetBrand} color={directTargetColor} size={13} />
                          <span className="text-zinc-300">{directTargetLabel}</span>
                        </div>
                      )}
                      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-white/[0.08] bg-zinc-800/85 px-4 py-2.5 text-[13.5px] leading-relaxed text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] selectable-text">
                        {displayUserBody && <div className="whitespace-pre-wrap">{displayUserBody}</div>}
                        {parsedAtts.length > 0 && (
                          <div className={`flex flex-wrap gap-1.5 ${displayUserBody ? "mt-2" : ""}`}>
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
                  if (block.type === "plan") {
                    return (
                      <PlanCard
                        key={block.id}
                        items={block.items}
                        isLive={turnIsLive}
                      />
                    );
                  }

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
                          {entry.streaming && <DotGridLoader size="xs" />}
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
            <div className="flex items-center gap-2 pt-1 text-[12px] select-none">
              <span className="inline-block max-w-full truncate agy-text-shimmer">
                {statusText && statusText !== "ready" ? statusText : "Thinking…"}
              </span>
            </div>
          )}

          <div className="h-2" />
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
