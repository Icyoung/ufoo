"use strict";

const MAX_BREAKPOINTS = 4;
const CACHE_CONTROL = Object.freeze({ type: "ephemeral" });
const STABLE_HISTORY_BOUNDARY = Symbol.for("ufoo.stableHistoryBoundary");
const CACHEABLE_MESSAGE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result", "search_result"]);

function withoutCacheControl(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const { cache_control: ignored, ...clean } = block;
  if (Array.isArray(clean.content)) clean.content = clean.content.map(withoutCacheControl);
  return clean;
}

function messageBlockCanCache(block) {
  return CACHEABLE_MESSAGE_BLOCKS.has(block?.type)
    && (block.type !== "text" || typeof block.text === "string" && Boolean(block.text.trim()));
}

function applyAnthropicCacheBreakpoints(payload) {
  const selected = new Set();
  const explicit = [];
  const order = [];
  function boundary(block, write, cacheable = true) {
    if (!cacheable) return null;
    const control = block?.cache_control;
    const entry = { write, control: control?.type === "ephemeral" ? control : CACHE_CONTROL };
    order.push(entry);
    if (control?.type === "ephemeral") explicit.push(entry);
    return entry;
  }

  payload.tools = payload.tools.map((tool, index) => {
    boundary(tool, control => { payload.tools[index].cache_control = control; }, !tool.defer_loading);
    return withoutCacheControl(tool);
  });
  const system = [];
  if (Array.isArray(payload.system)) {
    payload.system = payload.system.map((block, index) => {
      if (block.cache_control) system.push(boundary(block, control => { payload.system[index].cache_control = control; }, messageBlockCanCache(block)));
      return withoutCacheControl(block);
    });
  }

  let history = null;
  let latest = null;
  payload.messages = payload.messages.map((message, messageIndex) => {
    if (!message || typeof message !== "object") return message;
    const original = message.content;
    const blocks = typeof original === "string" ? [{ type: "text", text: original }] : original;
    if (!Array.isArray(blocks)) return message;
    const clean = blocks.map(withoutCacheControl);
    for (const [blockIndex, block] of blocks.entries()) {
      const entry = boundary(block, control => {
        clean[blockIndex].cache_control = control;
        payload.messages[messageIndex].content = clean;
      }, messageBlockCanCache(block));
      if (entry) latest = entry;
    }
    if (message[STABLE_HISTORY_BOUNDARY]) history = latest;
    return { ...message, content: typeof original === "string" ? original : clean };
  });

  for (const entry of [system.at(-1), history, latest, ...system.slice(0, -1).reverse(), ...explicit.reverse()]) {
    if (selected.size === MAX_BREAKPOINTS) break;
    if (entry) selected.add(entry);
  }
  // The wire API requires all longer-lived breakpoints to precede short ones.
  let sawShort = false;
  for (const entry of order) {
    if (!selected.has(entry)) continue;
    if (entry.control.ttl === "1h" && sawShort) continue;
    entry.write(entry.control);
    if (entry.control.ttl !== "1h") sawShort = true;
  }
}

module.exports = { applyAnthropicCacheBreakpoints };
