import React, { useState } from "react";

interface MarkdownBlockProps {
  text: string;
  onOpenFile?: (path: string) => void;
}

const EXTERNAL_URL_RE = /^(?:https?:\/\/|mailto:|tel:|data:)/i;
const INLINE_FILE_CODE_RE = /^(?:file:\/\/[^\s)]+|\/[A-Za-z0-9._@/-]+\.[A-Za-z0-9]{1,10}(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)?|\.?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._@-]+)+\.[A-Za-z0-9]{1,10}(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)?|[A-Za-z0-9._-]+\.(?:js|jsx|ts|tsx|mjs|cjs|rs|md|mdx|json|toml|yaml|yml|swift|kt|kts|java|py|go|css|html|sh)(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)?)$/;

function isLocalFileHref(rawHref: string): boolean {
  const href = String(rawHref || "").trim();
  if (!href) return false;
  if (href.startsWith("file://")) return true;
  if (href.startsWith("#")) return false;
  if (EXTERNAL_URL_RE.test(href)) return false;
  // Absolute Unix path or relative path (including .ufoo/..., docs/..., shared/...)
  return href.startsWith("/") || href.startsWith("./") || href.startsWith("../") || href.includes("/") || INLINE_FILE_CODE_RE.test(href);
}

function renderInlineSegments(
  line: string,
  keyPrefix: string,
  onOpenFile?: (path: string) => void
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match markdown links [label](url), inline `code`, **bold**, ~~strike~~, *italic*, or <br>
  const pattern =
    /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^\s*](?:[^*\n]*[^\s*])?)\*|<br\s*\/?>)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let idx = 0;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(line.slice(lastIndex, match.index));
    }
    const [, full, linkLabel, linkHref, codeSpan, boldSpan, strikeSpan, italicSpan] = match;
    const key = `${keyPrefix}-${idx++}`;

    if (/^<br\s*\/?>$/i.test(full)) {
      nodes.push(<br key={key} />);
    } else if (linkLabel && linkHref) {
      if (isLocalFileHref(linkHref)) {
        nodes.push(
          <button
            key={key}
            type="button"
            onClick={() => onOpenFile?.(linkHref)}
            title={`Open ${linkHref} in Docs`}
            className="inline rounded-md border border-white/[0.09] bg-white/[0.05] px-1.5 py-0.5 text-left font-mono text-[12px] text-zinc-200 [overflow-wrap:anywhere] hover:border-white/[0.2] hover:bg-white/[0.1] hover:text-white transition-colors cursor-pointer"
          >
            {linkLabel}
          </button>
        );
      } else {
        nodes.push(
          <a
            key={key}
            href={linkHref}
            target="_blank"
            rel="noreferrer"
            className="text-zinc-200 underline decoration-white/30 underline-offset-2 [overflow-wrap:anywhere] hover:text-white"
          >
            {linkLabel}
          </a>
        );
      }
    } else if (codeSpan !== undefined) {
      const trimmed = codeSpan.trim();
      if (onOpenFile && INLINE_FILE_CODE_RE.test(trimmed)) {
        nodes.push(
          <button
            key={key}
            type="button"
            onClick={() => onOpenFile(trimmed)}
            className="inline rounded bg-zinc-800/90 border border-white/[0.08] px-1.5 py-0.5 text-left font-mono text-[12px] text-zinc-200 [overflow-wrap:anywhere] hover:border-white/[0.22] hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer"
            title="Open in Docs Inspector"
          >
            {codeSpan}
          </button>
        );
      } else {
        nodes.push(
          <code
            key={key}
            className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[12px] text-zinc-200 [overflow-wrap:anywhere]"
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
    } else if (strikeSpan !== undefined) {
      nodes.push(
        <del key={key} className="text-zinc-500 line-through">
          {strikeSpan}
        </del>
      );
    } else if (italicSpan !== undefined) {
      nodes.push(
        <em key={key} className="italic text-zinc-200">
          {italicSpan}
        </em>
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

type TableAlign = "left" | "center" | "right";

function splitTableRow(rawLine: string): string[] {
  const trimmed = rawLine.trim();
  if (!trimmed.includes("|")) return [];

  const cells: string[] = [];
  let buf = "";
  let inCodeTicks = 0;

  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];

    // Handle backtick spans so pipes inside `code | spans` do not split cells
    if (ch === "`") {
      let run = 1;
      while (i + run < trimmed.length && trimmed[i + run] === "`") run += 1;
      buf += trimmed.slice(i, i + run);
      if (inCodeTicks === 0) inCodeTicks = run;
      else if (inCodeTicks === run) inCodeTicks = 0;
      i += run - 1;
      continue;
    }

    // Handle escaped pipe \| outside code spans
    if (inCodeTicks === 0 && ch === "\\" && i + 1 < trimmed.length && trimmed[i + 1] === "|") {
      buf += "|";
      i += 1;
      continue;
    }

    if (inCodeTicks === 0 && ch === "|") {
      cells.push(buf);
      buf = "";
      continue;
    }

    buf += ch;
  }
  cells.push(buf);

  // Strip optional leading/trailing empty cells caused by outer pipes `| a | b |`
  if (trimmed.startsWith("|") && cells.length > 0) {
    cells.shift();
  }
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|") && cells.length > 0) {
    cells.pop();
  }

  return cells.map((cell) => cell.trim());
}

function parseTableAlignments(rawLine: string): TableAlign[] | null {
  const trimmed = rawLine.trim();
  if (!trimmed.includes("|")) return null;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return null;
  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

function isTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const headerLine = lines[index];
  const sepLine = lines[index + 1];
  if (!headerLine || !sepLine) return false;
  if (!headerLine.includes("|") || !sepLine.includes("|")) return false;
  const headers = splitTableRow(headerLine);
  const aligns = parseTableAlignments(sepLine);
  return Boolean(aligns && headers.length > 0 && aligns.length === headers.length);
}

function estimatePlainLength(cell: string): number {
  return cell
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim().length;
}

function MarkdownTable({
  headers,
  alignments,
  rows,
  keyPrefix,
  onOpenFile,
}: {
  headers: string[];
  alignments: TableAlign[];
  rows: string[][];
  keyPrefix: string;
  onOpenFile?: (path: string) => void;
}) {
  const colCount = headers.length;
  const colMetrics = headers.map((header, colIdx) => {
    let maxLen = estimatePlainLength(header);
    for (const row of rows) {
      const len = estimatePlainLength(row[colIdx] || "");
      if (len > maxLen) maxLen = len;
    }
    if (colCount <= 2) {
      if (colIdx === 0) {
        return {
          minWidth: maxLen > 12 ? 130 : undefined,
          maxWidth: colCount === 2 ? 240 : undefined,
        };
      }
      return {
        minWidth: maxLen > 24 ? 220 : 120,
        maxWidth: undefined,
      };
    }
    if (maxLen <= 10) return { minWidth: undefined, maxWidth: 160 };
    if (maxLen <= 28) return { minWidth: 120, maxWidth: 220 };
    if (maxLen <= 60) return { minWidth: 170, maxWidth: 300 };
    return { minWidth: 220, maxWidth: 360 };
  });

  const alignClass = (align?: TableAlign) =>
    align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";

  return (
    <div className="my-3 w-full max-w-full overflow-x-auto rounded-xl border border-white/[0.08] bg-white/[0.015]">
      <table className="w-full border-collapse text-[12.5px] leading-[1.58]">
        <thead>
          <tr className="border-b border-white/[0.08] bg-white/[0.035]">
            {headers.map((header, colIdx) => (
              <th
                key={`${keyPrefix}-th-${colIdx}`}
                className={`px-3 py-2 font-medium text-zinc-200 whitespace-nowrap align-bottom ${alignClass(
                  alignments[colIdx]
                )}`}
              >
                {renderInlineSegments(header, `${keyPrefix}-th-${colIdx}`, onOpenFile)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.05]">
          {rows.map((row, rowIdx) => (
            <tr key={`${keyPrefix}-tr-${rowIdx}`} className="hover:bg-white/[0.025] transition-colors">
              {headers.map((_, colIdx) => {
                const cell = row[colIdx] || "";
                const metric = colMetrics[colIdx];
                return (
                  <td
                    key={`${keyPrefix}-td-${rowIdx}-${colIdx}`}
                    className={`px-3 py-2 align-top text-zinc-300 selectable-text ${alignClass(
                      alignments[colIdx]
                    )}`}
                  >
                    <div
                      style={{
                        ...(metric.minWidth ? { minWidth: `${metric.minWidth}px` } : {}),
                        ...(metric.maxWidth ? { maxWidth: `${metric.maxWidth}px` } : {}),
                      }}
                      className="break-words [overflow-wrap:anywhere]"
                    >
                      {renderInlineSegments(cell, `${keyPrefix}-td-${rowIdx}-${colIdx}`, onOpenFile)}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
          className={`rounded px-1.5 py-0.5 transition-colors cursor-pointer ${
            copied ? "text-emerald-400" : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
          }`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3.5 font-mono text-[12.5px] leading-[1.55] text-zinc-200 selectable-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const FENCE_START_RE = /^```(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_RE = /^\s*[-*•]\s+/;
const ORDERED_LIST_RE = /^\s*(\d+)\.\s+/;
const LIST_LINE_RE = /^\s*(?:[-*•]|\d+\.)\s+/;
const HR_RE = /^\s*(?:---+|\*\*\*+|___+)\s*$/;

export function MarkdownBlock({ text, onOpenFile }: MarkdownBlockProps) {
  if (!text) return null;
  const blocks: React.ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(FENCE_START_RE);
    if (fenceMatch) {
      const lang = (fenceMatch[1] || "").trim().split(/\s+/)[0] || "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing ```
      blocks.push(<CodeFence key={`fence-${i}`} lang={lang} code={codeLines.join("\n")} />);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push(<hr key={`hr-${i}`} className="my-3 border-white/[0.08]" />);
      i += 1;
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = headingMatch[2];
      const cls =
        level === 1
          ? "mt-3 mb-1.5 text-[16px] font-semibold tracking-tight text-zinc-100"
          : level === 2
          ? "mt-2.5 mb-1 text-[14.5px] font-semibold tracking-tight text-zinc-100"
          : level === 3
          ? "mt-2 mb-1 text-[13.5px] font-medium text-zinc-200"
          : "mt-2 mb-0.5 text-[12.5px] font-medium text-zinc-300";
      blocks.push(
        <div key={`h-${i}`} className={cls}>
          {renderInlineSegments(content, `h-${i}`, onOpenFile)}
        </div>
      );
      i += 1;
      continue;
    }

    if (isTableStart(lines, i)) {
      const tableStart = i;
      const headers = splitTableRow(lines[i]);
      const alignments = parseTableAlignments(lines[i + 1]) || headers.map(() => "left" as TableAlign);
      i += 2;
      const rows: string[][] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|") &&
        !FENCE_START_RE.test(lines[i]) &&
        !HEADING_RE.test(lines[i]) &&
        !HR_RE.test(lines[i]) &&
        !lines[i].startsWith(">")
      ) {
        const parsed = splitTableRow(lines[i]);
        if (parsed.length === 0) break;
        const normalized = headers.map((_, colIdx) => parsed[colIdx] ?? "");
        rows.push(normalized);
        i += 1;
      }
      blocks.push(
        <MarkdownTable
          key={`tbl-${tableStart}`}
          headers={headers}
          alignments={alignments}
          rows={rows}
          keyPrefix={`tbl-${tableStart}`}
          onOpenFile={onOpenFile}
        />
      );
      continue;
    }

    const orderedMatch = line.match(ORDERED_LIST_RE);
    if (orderedMatch) {
      const startNum = Number.parseInt(orderedMatch[1], 10) || 1;
      const items: string[] = [];
      while (i < lines.length && ORDERED_LIST_RE.test(lines[i])) {
        items.push(lines[i].replace(ORDERED_LIST_RE, ""));
        i += 1;
      }
      blocks.push(
        <ol
          key={`ol-${i}`}
          start={startNum !== 1 ? startNum : undefined}
          className="my-1.5 space-y-1 pl-5 list-decimal marker:text-zinc-500"
        >
          {items.map((item, idx) => (
            <li key={idx} className="text-[13.5px] leading-[1.6] text-zinc-200 selectable-text">
              {renderInlineSegments(item, `oli-${i}-${idx}`, onOpenFile)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    if (UNORDERED_LIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UNORDERED_LIST_RE.test(lines[i])) {
        items.push(lines[i].replace(UNORDERED_LIST_RE, ""));
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
          className="my-2 border-l-2 border-white/[0.22] bg-white/[0.02] py-1.5 pl-3 pr-2 text-[13px] text-zinc-300 rounded-r-lg selectable-text"
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
      !FENCE_START_RE.test(lines[i]) &&
      !HEADING_RE.test(lines[i]) &&
      !HR_RE.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !LIST_LINE_RE.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    if (paraLines.length === 0) {
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

  return <div className="min-w-0 space-y-1">{blocks}</div>;
}
