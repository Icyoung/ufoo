/**
 * Shared blessed-compatible markdown renderer for TUI output.
 *
 * Used by both ucode TUI and ufoo chat to render agent responses
 * with fenced code blocks, headings, quotes, bullets, inline code, etc.
 */

function stripLeakedEscapeTags(text = "") {
  const source = String(text == null ? "" : text);
  const withoutClosedTags = source.replace(/\{[^{}\n]*escape[^{}\n]*\}/gi, "");
  const withoutDanglingEscape = withoutClosedTags.replace(/\{\s*\/?\s*escape[\s\S]*$/gi, "");
  return withoutDanglingEscape.replace(/\{\s*\/?\s*e?s?c?a?p?e?[^{}\n]*$/gi, "");
}

function renderMarkdownLines(text = "", state = {}, escapeFn = (value) => String(value || "")) {
  const renderState = state && typeof state === "object" ? state : {};
  if (typeof renderState.inCodeBlock !== "boolean") {
    renderState.inCodeBlock = false;
  }

  const renderInlineCode = (input = "") => {
    const source = String(input || "");
    if (!source) return "";
    if (!source.includes("`")) return escapeFn(source);

    let out = "";
    let cursor = 0;
    const pattern = /`([^`\n]+)`/g;
    let match = pattern.exec(source);
    while (match) {
      const index = Number(match.index) || 0;
      if (index > cursor) {
        out += escapeFn(source.slice(cursor, index));
      }
      out += `{yellow-fg}${escapeFn(match[1])}{/yellow-fg}`;
      cursor = index + match[0].length;
      match = pattern.exec(source);
    }
    if (cursor < source.length) {
      out += escapeFn(source.slice(cursor));
    }
    return out;
  };

  const lines = String(text || "").split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const raw = stripLeakedEscapeTags(String(line || ""));
    const fenceMatch = raw.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!renderState.inCodeBlock) {
        const language = String(fenceMatch[3] || "").trim();
        const label = language
          ? `┌ code:${escapeFn(language)}`
          : "┌ code";
        out.push(`{gray-fg}${label}{/gray-fg}`);
        renderState.inCodeBlock = true;
      } else {
        out.push("{gray-fg}└{/gray-fg}");
        renderState.inCodeBlock = false;
      }
      continue;
    }

    if (renderState.inCodeBlock) {
      out.push(`{gray-fg}│{/gray-fg} {white-fg}${escapeFn(raw)}{/white-fg}`);
    } else {
      const headingMatch = raw.match(/^(\s*)(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const indent = escapeFn(headingMatch[1] || "");
        const marks = escapeFn(headingMatch[2] || "");
        const content = renderInlineCode(headingMatch[3] || "");
        out.push(`${indent}{cyan-fg}${marks}{/cyan-fg} {bold}${content}{/bold}`);
        continue;
      }

      const quoteMatch = raw.match(/^(\s*)>\s?(.*)$/);
      if (quoteMatch) {
        const indent = escapeFn(quoteMatch[1] || "");
        const content = renderInlineCode(quoteMatch[2] || "");
        out.push(`${indent}{gray-fg}▍{/gray-fg} ${content}`);
        continue;
      }

      const bulletMatch = raw.match(/^(\s*)([-*+])\s+(.*)$/);
      if (bulletMatch) {
        const indent = escapeFn(bulletMatch[1] || "");
        const content = renderInlineCode(bulletMatch[3] || "");
        out.push(`${indent}{gray-fg}•{/gray-fg} ${content}`);
        continue;
      }

      const orderedMatch = raw.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (orderedMatch) {
        const indent = escapeFn(orderedMatch[1] || "");
        const order = escapeFn(orderedMatch[2] || "");
        const content = renderInlineCode(orderedMatch[3] || "");
        out.push(`${indent}{gray-fg}${order}.{/gray-fg} ${content}`);
        continue;
      }

      const errorMatch = raw.match(/^(\s*)(Error:\s+.*)$/i);
      if (errorMatch) {
        const indent = escapeFn(errorMatch[1] || "");
        const content = renderInlineCode(errorMatch[2] || "");
        out.push(`${indent}{red-fg}${content}{/red-fg}`);
        continue;
      }

      out.push(renderInlineCode(raw));
    }
  }

  return out;
}

module.exports = {
  stripLeakedEscapeTags,
  renderMarkdownLines,
};
