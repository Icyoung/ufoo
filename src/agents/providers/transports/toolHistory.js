"use strict";

// Project stored tool turns into the target wire format without changing journal offsets.
function toBlockMessages(messages = []) {
  return messages.filter(message => message.role !== "system").map(message => {
    if (message.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }] };
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      const content = message.content ? [{ type: "text", text: message.content }] : [];
      for (const call of message.tool_calls) {
        content.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
      }
      return { role: "assistant", content };
    }
    return message;
  });
}

function toChatMessages(messages = []) {
  return messages.flatMap(message => {
    if (!Array.isArray(message.content)) return [message];
    const calls = message.content.filter(block => block.type === "tool_use");
    if (message.role === "assistant" && calls.length) {
      const text = message.content.filter(block => block.type === "text").map(block => block.text).join("");
      return [{ role: "assistant", content: text || null, tool_calls: calls.map(call => ({
        type: "function", id: call.id, function: { name: call.name, arguments: JSON.stringify(call.input) },
      })) }];
    }
    if (message.role !== "user" || !message.content.some(block => block.type === "tool_result")) return [message];
    const results = [];
    const parts = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const content = Array.isArray(block.content) ? block.content : [{ type: "text", text: block.content }];
        results.push({ role: "tool", tool_call_id: block.tool_use_id,
          content: content.filter(part => part.type === "text").map(part => part.text).join("\n") });
        for (const part of content) {
          if (part.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
        }
      } else {
        parts.push(block);
      }
    }
    if (parts.length) results.push({ role: "user", content: parts });
    return results;
  });
}

module.exports = { toBlockMessages, toChatMessages };
