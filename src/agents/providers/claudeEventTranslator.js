"use strict";

function toObject(value) {
  return value && typeof value === "object" ? value : {};
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeStringify(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function parseJsonArgs(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return { __raw: text };
  }
}

function toNonNegativeInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function normalizeClaudeUsage(usage = null) {
  if (!usage || typeof usage !== "object") return null;
  const item = toObject(usage);
  return {
    ...item,
    input_tokens: toNonNegativeInt(item.input_tokens),
    output_tokens: toNonNegativeInt(item.output_tokens),
    cache_creation_tokens: toNonNegativeInt(
      item.cache_creation_tokens
        || item.cache_creation_input_tokens
        || (item.cache_creation && item.cache_creation.input_tokens)
    ),
    cache_read_tokens: toNonNegativeInt(
      item.cache_read_tokens
        || item.cache_read_input_tokens
        || (item.cache_read && item.cache_read.input_tokens)
    ),
  };
}

function createClaudeEventState(seed = {}) {
  return {
    turnId: String(seed.turnId || ""),
    threadId: String(seed.threadId || ""),
    usage: null,
    stopReason: "",
    contentBlocks: new Map(),
    assistantBlocks: [],
  };
}

function normalizeClaudeContentBlock(block = {}) {
  const item = toObject(block);
  const type = String(item.type || "").trim();
  if (!type) return [];

  if (type === "text") {
    return [{
      type: "text_delta",
      delta: String(item.text || ""),
      itemType: "text",
    }];
  }

  if (type === "tool_use") {
    return [{
      type: "tool_call",
      toolCallId: String(item.id || item.tool_use_id || ""),
      name: String(item.name || ""),
      args: toObject(item.input),
    }];
  }

  if (type === "tool_result") {
    return [{
      type: "tool_result",
      toolCallId: String(item.tool_use_id || item.id || ""),
      output: Object.prototype.hasOwnProperty.call(item, "content") ? item.content : item.output,
      is_error: item.is_error === true,
    }];
  }

  return [];
}

function normalizeClaudeMessage(message = {}) {
  const item = toObject(message);
  const turnId = String(item.id || item.turn_id || "");
  const usage = normalizeClaudeUsage(item.usage || null);
  const events = [];
  if (turnId) {
    events.push({ type: "turn_started", turnId });
  }
  for (const block of toArray(item.content)) {
    events.push(...normalizeClaudeContentBlock(block));
  }
  if (usage) {
    events.push({ type: "usage", turnId, usage });
  }
  events.push({
    type: "turn_completed",
    turnId,
    usage,
    stopReason: String(item.stop_reason || ""),
  });
  return events;
}

function appendAssistantBlock(state, block) {
  if (!block || typeof block !== "object") return;
  state.assistantBlocks.push(block);
}

function getContentBlockState(state, index) {
  const key = Number.isFinite(Number(index)) ? Number(index) : -1;
  if (!state.contentBlocks.has(key)) {
    state.contentBlocks.set(key, {
      type: "",
      text: "",
      toolCallId: "",
      name: "",
      jsonText: "",
    });
  }
  return state.contentBlocks.get(key);
}

function normalizeClaudeEvent(event = {}, state = createClaudeEventState()) {
  const item = toObject(event);
  const type = String(item.type || "").trim();
  if (!type) return [];

  if (type === "message_start") {
    const message = toObject(item.message);
    state.turnId = String(message.id || state.turnId || "");
    state.usage = normalizeClaudeUsage(message.usage || state.usage || null);
    return [{
      type: "turn_started",
      turnId: state.turnId,
    }];
  }

  if (type === "content_block_start") {
    const block = toObject(item.content_block);
    const blockState = getContentBlockState(state, item.index);
    blockState.type = String(block.type || "").trim();
    if (blockState.type === "text") {
      blockState.text = String(block.text || "");
      if (blockState.text) {
        appendAssistantBlock(state, { type: "text", text: blockState.text });
      }
    }
    if (blockState.type === "tool_use") {
      blockState.toolCallId = String(block.id || block.tool_use_id || "");
      blockState.name = String(block.name || "");
      blockState.jsonText = safeStringify(block.input || "");
    }
    return [];
  }

  if (type === "content_block_delta") {
    const delta = toObject(item.delta);
    const deltaType = String(delta.type || "").trim();
    const blockState = getContentBlockState(state, item.index);
    if (deltaType === "text_delta") {
      const text = String(delta.text || "");
      if (!text) return [];
      blockState.text += text;
      if (state.assistantBlocks.length > 0) {
        const last = state.assistantBlocks[state.assistantBlocks.length - 1];
        if (last && last.type === "text") {
          last.text = `${String(last.text || "")}${text}`;
        } else {
          appendAssistantBlock(state, { type: "text", text });
        }
      } else {
        appendAssistantBlock(state, { type: "text", text });
      }
      return [{
        type: "text_delta",
        delta: text,
        itemType: "text",
      }];
    }
    if (deltaType === "input_json_delta") {
      blockState.jsonText += String(delta.partial_json || "");
    }
    return [];
  }

  if (type === "content_block_stop") {
    const blockState = getContentBlockState(state, item.index);
    state.contentBlocks.delete(Number.isFinite(Number(item.index)) ? Number(item.index) : -1);
    if (blockState.type !== "tool_use") return [];
    const args = parseJsonArgs(blockState.jsonText);
    const assistantBlock = {
      type: "tool_use",
      id: blockState.toolCallId,
      name: blockState.name,
      input: args,
    };
    appendAssistantBlock(state, assistantBlock);
    return [{
      type: "tool_call",
      toolCallId: blockState.toolCallId,
      name: blockState.name,
      args,
    }];
  }

  if (type === "message_delta") {
    const usage = normalizeClaudeUsage(item.usage || null);
    if (usage) state.usage = usage;
    const delta = toObject(item.delta);
    if (delta.stop_reason) state.stopReason = String(delta.stop_reason || "");
    return usage ? [{
      type: "usage",
      turnId: state.turnId,
      usage,
    }] : [];
  }

  if (type === "message_stop") {
    return [{
      type: "turn_completed",
      turnId: state.turnId,
      usage: state.usage,
      stopReason: state.stopReason,
    }];
  }

  if (type === "error") {
    const error = toObject(item.error);
    return [{
      type: "turn_failed",
      turnId: state.turnId,
      error: String(error.message || item.message || "claude stream failed"),
    }];
  }

  return [];
}

module.exports = {
  createClaudeEventState,
  normalizeClaudeContentBlock,
  normalizeClaudeEvent,
  normalizeClaudeMessage,
  normalizeClaudeUsage,
};
