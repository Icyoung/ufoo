/**
 * Shared markdown renderer for TUI log output.
 *
 * Produces either blessed tags (chat / legacy) or chalk ANSI (Ink ucode).
 * Terminals cannot change font size, so headings/emphasis use color + weight
 * instead of literal `#` / `**` markers. GFM pipe tables are aligned into a
 * compact spreadsheet-like grid.
 */

const chalk = require("chalk");

function stripLeakedEscapeTags(text = "") {
  const source = String(text == null ? "" : text);
  const withoutClosedTags = source.replace(/\{[^{}\n]*escape[^{}\n]*\}/gi, "");
  const withoutDanglingEscape = withoutClosedTags.replace(/\{\s*\/?\s*escape[\s\S]*$/gi, "");
  return withoutDanglingEscape.replace(/\{\s*\/?\s*e?s?c?a?p?e?[^{}\n]*$/gi, "");
}

/** Visible width for CJK-aware table padding (no ANSI). */
function visibleWidth(text = "") {
  let width = 0;
  for (const char of String(text || "")) {
    const code = char.codePointAt(0) || 0;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    if (
      (code >= 0x1100 && code <= 0x115f)
      || code === 0x2329
      || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
    ) {
      width += 2;
      continue;
    }
    width += 1;
  }
  return width;
}

function isTableSeparatorLine(line = "") {
  const raw = String(line || "").trim();
  if (!raw.includes("-")) return false;
  return /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/.test(raw);
}

function isTableRowLine(line = "") {
  const raw = String(line || "").trim();
  if (!raw.includes("|")) return false;
  if (isTableSeparatorLine(raw)) return true;
  // Prefer GFM pipe rows (`| a | b |`). Also allow compact `a | b | c`
  // (at least two pipes). Lone prose like `A | B` is not a table row.
  if (/^\|.*\|$/.test(raw)) return true;
  const parts = raw.split("|");
  return parts.length >= 3 && parts.some((p) => p.trim().length > 0);
}

/**
 * Buffers consecutive GFM table rows so they can be rendered as one block
 * (column widths need the full table). Call flush() before non-table output.
 */
function createMarkdownTableBuffer() {
  const rows = [];
  return {
    get size() {
      return rows.length;
    },
    push(line = "") {
      const raw = String(line == null ? "" : line);
      if (!isTableRowLine(raw)) return false;
      rows.push(raw);
      return true;
    },
    flush() {
      if (rows.length === 0) return null;
      const text = rows.join("\n");
      rows.length = 0;
      return text;
    },
  };
}

function parseTableCells(line = "") {
  let raw = String(line || "").trim();
  if (raw.startsWith("|")) raw = raw.slice(1);
  if (raw.endsWith("|")) raw = raw.slice(0, -1);
  return raw.split("|").map((cell) => cell.trim());
}

function parseSeparatorAlignments(line = "", columnCount = 0) {
  const cells = parseTableCells(line);
  const aligns = cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
  while (aligns.length < columnCount) aligns.push("left");
  return aligns.slice(0, Math.max(columnCount, aligns.length));
}

function alignCell(text = "", width = 0, align = "left") {
  const value = String(text || "");
  const current = visibleWidth(value);
  if (current >= width) return value;
  const pad = width - current;
  if (align === "right") return `${" ".repeat(pad)}${value}`;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return `${" ".repeat(left)}${value}${" ".repeat(right)}`;
  }
  return `${value}${" ".repeat(pad)}`;
}

function plainCellWidth(cell = "") {
  const plain = String(cell || "")
    .replace(/\*\*|__/g, "")
    .replace(/`/g, "")
    .replace(/\*/g, "");
  return visibleWidth(plain);
}

function createBlessedAdapters(escapeFn = (value) => String(value || "")) {
  const escape = (value) => escapeFn(value);
  return {
    escape,
    bold: (value) => `{bold}{white-fg}${escape(value)}{/white-fg}{/bold}`,
    italic: (value) => `{italic}{gray-fg}${escape(value)}{/gray-fg}{/italic}`,
    code: (value) => `{yellow-fg}${escape(value)}{/yellow-fg}`,
    heading: (level, value) => {
      const depth = Math.max(1, Math.min(6, Number(level) || 1));
      if (depth <= 2) return `{cyan-fg}{bold}${value}{/bold}{/cyan-fg}`;
      if (depth === 3) return `{blue-fg}{bold}${value}{/bold}{/blue-fg}`;
      return `{bold}${value}{/bold}`;
    },
    quoteMarker: () => "{gray-fg}│{/gray-fg}",
    bulletMarker: () => "{gray-fg}•{/gray-fg}",
    orderedMarker: (value) => `{gray-fg}${escape(value)}.{/gray-fg}`,
    rule: () => "{gray-fg}────────────────────────{/gray-fg}",
    fenceOpen: (language) => (
      language
        ? `{gray-fg}┌ code:${escape(language)}{/gray-fg}`
        : "{gray-fg}┌ code{/gray-fg}"
    ),
    fenceClose: () => "{gray-fg}└{/gray-fg}",
    fenceBody: (value) => `{gray-fg}│{/gray-fg} {white-fg}${escape(value)}{/white-fg}`,
    error: (value) => `{red-fg}${value}{/red-fg}`,
    tablePipe: () => "{gray-fg}│{/gray-fg}",
    tableSepCross: () => "{gray-fg}┼{/gray-fg}",
    tableSepH: () => "{gray-fg}─{/gray-fg}",
    tableHeaderCell: (value) => `{bold}{white-fg}${value}{/white-fg}{/bold}`,
    tableCell: (value) => value,
  };
}

function createAnsiAdapters() {
  // Ink always paints into a TTY-capable stdout; force color so bold/heading
  // styles survive even when chalk's autodetection thinks we're non-TTY
  // (e.g. piped test harnesses that still render Ink).
  const paint = typeof chalk.Instance === "function"
    ? new chalk.Instance({ level: Math.max(Number(chalk.level) || 0, 2) })
    : chalk;
  return {
    escape: (value) => String(value || ""),
    // Bold gets weight + brighter foreground so it reads even when the
    // terminal theme barely differentiates ANSI bold.
    bold: (value) => paint.bold.whiteBright(String(value || "")),
    italic: (value) => paint.italic.dim(String(value || "")),
    code: (value) => paint.yellow(String(value || "")),
    heading: (level, value) => {
      const depth = Math.max(1, Math.min(6, Number(level) || 1));
      const text = String(value || "");
      if (depth <= 2) return paint.bold.cyan(text);
      if (depth === 3) return paint.bold.blue(text);
      return paint.bold(text);
    },
    quoteMarker: () => paint.gray("│"),
    bulletMarker: () => paint.gray("•"),
    orderedMarker: (value) => paint.gray(`${value}.`),
    rule: () => paint.gray("────────────────────────"),
    fenceOpen: (language) => (
      language
        ? paint.gray(`┌ code:${language}`)
        : paint.gray("┌ code")
    ),
    fenceClose: () => paint.gray("└"),
    fenceBody: (value) => `${paint.gray("│")} ${paint.white(String(value || ""))}`,
    error: (value) => paint.red(String(value || "")),
    tablePipe: () => paint.gray("│"),
    tableSepCross: () => paint.gray("┼"),
    tableSepH: () => paint.gray("─"),
    tableHeaderCell: (value) => paint.bold.whiteBright(String(value || "")),
    tableCell: (value) => String(value || ""),
  };
}

/**
 * Apply inline markdown to a single line.
 * Scans left-to-right so **bold** wins over nested `code`/`*` patterns
 * (LLMs often emit **`name`** which previously left literal asterisks).
 */
function renderInlineMarkdown(input = "", adapters = createBlessedAdapters()) {
  const source = String(input || "");
  if (!source) return "";

  const escape = adapters.escape || ((value) => String(value || ""));
  const styleBold = adapters.bold || escape;
  const styleItalic = adapters.italic || escape;
  const styleCode = adapters.code || escape;

  if (!source.includes("`") && !source.includes("*") && !source.includes("_")) {
    return escape(source);
  }

  const renderInner = (chunk) => renderInlineMarkdown(chunk, adapters);

  let out = "";
  let i = 0;
  while (i < source.length) {
    // **bold** / __bold__
    if (source.startsWith("**", i) || source.startsWith("__", i)) {
      const mark = source.slice(i, i + 2);
      const close = source.indexOf(mark, i + 2);
      if (close !== -1) {
        const inner = source.slice(i + 2, close);
        out += styleBold(renderInner(inner));
        i = close + 2;
        continue;
      }
    }

    // `code`
    if (source[i] === "`") {
      const close = source.indexOf("`", i + 1);
      if (close !== -1) {
        let inner = source.slice(i + 1, close);
        // Code that is only a bold/italic wrapper → treat as emphasis.
        const boldOnly = inner.match(/^\*\*(.+)\*\*$/) || inner.match(/^__(.+)__$/);
        const italicOnly = !boldOnly && (inner.match(/^\*(.+)\*$/) || inner.match(/^_(.+)_$/));
        if (boldOnly) out += styleBold(renderInner(boldOnly[1]));
        else if (italicOnly) out += styleItalic(renderInner(italicOnly[1]));
        else out += styleCode(inner);
        i = close + 1;
        continue;
      }
    }

    // *italic* / _italic_ (single delimiter; avoid ** / __)
    if (
      (source[i] === "*" && source[i + 1] !== "*")
      || (source[i] === "_" && source[i + 1] !== "_")
    ) {
      const mark = source[i];
      const close = source.indexOf(mark, i + 1);
      if (close !== -1 && source[close + 1] !== mark) {
        const inner = source.slice(i + 1, close);
        if (inner && !inner.includes("\n")) {
          out += styleItalic(renderInner(inner));
          i = close + 1;
          continue;
        }
      }
    }

    // Accumulate plain run until the next markup candidate.
    let next = source.length;
    for (const ch of ["*", "_", "`"]) {
      const at = source.indexOf(ch, i + 1);
      if (at !== -1 && at < next) next = at;
    }
    // Also stop at `**` start from current if we failed to parse above.
    out += escape(source.slice(i, next));
    i = next === i ? i + 1 : next;
  }

  return out;
}

function renderTableBlock(rawRows = [], adapters = createBlessedAdapters()) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) return [];

  const rows = [];
  let alignments = [];
  let headerUsed = false;

  for (let i = 0; i < rawRows.length; i += 1) {
    const line = rawRows[i];
    if (isTableSeparatorLine(line)) {
      if (rows.length > 0 && !headerUsed) {
        rows[rows.length - 1].isHeader = true;
        headerUsed = true;
      }
      alignments = parseSeparatorAlignments(line, Math.max(alignments.length, parseTableCells(line).length));
      continue;
    }
    rows.push({
      cells: parseTableCells(line),
      isHeader: false,
    });
  }

  if (rows.length === 0) return [];

  const columnCount = rows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  while (alignments.length < columnCount) alignments.push("left");

  const widths = Array.from({ length: columnCount }, () => 1);
  for (const row of rows) {
    for (let c = 0; c < columnCount; c += 1) {
      widths[c] = Math.max(widths[c], plainCellWidth(row.cells[c] || ""));
    }
  }

  const pipe = adapters.tablePipe || (() => "│");
  const sepH = adapters.tableSepH || (() => "─");
  const sepCross = adapters.tableSepCross || (() => "┼");
  const styleHeader = adapters.tableHeaderCell || ((v) => v);
  const styleCell = adapters.tableCell || ((v) => v);

  const out = [];
  let wroteHeaderSep = false;

  for (const row of rows) {
    const renderedCells = [];
    for (let c = 0; c < columnCount; c += 1) {
      const rawCell = row.cells[c] || "";
      const inline = renderInlineMarkdown(rawCell, adapters);
      const plain = String(rawCell)
        .replace(/\*\*|__/g, "")
        .replace(/`/g, "")
        .replace(/\*/g, "");
      const alignedPlain = alignCell(plain, widths[c], alignments[c] || "left");
      const padRight = Math.max(0, visibleWidth(alignedPlain) - visibleWidth(plain));
      const styled = row.isHeader ? styleHeader(inline) : styleCell(inline);
      renderedCells.push(`${styled}${" ".repeat(padRight)}`);
    }
    out.push(`${pipe()} ${renderedCells.join(` ${pipe()} `)} ${pipe()}`);

    if (row.isHeader && !wroteHeaderSep) {
      const segments = widths.map((w) => {
        const unit = sepH();
        // sepH may be a styled string longer than 1 codepoint; repeat by width.
        return unit.repeat(Math.max(1, w));
      });
      out.push(
        `${pipe()}${sepH()}${segments.join(`${sepH()}${sepCross()}${sepH()}`)}${sepH()}${pipe()}`,
      );
      wroteHeaderSep = true;
    }
  }

  return out;
}

function renderMarkdownLinesWithAdapters(text = "", state = {}, adapters = createBlessedAdapters()) {
  const renderState = state && typeof state === "object" ? state : {};
  if (typeof renderState.inCodeBlock !== "boolean") {
    renderState.inCodeBlock = false;
  }

  const lines = String(text || "").split(/\r?\n/);
  const out = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const raw = stripLeakedEscapeTags(String(line || ""));
    const fenceMatch = raw.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!renderState.inCodeBlock) {
        const language = String(fenceMatch[3] || "").trim();
        out.push(adapters.fenceOpen(language));
        renderState.inCodeBlock = true;
      } else {
        out.push(adapters.fenceClose());
        renderState.inCodeBlock = false;
      }
      continue;
    }

    if (renderState.inCodeBlock) {
      out.push(adapters.fenceBody(raw));
      continue;
    }

    // GFM table block — collect contiguous pipe rows for column alignment.
    if (isTableRowLine(raw)) {
      const block = [raw];
      let look = index + 1;
      while (look < lines.length) {
        const nextRaw = stripLeakedEscapeTags(String(lines[look] || ""));
        if (!isTableRowLine(nextRaw)) break;
        block.push(nextRaw);
        look += 1;
      }
      const hasSep = block.some((row) => isTableSeparatorLine(row));
      if (hasSep || block.length >= 2) {
        out.push(...renderTableBlock(block, adapters));
        index = look - 1;
        continue;
      }
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      out.push(adapters.rule());
      continue;
    }

    const headingMatch = raw.match(/^(\s*)(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const indent = adapters.escape(headingMatch[1] || "");
      const level = String(headingMatch[2] || "#").length;
      const content = adapters.heading(
        level,
        renderInlineMarkdown(headingMatch[3] || "", adapters),
      );
      out.push(`${indent}${content}`);
      continue;
    }

    const quoteMatch = raw.match(/^(\s*)>\s?(.*)$/);
    if (quoteMatch) {
      const indent = adapters.escape(quoteMatch[1] || "");
      const content = renderInlineMarkdown(quoteMatch[2] || "", adapters);
      out.push(`${indent}${adapters.quoteMarker()} ${content}`);
      continue;
    }

    const bulletMatch = raw.match(/^(\s*)([-*+])\s+(.*)$/);
    if (bulletMatch) {
      const indent = adapters.escape(bulletMatch[1] || "");
      const content = renderInlineMarkdown(bulletMatch[3] || "", adapters);
      out.push(`${indent}${adapters.bulletMarker()} ${content}`);
      continue;
    }

    const orderedMatch = raw.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      const indent = adapters.escape(orderedMatch[1] || "");
      const content = renderInlineMarkdown(orderedMatch[3] || "", adapters);
      out.push(`${indent}${adapters.orderedMarker(orderedMatch[2] || "")} ${content}`);
      continue;
    }

    const errorMatch = raw.match(/^(\s*)(Error:\s+.*)$/i);
    if (errorMatch) {
      const indent = adapters.escape(errorMatch[1] || "");
      const content = renderInlineMarkdown(errorMatch[2] || "", adapters);
      out.push(`${indent}${adapters.error(content)}`);
      continue;
    }

    out.push(renderInlineMarkdown(raw, adapters));
  }

  return out;
}

function renderMarkdownLines(text = "", state = {}, escapeFn = (value) => String(value || "")) {
  return renderMarkdownLinesWithAdapters(text, state, createBlessedAdapters(escapeFn));
}

function renderMarkdownLinesAnsi(text = "", state = {}) {
  return renderMarkdownLinesWithAdapters(text, state, createAnsiAdapters());
}

module.exports = {
  stripLeakedEscapeTags,
  renderInlineMarkdown,
  renderMarkdownLines,
  renderMarkdownLinesAnsi,
  renderMarkdownLinesWithAdapters,
  createBlessedAdapters,
  createAnsiAdapters,
  isTableRowLine,
  isTableSeparatorLine,
  parseTableCells,
  renderTableBlock,
  createMarkdownTableBuffer,
  visibleWidth,
};
