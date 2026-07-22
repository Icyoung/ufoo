"use strict";

const { renderMarkdownLinesAnsi } = require("../format/markdownRenderer");

// Match ucode: markdown only for conversational prose. System/user rows stay
// plain so app-generated prefixes (›, ✓, Error:) keep Ink color control.
const MARKDOWN_BODY_KINDS = new Set(["assistant", "agent", "report"]);

function stripBlessedTags(text = "") {
  return String(text || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\{\/?[^{}\n]+\}/g, "")
    .replace(/\r/g, "");
}

function stripMarkdownDecorators(text = "") {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function compactContinuationIndent(text = "") {
  return String(text || "").replace(/^\s{8,}(?=\S)/, "");
}

function compactDividerLabel(text = "") {
  const label = String(text || "")
    .trim()
    .replace(/^─+\s*/, "")
    .replace(/\s*─+$/, "")
    .trim();
  return label || String(text || "").trim() || "section";
}

function stripUserPromptPrefix(text = "") {
  return String(text || "").replace(/^›\s*/, "");
}

function splitSpeakerBody(raw = "") {
  const source = String(raw || "");
  const dotIdx = source.indexOf(" · ");
  if (dotIdx >= 0) {
    return {
      speaker: source.slice(0, dotIdx).trim(),
      body: source.slice(dotIdx + 3),
    };
  }
  const colonMatch = source.match(/^([A-Za-z0-9_.:@/-]{1,42}):\s+(.*)$/);
  if (colonMatch) {
    return { speaker: colonMatch[1], body: colonMatch[2] || "" };
  }
  return { speaker: "", body: source };
}

function formatChatLogBody(body = "", kind = "plain", markdownState = null) {
  const text = String(body || "");
  const state = markdownState && typeof markdownState === "object"
    ? markdownState
    : { inCodeBlock: false };
  // Continuations inside an open fence stay plain-kind but still need the
  // shared ANSI renderer so the fence closes cleanly (same as ucode).
  const allowMarkdown = MARKDOWN_BODY_KINDS.has(kind) || state.inCodeBlock === true;
  if (!allowMarkdown) return text;
  // Structural markers / empty rows stay untouched.
  if (!text.trim() && !state.inCodeBlock) return text;
  try {
    const lines = renderMarkdownLinesAnsi(text, state);
    if (!Array.isArray(lines) || lines.length === 0) return text;
    return lines.length === 1 ? lines[0] : lines.join("\n");
  } catch {
    return text;
  }
}

function classifyChatLogLine(text = "") {
  const raw = stripBlessedTags(text).replace(/\r/g, "");
  const clean = stripMarkdownDecorators(raw);
  const trimmed = clean.trim();
  if (!trimmed) return { kind: "spacer", marker: " ", speaker: "", body: " " };
  if (/^[█▀▄ ]+(?:\s{2,}(?:Version|Mode|Dictionary):.*)?$/.test(trimmed) || /^ufoo chat/i.test(trimmed)) {
    return { kind: "banner", marker: " ", speaker: "", body: clean };
  }
  if (/^───.*───$/.test(trimmed)) {
    return { kind: "divider", marker: "─", speaker: "", body: clean };
  }
  if (/^(CHAT|UCODE)\s+·/i.test(trimmed)) {
    return { kind: "meta", marker: "·", speaker: "", body: clean };
  }
  if (/^(error:|✗|failed\b)/i.test(trimmed)) {
    const rawBody = raw.replace(/^(error:\s*)/i, "");
    return {
      kind: "error",
      marker: "!",
      speaker: "error",
      body: rawBody || clean.replace(/^(error:\s*)/i, ""),
    };
  }
  if (/^(✓|✔|done\b|closed\b)/i.test(trimmed)) {
    const rawBody = raw.replace(/^[✓✔]\s*/, "");
    return {
      kind: "success",
      marker: "✓",
      speaker: "",
      body: rawBody || clean.replace(/^[✓✔]\s*/, ""),
    };
  }
  // ucode-style user prompt already embedded in text
  if (/^›\s/.test(raw) || raw === "›") {
    return {
      kind: "user",
      marker: "›",
      speaker: "",
      body: stripUserPromptPrefix(raw) || " ",
    };
  }
  const cleanDot = clean.match(/^([^·\n]{1,64})\s+·\s+(.*)$/);
  if (cleanDot) {
    const parts = splitSpeakerBody(raw);
    const speaker = stripMarkdownDecorators(parts.speaker || cleanDot[1]).trim();
    const lower = speaker.toLowerCase();
    const kind = lower === "ufoo" ? "assistant" : "agent";
    return {
      kind,
      marker: kind === "assistant" ? "◆" : "◇",
      speaker,
      body: parts.body != null ? parts.body : (cleanDot[2] || " "),
    };
  }
  const cleanColon = clean.match(/^([A-Za-z0-9_.:@/-]{1,42}):\s+(.*)$/);
  if (cleanColon) {
    const parts = splitSpeakerBody(raw);
    return {
      kind: "agent",
      marker: "◇",
      speaker: stripMarkdownDecorators(parts.speaker || cleanColon[1]).trim(),
      body: parts.body != null ? parts.body : (cleanColon[2] || " "),
    };
  }
  return { kind: "plain", marker: "", speaker: "", body: raw || clean };
}

/**
 * Map router/history sourceType onto a display row. Heuristic classification
 * still runs first so speaker/body parsing stays shared; sourceType only
 * upgrades or specializes the visual role (user / system / report / …).
 */
function applySourceTypeToRow(row, sourceType = "", meta = {}) {
  const base = row && typeof row === "object" ? { ...row } : classifyChatLogLine("");
  const type = String(sourceType || "").toLowerCase();
  const event = String((meta && (meta.event || meta.Event)) || "").toLowerCase();
  const isReport = type === "report" || event === "controller_report";

  if (type === "user") {
    if (base.kind === "spacer") {
      return {
        ...base,
        kind: "user",
        marker: " ",
        speaker: "",
        body: " ",
      };
    }
    // Indented continuations of a multi-line user echo stay user-colored
    // without a second › marker.
    if (base.kind === "plain" && /^\s{2,}\S/.test(String(base.body || ""))) {
      return {
        ...base,
        kind: "user",
        marker: " ",
        speaker: "",
        body: base.body || " ",
      };
    }
    return {
      ...base,
      kind: "user",
      marker: "›",
      speaker: "",
      body: stripUserPromptPrefix(base.body || ""),
    };
  }
  if (type === "error") {
    if (base.kind === "plain" || base.kind === "spacer") return base;
    return {
      ...base,
      kind: "error",
      marker: base.marker === "!" ? base.marker : "!",
      speaker: base.speaker || "error",
    };
  }
  if (isReport) {
    // Keep indented continuations foldable under the report head.
    if (base.kind === "plain" || base.kind === "spacer") return base;
    const speaker = base.speaker || "report";
    return {
      ...base,
      kind: "report",
      // Prefer ● over ▣: square box glyphs sit off the Latin baseline in
      // most terminal fonts and look misaligned next to speaker · body.
      marker: "●",
      speaker,
      body: base.body || " ",
    };
  }
  if (type === "bus") {
    if (base.kind === "plain" || base.kind === "spacer" || base.kind === "success" || base.kind === "error") {
      return base;
    }
    if (base.kind === "assistant") return base;
    return {
      ...base,
      kind: "agent",
      marker: base.marker === "◆" ? "◆" : "◇",
      speaker: base.speaker || "bus",
    };
  }
  if (type === "reply") {
    if (base.kind === "plain" || base.kind === "spacer") return base;
    return {
      ...base,
      kind: "assistant",
      marker: "◆",
      speaker: base.speaker || "ufoo",
    };
  }
  if (type === "system" || type === "disambiguate") {
    // Keep success/error markers when the line already carries them.
    if (base.kind === "success" || base.kind === "error" || base.kind === "divider" || base.kind === "banner") {
      return base;
    }
    if (base.kind === "spacer") return base;

    const body = String(base.body || "");
    // Config / list detail rows already ship their own "  • …" prefix from
    // commandExecutor. Keep them plain so they fold under the ✓ header and
    // don't pick up a competing tiny "·" gutter glyph.
    if (/^\s*[•·\-*]/.test(body) || /^\s{2,}\S/.test(body)) {
      return {
        ...base,
        kind: "plain",
        marker: "",
        speaker: "",
      };
    }

    // Bare system notices: dim text, no extra marker competing with ›/◆/◇/✓.
    return {
      ...base,
      kind: "system",
      marker: " ",
      speaker: "",
    };
  }
  return base;
}

function defaultMarkerForKind(kind = "", speaker = "") {
  if (kind === "user") return "›";
  if (kind === "assistant") return "◆";
  if (kind === "agent") return "◇";
  if (kind === "report") return "●";
  if (kind === "error") return "!";
  if (kind === "success") return "✓";
  if (kind === "divider") return "─";
  if (kind === "meta" || kind === "system") return "·";
  if (kind === "banner" || kind === "spacer") return " ";
  return speaker ? "◇" : "";
}

function markerTextForRow(kind, marker, speaker) {
  if (kind === "user") return marker === "›" ? "› " : "  ";
  if (speaker) return `${marker || " "}  `;
  if (kind === "system") return marker && marker !== " " && marker !== "·" ? `${marker} ` : "  ";
  return `${marker || " "} `;
}

function buildChatLogLineModel(input = "", options = {}) {
  const markdownState = options && options.markdownState;
  const optionSourceType = options && options.sourceType != null ? options.sourceType : "";
  const optionMeta = options && options.meta && typeof options.meta === "object" ? options.meta : {};

  if (input && typeof input === "object" && !input.kind && input.text == null && input.body == null) {
    return buildChatLogLineModel(chatLogEntryText(input), options);
  }

  if (input && typeof input === "object" && (input.kind || input.text != null || input.sourceType || input.type)) {
    const sourceType = String(optionSourceType || input.sourceType || input.type || "");
    const meta = input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)
      ? { ...optionMeta, ...input.meta }
      : optionMeta;
    const text = input.text != null ? String(input.text) : chatLogEntryText(input);

    // Prefer re-deriving from text + sourceType when markdown fence state must
    // advance across lines; otherwise reuse a pre-classified object.
    if (!input.kind || sourceType || markdownState) {
      const classified = applySourceTypeToRow(classifyChatLogLine(text), sourceType, meta);
      const kind = classified.kind;
      const speaker = classified.speaker;
      const marker = classified.marker != null ? classified.marker : defaultMarkerForKind(kind, speaker);
      const rawBody = kind === "user"
        ? stripUserPromptPrefix(classified.body || " ")
        : kind === "plain"
          ? compactContinuationIndent(classified.body || " ")
          : (classified.body || " ");
      const bodyText = formatChatLogBody(rawBody, kind, markdownState || { inCodeBlock: false });
      return {
        kind,
        marker,
        speaker,
        body: classified.body,
        markerText: markerTextForRow(kind, marker, speaker),
        bodyText,
      };
    }

    const kind = String(input.kind || "plain");
    const speaker = String(input.speaker || "");
    const marker = input.marker != null ? String(input.marker) : defaultMarkerForKind(kind, speaker);
    const rawBody = input.bodyText != null
      ? String(input.bodyText)
      : String(input.body != null ? input.body : chatLogEntryText(input));
    const body = kind === "plain" ? compactContinuationIndent(rawBody || " ") : (rawBody || " ");
    const bodyText = markdownState
      ? formatChatLogBody(body, kind, markdownState)
      : body;
    return {
      kind,
      marker,
      speaker,
      body: input.body != null ? String(input.body) : rawBody,
      markerText: input.markerText != null
        ? String(input.markerText)
        : markerTextForRow(kind, marker, speaker),
      bodyText,
    };
  }

  const sourceType = String(optionSourceType || "");
  const row = applySourceTypeToRow(classifyChatLogLine(input), sourceType, optionMeta);
  const body = row.kind === "plain"
    ? compactContinuationIndent(row.body || " ")
    : row.kind === "user"
      ? stripUserPromptPrefix(row.body || " ")
      : (row.body || " ");
  return {
    ...row,
    markerText: markerTextForRow(row.kind, row.marker, row.speaker),
    bodyText: formatChatLogBody(body, row.kind, markdownState || { inCodeBlock: false }),
  };
}

function normalizeEntryInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { text: input };
  }
  // Defend against nested payloads like `{ text: { text, sourceType } }`
  // (e.g. history objects fed through createInitialState as `text: line`).
  let text = input.text;
  let sourceType = input.sourceType || input.type || "";
  let meta = input.meta;
  if (text && typeof text === "object" && !Array.isArray(text)) {
    sourceType = sourceType || text.sourceType || text.type || "";
    if (!meta && text.meta && typeof text.meta === "object") meta = text.meta;
    text = text.text != null ? text.text : chatLogEntryText(text);
  }
  return {
    ...input,
    text: text != null ? text : "",
    sourceType,
    type: sourceType || input.type || "",
    meta: meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {},
  };
}

function createChatLogEntry(input = "", id = "", options = {}) {
  const source = normalizeEntryInput(input);
  const text = String(source.text != null ? source.text : "");
  const markdownState = options && options.markdownState
    ? options.markdownState
    : { inCodeBlock: false };
  const meta = source.meta && typeof source.meta === "object" && !Array.isArray(source.meta)
    ? { ...source.meta }
    : {};
  const sourceType = String(source.sourceType || source.type || options.sourceType || "");
  const row = buildChatLogLineModel({
    ...source,
    text,
    sourceType,
    meta,
  }, { markdownState, sourceType, meta });
  const entry = {
    id: String(id || source.id || ""),
    text,
    kind: row.kind,
    marker: row.marker,
    speaker: row.speaker,
    body: row.body,
    markerText: row.markerText,
    bodyText: row.bodyText,
    sourceType,
    meta,
  };
  return entry;
}

