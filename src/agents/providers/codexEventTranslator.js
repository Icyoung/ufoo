function getTextFromItem(item) {
  if (!item || typeof item !== "object") return "";
  if (typeof item.text === "string") return item.text;
  if (item.item && typeof item.item.text === "string") return item.item.text;
  if (Array.isArray(item.content)) {
    return item.content
      .map((entry) => (entry && typeof entry.text === "string" ? entry.text : ""))
      .join("");
  }
  return "";
}

function normalizeCodexEvent(event = {}) {
  const type = String(event.type || "").trim();
  if (!type) return null;

  if (type === "thread.started") {
    return { type: "thread_started", threadId: event.thread_id || event.threadId || "" };
  }

  if (type === "turn.started") {
    return { type: "turn_started", turnId: event.turn_id || event.turnId || "" };
  }

  if (type === "turn.completed") {
    return {
      type: "turn_completed",
      turnId: event.turn_id || event.turnId || "",
      usage: event.usage || null,
    };
  }

  if (type === "turn.failed") {
    const error = event.error || {};
    return {
      type: "turn_failed",
      turnId: event.turn_id || event.turnId || "",
      error: typeof error.message === "string" ? error.message : String(error || "turn failed"),
    };
  }

  if (type === "item.completed") {
    const item = event.item || {};
    const itemType = String(item.type || "").trim();
    const text = getTextFromItem(item);

    if (itemType === "message" || itemType === "assistant_message" || text) {
      return {
        type: "text_delta",
        delta: text,
        itemType,
      };
    }

    if (itemType === "tool_call") {
      return {
        type: "tool_call",
        name: item.name || "",
        toolCallId: item.id || item.tool_call_id || "",
        args: item.arguments || item.args || {},
      };
    }

    if (itemType === "tool_result") {
      return {
        type: "tool_result",
        toolCallId: item.tool_call_id || item.id || "",
        output: item.output,
      };
    }
  }

  return null;
}

module.exports = {
  normalizeCodexEvent,
};
