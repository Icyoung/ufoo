"use strict";

/**
 * Helpers for expanding read_image tool results into provider vision blocks.
 */

function extractVisionPayload(toolResult = null) {
  if (!toolResult || typeof toolResult !== "object") return null;
  const base64 = String(toolResult.base64 || "").trim();
  const mediaType = String(toolResult.mediaType || "").trim().toLowerCase();
  if (!base64 || !mediaType.startsWith("image/")) return null;
  if (toolResult.ok === false) return null;
  return {
    path: String(toolResult.path || "").trim(),
    mediaType,
    bytes: Number.isFinite(toolResult.bytes) ? toolResult.bytes : null,
    base64,
    artifactId: String(toolResult.artifactId || "").trim(),
  };
}

function isVisionToolResult(toolResult = null) {
  return Boolean(extractVisionPayload(toolResult));
}

function stripVisionBase64(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stripVisionBase64(item));
  }
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "base64") continue;
    out[key] = stripVisionBase64(entry);
  }
  return out;
}

function visionSummaryText(vision = null, toolResult = null) {
  const pathText = (vision && vision.path) || (toolResult && toolResult.path) || "image";
  const mediaType = (vision && vision.mediaType) || (toolResult && toolResult.mediaType) || "image/*";
  const bytes = (vision && vision.bytes) != null
    ? vision.bytes
    : (toolResult && toolResult.bytes);
  const parts = [
    `Image loaded for vision: ${pathText}`,
    `mediaType=${mediaType}`,
  ];
  if (Number.isFinite(bytes)) parts.push(`bytes=${bytes}`);
  if (vision && vision.artifactId) parts.push(`artifactId=${vision.artifactId}`);
  parts.push("Visual content is attached for this model call only; call read_image again later if needed.");
  return parts.join(" | ");
}

function toAnthropicImageBlock(vision = null) {
  if (!vision) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: vision.mediaType,
      data: vision.base64,
    },
  };
}

function toOpenAiImagePart(vision = null) {
  if (!vision) return null;
  return {
    type: "image_url",
    image_url: {
      url: `data:${vision.mediaType};base64,${vision.base64}`,
    },
  };
}

function degradeVisionContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "").trim().toLowerCase();
    if (type === "text" && block.text) {
      texts.push(String(block.text));
      continue;
    }
    if (type === "image" || type === "image_url") {
      const pathHint = block.path
        || (block.source && block.source.path)
        || "";
      texts.push(pathHint ? `[image: ${pathHint}]` : "[image]");
      continue;
    }
    if (type === "tool_result" && Array.isArray(block.content)) {
      texts.push(degradeVisionContent(block.content));
    }
  }
  return texts.filter(Boolean).join("\n") || "[multimodal content]";
}

// Retire only visual blocks after a successful model call. In particular,
// preserve Anthropic tool_result envelopes and their tool_use_id linkage.
function retireVisionContent(content) {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const retired = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const type = String(block.type || "").toLowerCase();
    if (type === "image" || type === "image_url" || type === "input_image") {
      changed = true;
      const pathHint = block.path || (block.source && block.source.path) || "";
      return {
        type: "text",
        text: pathHint
          ? `[image already viewed: ${pathHint}; use read_image to view again]`
          : "[image already viewed; use read_image with the recorded path to view again]",
      };
    }
    if (Array.isArray(block.content)) {
      const nested = retireVisionContent(block.content);
      if (nested !== block.content) {
        changed = true;
        return { ...block, content: nested };
      }
    }
    return block;
  });
  return changed ? retired : content;
}

function retireMessageImages(messages = []) {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message && Array.isArray(message.content)) {
      const content = retireVisionContent(message.content);
      if (content !== message.content) messages[i] = { ...message, content };
    }
  }
}

module.exports = {
  extractVisionPayload,
  isVisionToolResult,
  stripVisionBase64,
  visionSummaryText,
  toAnthropicImageBlock,
  toOpenAiImagePart,
  degradeVisionContent,
  retireMessageImages,
};