function chatLogEntryText(entry = "") {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  if (entry.text != null) return String(entry.text);
  if (entry.kind === "user") {
    const body = stripUserPromptPrefix(entry.bodyText || entry.body || "");
    return body ? `› ${body}` : "›";
  }
  if (entry.speaker) return `${entry.speaker} · ${entry.bodyText || entry.body || ""}`;
  return String(entry.bodyText || entry.body || "");
}

function canAppendToChatLogGroup(group, row) {
  if (!group || !row) return false;
  if (group.kind === "user" && row.kind === "user" && row.marker !== "›") return true;
  if (row.kind !== "plain" && row.kind !== "spacer") return false;
  return group.kind === "assistant"
    || group.kind === "agent"
    || group.kind === "report"
    || group.kind === "success"
    || group.kind === "error"
    || group.kind === "meta"
    || group.kind === "system"
    || group.kind === "plain";
}

function buildChatLogGroups(items = []) {
  const source = Array.isArray(items) ? items : [];
  const groups = [];
  let current = null;
  const markdownState = { inCodeBlock: false };
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index] || {};
    const itemId = item && typeof item === "object" && item.id ? item.id : `log-${index}`;
    const text = item && typeof item === "object" && item.text != null
      ? String(item.text)
      : chatLogEntryText(item);
    const sourceType = item && typeof item === "object" ? String(item.sourceType || item.type || "") : "";
    const meta = item && typeof item === "object" && item.meta ? item.meta : {};
    const row = buildChatLogLineModel(
      item && typeof item === "object"
        ? { ...item, text, sourceType, meta }
        : text,
      { markdownState, sourceType, meta }
    );
    const entry = {
      id: itemId,
      text,
      row,
      sourceType,
      meta,
      continuation: false,
    };

    if (canAppendToChatLogGroup(current, row)) {
      entry.continuation = true;
      current.entries.push(entry);
      continue;
    }

    current = {
      id: entry.id,
      kind: row.kind,
      entries: [entry],
    };
    groups.push(current);
  }
  return groups;
}

module.exports = {
  stripBlessedTags,
  stripMarkdownDecorators,
  stripUserPromptPrefix,
  compactContinuationIndent,
  compactDividerLabel,
  classifyChatLogLine,
  applySourceTypeToRow,
  buildChatLogLineModel,
  formatChatLogBody,
  createChatLogEntry,
  chatLogEntryText,
  canAppendToChatLogGroup,
  buildChatLogGroups,
  MARKDOWN_BODY_KINDS,
};
