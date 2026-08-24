"use strict";

const {
  buildResponsesPayload,
  messagesToResponsesInput,
  parseResponsesSsePayload,
} = require("../../../../src/code/providers/responsesProtocol");

describe("Responses protocol projection", () => {
  test("projects generic tool history without private response metadata", () => {
    expect(messagesToResponsesInput([
      { role: "system", content: "rules" },
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"README.md"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
    ])).toEqual([
      { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "read the file" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"README.md"}' },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ]);
  });

  test("parses keepalive, text, reasoning, tool calls, and incomplete terminal", () => {
    const frames = [
      "event: keepalive\ndata: {\"type\":\"keepalive\"}",
      "event: response.reasoning_text.delta\ndata: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"think\"}",
      "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[],\"encrypted_content\":\"encrypted-1\"}}",
      "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_item\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"read\",\"arguments\":\"\"}}",
      "event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_item\",\"delta\":\"{\\\"path\\\":\\\"README.md\\\"}\"}",
      "event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_1\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"output\":[]}}",
    ].join("\n\n");
    const parsed = parseResponsesSsePayload(frames);
    expect(parsed.reasoning).toBe("think");
    expect(parsed.terminal).toBe("incomplete");
    expect(parsed.incompleteDetails).toEqual({ reason: "max_output_tokens" });
    expect(parsed.outputItems[0]).toMatchObject({
      id: "rs_1",
      type: "reasoning",
      encrypted_content: "encrypted-1",
    });
    expect(parsed.toolCalls).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "read", arguments: '{"path":"README.md"}' },
    }]);
  });

  test("builds Grok Build Responses request with encrypted reasoning enabled", () => {
    const payload = buildResponsesPayload({
      provider: "grok-build",
      model: "grok-4.6",
      instructions: "rules",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(payload).toMatchObject({
      model: "grok-4.6",
      instructions: "rules",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });
});
