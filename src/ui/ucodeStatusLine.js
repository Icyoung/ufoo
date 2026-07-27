"use strict";

/**
 * Pure ucode status-line helpers (shared by Rust host tests / plan UI).
 */

const fmt = require("./format");

function inferStatusType(text = "", requestedType = "") {
  const type = String(requestedType || "").trim().toLowerCase();
  if (type === "done" || type === "success" || type === "error" || type === "idle" || type === "none") {
    return type;
  }
  const clean = String(text || "").trim();
  if (/^[✗!]/.test(clean) || /\b(error|failed|failure)\b/i.test(clean) || /失败|错误/.test(clean)) return "error";
  if (
    /^[✓✔]/.test(clean) ||
    /^(done|complete|completed|finished|success|succeeded|ready)\b/i.test(clean) ||
    /\bdone\s*$/i.test(clean) ||
    /完成|成功/.test(clean)
  ) return "done";
  return type || "thinking";
}

function collapseThinkingTail(text, maxChars = 80) {
  const collapsed = String(text || "").replace(/\s+/g, " ").trim();
  const parsed = Number(maxChars);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 80;
  if (!collapsed) return "";

  let candidate = collapsed;
  const boldParts = collapsed.match(/\*\*[^*]+\*\*/g);
  if (boldParts && boldParts.length > 0) {
    candidate = boldParts[boldParts.length - 1].replace(/\*/g, "").trim() || candidate;
  } else {
    const clauses = collapsed.split(/(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
    if (clauses.length > 1) candidate = clauses[clauses.length - 1];
  }

  if (candidate.length <= limit) return candidate;
  return `…${candidate.slice(-(limit - 1))}`;
}

function computeStatusText(status, spinnerTick, backgroundSuffix = "", idlePlanHint = "") {
  const message = String((status && status.message) || "");
  const suffix = String(backgroundSuffix || "");
  if (!message) {
    const hint = String(idlePlanHint || "").trim();
    return hint ? `UCODE · Ready · ${hint}${suffix}` : `UCODE · Ready${suffix}`;
  }
  const type = inferStatusType(message, status && status.type);
  if (type === "done" || type === "success") {
    const clean = message.trim();
    return `${/^[✓✔]/.test(clean) ? clean : `✓ ${clean}`}${suffix}`;
  }
  if (type === "error") {
    const clean = message.trim();
    return `${/^[✗!]/.test(clean) ? clean : `✗ ${clean}`}${suffix}`;
  }
  if (type === "idle" || type === "none") return `${message.trim() || "UCODE · Ready"}${suffix}`;
  const indicators = fmt.STATUS_INDICATORS[type] || fmt.STATUS_INDICATORS.thinking;
  const indicator = indicators[Math.max(0, Math.floor(Number(spinnerTick) || 0)) % indicators.length];
  const startedAt = Number.isFinite(status && status.startedAt) ? status.startedAt : 0;
  const timerText = status && status.showTimer && startedAt
    ? ` (${fmt.formatPendingElapsed(Date.now() - startedAt)}, esc cancel)`
    : "";
  return `${indicator} ${message}${timerText}${suffix}`;
}

module.exports = {
  inferStatusType,
  collapseThinkingTail,
  computeStatusText,
};
