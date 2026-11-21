import React, { useState } from "react";
import { Check, Copy, FileCode } from "@phosphor-icons/react";

interface MarkdownBlockProps {
  text: string;
  onOpenFile?: (path: string) => void;
}

const FILE_PATH_TOKEN_RE = /^(?:file:\/\/[^\s)]+|(?:src|docs|crates|apps|bin|scripts|test|templates)\/[A-Za-z0-9._/-]+(?:#L\d+(?:-L?\d+)?|:\d+)?|[A-Za-z0-9._-]+\.(?:js|ts|tsx|rs|md|json|toml|swift)(?:#L\d+|:\d+)?)$/;

function renderInlineSegments(
  line: string,
  keyPrefix: string,
  onOpenFile?: (path: string) => void
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match markdown links [label](url), inline `code`, or **bold**
  const pattern = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const [, full, linkLabel, linkHref, codeSpan, boldSpan] = match;
    const key = `${keyPrefix}-${idx++}`;

    if (linkLabel && linkHref) {
      if (linkHref.startsWith("file://") || FILE_PATH_TOKEN_RE.test(linkHref)) {
        nodes.push(
          <button
            key={key}
            type="button"
            onClick={() => onOpenFile?.(linkHref)}
            className="inline-flex items-center gap-1 rounded bg-blue-500/12 px-1.5 py-0.5 font-mono text-[12px] text-blue-400 hover:bg-blue-500/22 transition-colors cursor-pointer"
          >
            <FileCode size={13} weight="regular" />
            <span>{linkLabel}</span>
          </button>
        );
      } else {
        nodes.push(
          <a
            key={key}
            href={linkHref}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 underline decoration-blue-400/40 underline-offset-2 hover:text-blue-300"
          >
            {linkLabel}
          </a>
        );
      }
    } else if (codeSpan !== undefined) {
      const trimmed = codeSpan.trim();
      if (onOpenFile && FILE_PATH_TOKEN_RE.test(trimmed)) {
        nodes.push(
          <button
            key={key}
            type="button"
            onClick={() => onOpenFile(trimmed)}
            className="inline-flex items-center gap-1 rounded bg-zinc-800/90 border border-white/[0.08] px-1.5 py-0.5 font-mono text-[12px] text-blue-300 hover:border-blue-400/40 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Open in Docs Inspector"
          >
            <FileCode size={12} />
            <span>{codeSpan}</span>
          </button>
        );
      } else {
        nodes.push(
          <code
            key={key}
            className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[12.5px] text-zinc-200"
          >
            {codeSpan}
          </code>
        );
      }
    } else if (boldSpan !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-zinc-100">
          {boldSpan}
        </strong>
      );
    } else {
      nodes.push(full);
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < line.length) {
    nodes.push(line.slice(lastIndex));
  }
  return nodes;
}

function CodeFence({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="my-2.5 overflow-hidden rounded-xl border border-white/[0.08] bg-[#09090b] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[11px] text-zinc-400">
        <span className="font-mono lowercase tracking-wide">{lang || "code"}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200 transition-colors cursor-pointer"
        >
          {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-[1.55] text-zinc-200 selectable-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function MarkdownBlock({ text, onOpenFile }: MarkdownBlockProps) {
  if (!text) return null;
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```
      blocks.push(<CodeFence key={`fence-${i}`} lang={lang} code={codeLines.join("\n")} />);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const cls =
        level === 1
          ? "mt-3 mb-1.5 text-[16px] font-semibold tracking-tight text-zinc-100"
          : level === 2
          ? "mt-2.5 mb-1 text-[14.5px] font-semibold tracking-tight text-zinc-100"
          : "mt-2 mb-1 text-[13.5px] font-medium text-zinc-200";
      blocks.push(
        <div key={`h-${i}`} className={cls}>
          {renderInlineSegments(content, `h-${i}`, onOpenFile)}
        </div>
      );
      i += 1;
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*•]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*•]|\d+\.)\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${i}`} className="my-1.5 space-y-1 pl-4 list-disc marker:text-zinc-500">
          {items.map((item, idx) => (
            <li key={idx} className="text-[13.5px] leading-[1.6] text-zinc-200 selectable-text">
              {renderInlineSegments(item, `li-${i}-${idx}`, onOpenFile)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote
          key={`q-${i}`}
          className="my-2 border-l-2 border-blue-500/50 bg-white/[0.02] py-1.5 pl-3 pr-2 text-[13px] text-zinc-300 rounded-r-lg selectable-text"
        >
          {renderInlineSegments(quoteLines.join(" "), `q-${i}`, onOpenFile)}
        </blockquote>
      );
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith(">") &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push(
      <p key={`p-${i}`} className="my-1.5 text-[13.5px] leading-[1.62] text-zinc-200 selectable-text">
        {paraLines.map((pl, idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <br />}
            {renderInlineSegments(pl, `p-${i}-${idx}`, onOpenFile)}
          </React.Fragment>
        ))}
      </p>
    );
  }

  return <div className="space-y-1">{blocks}</div>;
}
