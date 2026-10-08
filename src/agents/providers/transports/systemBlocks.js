"use strict";

function systemBlocksToAnthropicPayload(blocks = []) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.text);
  const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };
  // Place cache breakpoints on every cacheable layer so Anthropic can reuse
  // Immutable → SessionStable → Epoch prefixes independently. Turn-dynamic
  // never gets cache_control.
  return list.map((block) => {
    const entry = { type: "text", text: block.text };
    if (block.cacheable) entry.cache_control = { ...ANTHROPIC_CACHE_CONTROL };
    return entry;
  });
}

module.exports = { systemBlocksToAnthropicPayload };
