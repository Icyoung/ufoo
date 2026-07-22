"use strict";

const {
  normalizeTranscriptEvent,
  createTranscriptEventId,
  appendTranscriptEvent,
} = require("./transcript");
const { stripVisionBase64, degradeVisionContent } = require("../providers/visionBlocks");

function messageRole(message = {}) {
  return String(message && message.role || "").trim().toLowerCase();
}

function isToolRoleMessage(message = {}) {
  const role = messageRole(message);
  if (role === "tool") return true;
  if (Array.isArray(message.content)) {
    return message.content.some((block) => block && block.type === "tool_result");
  }
  return false;
}

function parseToolArtifactContent(content = "") {
  if (typeof content !== "string" || !content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    const artifactId = String(parsed.artifactId || "").trim();
    if (!artifactId) return null;
    return {
      artifactId,
      preview: String(parsed.preview || "").trim(),
    };
  } catch {
    return null;
  }
}

function contentForStorage(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const hasVision = content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const type = String(block.type || "").trim().toLowerCase();
      return type === "image" || type === "image_url"
        || (type === "tool_result" && Array.isArray(block.content));
    });
    if (hasVision) return degradeVisionContent(stripVisionBase64(content));
    return stripVisionBase64(content);
  }
  if (content && typeof content === "object") {
    return stripVisionBase64(content);
  }
  return content;
}

function messageToTranscriptEventForStorage(message = {}, extra = {}) {
  if (!message || typeof message !== "object") return null;
  const role = messageRole(message);
  if (!role) return null;

  const base = {
    id: createTranscriptEventId(),
    role,
    createdAt: new Date().toISOString(),
    ...extra,
  };

  if (isToolRoleMessage(message)) {
    const artifact = parseToolArtifactContent(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content || ""),
    );
    if (artifact) {
      return normalizeTranscriptEvent({
        ...base,
        role: "tool",
        artifactId: artifact.artifactId,
        preview: artifact.preview,
        toolCallId: message.tool_call_id ? String(message.tool_call_id) : undefined,
      });
    }
    const stored = contentForStorage(message.content);
    const preview = typeof stored === "string"
      ? stored.slice(0, 600)
      : JSON.stringify(stored).slice(0, 600);
    return normalizeTranscriptEvent({
      ...base,
      role: "tool",
      preview,
      toolCallId: message.tool_call_id ? String(message.tool_call_id) : undefined,
      content: preview,
    });
  }

  if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return normalizeTranscriptEvent({
      ...base,
      content: contentForStorage(message.content),
      toolCalls: message.tool_calls,
    });
  }

  return normalizeTranscriptEvent({
    ...base,
    content: contentForStorage(message.content),
  });
}

function appendTranscriptMessagesForStorage(workspaceRoot = process.cwd(), sessionId = "", messages = [], extra = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const appended = [];
  for (const message of list) {
    const event = messageToTranscriptEventForStorage(message, extra);
    if (!event) continue;
    const result = appendTranscriptEvent(workspaceRoot, sessionId, event);
    if (result.ok) appended.push(result.event);
  }
  return appended;
}

module.exports = {
  parseToolArtifactContent,
  messageToTranscriptEventForStorage,
  appendTranscriptMessagesForStorage,
  isToolRoleMessage,
};
