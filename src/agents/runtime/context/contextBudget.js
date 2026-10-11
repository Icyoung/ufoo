"use strict";

const { createHash } = require("crypto");
const { stripVisionBase64, retireMessageImages } = require("../../providers/transports/visionBlocks");
const { stableStringify } = require("../core/stableJson");

// Conservative local estimate; provider usage calibrates it in the loop.
function estimateTextTokens(text = "") {
  let tokens = 0;
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    tokens += code >= 0x2e80 ? 1.5 : 0.35;
  }
  return Math.ceil(tokens);
}

function summaryMessage(message) {
  const retired = [stripVisionBase64(message)];
  retireMessageImages(retired);
  const value = retired[0];
  return { role: value.role, content: value.content, tool_calls: value.tool_calls,
    tool_call_id: value.tool_call_id };
}

function imageCount(value) {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + imageCount(item), 0);
  if (!value || typeof value !== "object") return 0;
  if (["image", "image_url", "input_image"].includes(value.type)) return 1;
  return imageCount(value.content);
}

function estimateMessagesTokens(messages = []) {
  // Encoded image bytes are neither text tokens nor summary input. Reserve a
  // conservative visual allowance while retaining live images for the model.
  return messages.reduce((sum, message) => sum + 12 + imageCount(message) * 2000
    + estimateTextTokens(JSON.stringify(summaryMessage(message))), 0);
}

function historyDigest(messages = []) {
  // Artifact previews can change after restoration; their immutable artifact
  // identity stays stable. Non-artifact results still hash their full text.
  const identity = messages.map(message => {
    const value = summaryMessage(message);
    if (value.role === "tool" && value.tool_call_id && typeof value.content === "string") {
      try {
        const artifactId = JSON.parse(value.content)?.artifactId;
        if (artifactId) value.content = { artifactId };
      } catch { /* Plain results use their original content. */ }
    }
    return value;
  });
  return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function toolCalls(message = {}) {
  return Array.isArray(message.tool_calls) ? message.tool_calls.map(call => call.id)
    : Array.isArray(message.content) ? message.content.filter(block => block.type === "tool_use").map(block => block.id) : [];
}

function toolResults(message = {}) {
  if (message.role === "tool") return [message.tool_call_id];
  return Array.isArray(message.content) ? message.content.filter(block => block.type === "tool_result").map(block => block.tool_use_id) : [];
}

// A multi-call assistant turn and all its results are one indivisible unit.
function historyUnits(messages = []) {
  const units = [];
  for (let start = 0; start < messages.length;) {
    let end = start + 1;
    const ids = toolCalls(messages[start]);
    let complete = toolResults(messages[start]).length === 0;
    if (ids.length) {
      const pending = new Set(ids);
      while (end < messages.length && toolResults(messages[end]).length) {
        for (const id of toolResults(messages[end])) pending.delete(id);
        end++;
      }
      complete = pending.size === 0;
    }
    units.push({ start, end, complete, messages: messages.slice(start, end) });
    start = end;
  }
  return units;
}

function userInstruction(message = {}) {
  if (message.role !== "user" || toolResults(message).length) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter(block => block.type === "text").map(block => block.text || "").join("\n");
}

module.exports = { estimateTextTokens, estimateMessagesTokens, summaryMessage, historyDigest, historyUnits, userInstruction };
