"use strict";

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
    return { kind: "error", marker: "!", speaker: "error", body: clean.replace(/^(error:\s*)/i, "") };
  }
  if (/^(✓|✔|done\b|closed\b)/i.test(trimmed)) {
    return { kind: "success", marker: "✓", speaker: "", body: clean.replace(/^[✓✔]\s*/, "") };
  }
  const dotMatch = clean.match(/^([^·\n]{1,64})\s+·\s+(.*)$/);
  if (dotMatch) {
    const speaker = dotMatch[1].trim();
    const lower = speaker.toLowerCase();
    const kind = lower === "ufoo" ? "assistant" : "agent";
    return { kind, marker: kind === "assistant" ? "◆" : "•", speaker, body: dotMatch[2] || " " };
  }
  const colonMatch = clean.match(/^([A-Za-z0-9_.:@/-]{1,42}):\s+(.*)$/);
  if (colonMatch) {
    return { kind: "agent", marker: "•", speaker: colonMatch[1], body: colonMatch[2] || " " };
  }
  return { kind: "plain", marker: "", speaker: "", body: clean };
}

function defaultMarkerForKind(kind = "", speaker = "") {
  if (kind === "assistant") return "◆";
  if (kind === "agent") return "•";
  if (kind === "error") return "!";
  if (kind === "success") return "✓";
  if (kind === "divider") return "─";
  if (kind === "meta") return "·";
  if (kind === "banner" || kind === "spacer") return " ";
  return speaker ? "•" : "";
}

function buildChatLogLineModel(input = "") {
  if (input && typeof input === "object" && !input.kind) {
    return buildChatLogLineModel(chatLogEntryText(input));
  }

  if (input && typeof input === "object" && input.kind) {
    const kind = String(input.kind || "plain");
    const speaker = String(input.speaker || "");
    const marker = input.marker != null ? String(input.marker) : defaultMarkerForKind(kind, speaker);
    const rawBody = input.bodyText != null
      ? String(input.bodyText)
      : String(input.body != null ? input.body : chatLogEntryText(input));
    const body = kind === "plain" ? compactContinuationIndent(rawBody || " ") : (rawBody || " ");
    return {
      kind,
      marker,
      speaker,
      body: input.body != null ? String(input.body) : rawBody,
      markerText: input.markerText != null
        ? String(input.markerText)
        : (speaker ? `${marker || " "}  ` : `${marker || " "} `),
      bodyText: body,
    };
  }

  const row = classifyChatLogLine(input);
  const hasSpeaker = Boolean(row.speaker);
  const body = row.kind === "plain"
    ? compactContinuationIndent(row.body || " ")
    : (row.body || " ");
  return {
    ...row,
    markerText: hasSpeaker ? `${row.marker || " "}  ` : `${row.marker || " "} `,
    bodyText: body,
  };
}

function normalizeEntryInput(input) {
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  return { text: input };
}

function createChatLogEntry(input = "", id = "") {
  const source = normalizeEntryInput(input);
  const text = String(source.text != null ? source.text : chatLogEntryText(source));
  const row = source.kind
    ? buildChatLogLineModel({ ...source, text })
    : buildChatLogLineModel(text);
  const meta = source.meta && typeof source.meta === "object" && !Array.isArray(source.meta)
    ? { ...source.meta }
    : {};
  const entry = {
    id: String(id || source.id || ""),
    text,
    kind: row.kind,
    marker: row.marker,
    speaker: row.speaker,
    body: row.body,
    markerText: row.markerText,
    bodyText: row.bodyText,
    sourceType: String(source.sourceType || source.type || ""),
    meta,
  };
  return entry;
}

function chatLogEntryText(entry = "") {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  if (entry.text != null) return String(entry.text);
  if (entry.speaker) return `${entry.speaker} · ${entry.bodyText || entry.body || ""}`;
  return String(entry.bodyText || entry.body || "");
}

function canAppendToChatLogGroup(group, row) {
  if (!group || !row) return false;
  if (row.kind !== "plain" && row.kind !== "spacer") return false;
  return group.kind === "assistant"
    || group.kind === "agent"
    || group.kind === "success"
    || group.kind === "error"
    || group.kind === "meta"
    || group.kind === "plain";
}

function buildChatLogGroups(items = []) {
  const source = Array.isArray(items) ? items : [];
  const groups = [];
  let current = null;
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index] || {};
    const itemId = item && typeof item === "object" && item.id ? item.id : `log-${index}`;
    const row = buildChatLogLineModel(item);
    const entry = {
      id: itemId,
      text: chatLogEntryText(item),
      row,
      sourceType: item && typeof item === "object" ? String(item.sourceType || item.type || "") : "",
      meta: item && typeof item === "object" && item.meta ? item.meta : {},
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
  compactContinuationIndent,
  compactDividerLabel,
  classifyChatLogLine,
  buildChatLogLineModel,
  buildChatLogGroups,
  createChatLogEntry,
  chatLogEntryText,
};
