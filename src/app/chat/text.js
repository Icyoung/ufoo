function neutralizeBlessedCommaTags(text) {
  if (text == null) return "";
  const raw = String(text);
  if (!raw.includes("{")) return raw;
  return raw.replace(/\{\/?[\w\-,;!#]*[;,][\w\-,;!#]*\}/g, (m) => {
    const inner = m.slice(1, -1).replace(/[,;]/g, (ch) => `${ch} `);
    return `{${inner}}`;
  });
}

function escapeBlessed(text) {
  if (text == null) return "";
  const raw = neutralizeBlessedCommaTags(text);
  if (!raw) return "";
  // Avoid allowing payload to terminate escape mode.
  const safe = raw.replace(/\{\/escape\}/g, "{open}/escape{close}");
  return `{escape}${safe}{/escape}`;
}

function decodeEscapedNewlines(text) {
  if (text == null) return "";
  return String(text).replace(/\\n/g, "\n");
}

function stripBlessedTags(text) {
  if (text == null) return "";
  return String(text).replace(/\{[^}]+\}/g, "");
}

function stripAnsi(text) {
  if (text == null) return "";
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function truncateAnsi(text, maxVisible) {
  if (text == null) return "";
  if (maxVisible <= 0) return "";
  const input = String(text);
  let out = "";
  let visible = 0;
  let i = 0;
  let truncated = false;
  while (i < input.length && visible < maxVisible) {
    if (input[i] === "\x1b") {
      const match = input.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    out += input[i];
    i += 1;
    visible += 1;
  }
  if (i < input.length) truncated = true;
  if (truncated) out += "\x1b[0m";
  return out;
}

function truncateText(text, maxWidth) {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

module.exports = {
  neutralizeBlessedCommaTags,
  escapeBlessed,
  decodeEscapedNewlines,
  stripBlessedTags,
  stripAnsi,
  truncateAnsi,
  truncateText,
};
