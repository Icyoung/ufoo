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

function createCodexEventState() {
  return { items: new Map() };
}

function normalizeCodexEvent(event = {}, state = createCodexEventState()) {
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

  if (type === "error") return { type: "turn_failed", error: String(event.message || "Codex stream failed") };

  if (["item.started", "item.updated", "item.completed"].includes(type)) {
    const item = event.item || {};
    const itemType = String(item.type || "").trim();
    const text = getTextFromItem(item);
    const key = String(item.id || "");
    const previous = key ? state.items.get(key) || {} : {};
    const remember = (next) => { if (key) state.items.set(key, { ...previous, ...next }); };

    if (itemType === "todo_list") return { type: "plan", items: item.items || [] };

    if (["message", "assistant_message", "agent_message"].includes(itemType)) {
      const delta = text.startsWith(previous.text || "") ? text.slice((previous.text || "").length) : text;
      remember({ text });
      if (!delta) return type === "item.started" ? { type: "phase", phase: { type: "text_delta" } } : null;
      return {
        type: "text_delta",
        delta,
        itemType,
      };
    }

    if (itemType === "reasoning") {
      const delta = text.startsWith(previous.text || "") ? text.slice((previous.text || "").length) : text;
      remember({ text });
      return delta ? { type: "thinking_delta", delta }
        : type === "item.started" ? { type: "phase", phase: { type: "thinking" } } : null;
    }

    if (["tool_call", "command_execution", "mcp_tool_call", "file_change", "web_search", "todo_list"].includes(itemType)) {
      if (previous.started && ["command_execution", "mcp_tool_call"].includes(itemType)) {
        const output = itemType === "command_execution" ? String(item.aggregated_output || "") : item.result || item.error || "";
        const delta = typeof output === "string" && output.startsWith(previous.output || "")
          ? output.slice((previous.output || "").length) : output;
        remember({ output });
        if (!delta && type !== "item.completed") return null;
        return { type: "tool_result", toolCallId: key, output: delta,
          ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}), status: item.status || "" };
      }
      remember({ started: true, output: "" });
      const nativeTools = {
        command_execution: { name: "bash", args: { command: item.command || "" } },
        file_change: { name: "apply_patch", args: { path: (item.changes || []).map((change) => change.path).join(", ") } },
        mcp_tool_call: { name: `${item.server || "mcp"}.${item.tool || "tool"}`, args: item.arguments || {} },
        web_search: { name: "web_search", args: { query: item.query || "" } },
        todo_list: { name: "plan", args: { items: item.items || [] } },
      };
      const tool = nativeTools[itemType] || { name: item.name || "", args: item.arguments || item.args || {} };
      return {
        type: "tool_call",
        name: tool.name,
        toolCallId: item.id || item.tool_call_id || "",
        args: tool.args,
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
  createCodexEventState,
  normalizeCodexEvent,
};
