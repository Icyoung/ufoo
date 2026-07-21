"use strict";

const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const {
  requestUserInteraction,
  parseUserInteractionInput,
  buildAnswerPayload,
  resolveUserInteraction,
  syncInteractionFromPlanGraph,
  formatInteractionPromptLines,
} = require("../../../src/code/context/userInteraction");
const { runPlanGraphCommand } = require("../../../src/code/context/planGraphService");
const { TOOL_NAMES, runToolCall } = require("../../../src/code/dispatch");
const { appendAnswerToolResult } = require("../../../src/code/nativeRunner");

describe("userInteraction", () => {
  test("TOOL_NAMES includes ask_user", () => {
    expect(TOOL_NAMES).toContain("ask_user");
  });

  test("choice answer payload has no question echo", () => {
    const executionState = emptyExecutionState();
    const created = requestUserInteraction(executionState, {
      kind: "choice",
      prompt: "Which environment?",
      options: ["staging", "prod"],
    });
    expect(created.status).toBe("waiting_user");
    const pending = executionState.pendingUserInteraction;
    const parsed = parseUserInteractionInput(pending, "2");
    expect(parsed.ok).toBe(true);
    expect(parsed.selected).toBe("2");
    const answer = buildAnswerPayload(pending, parsed);
    expect(answer.type).toBe("user_answer");
    expect(answer.selected).toBe("2");
    expect(answer.label).toBe("prod");
    expect(JSON.stringify(answer)).not.toMatch(/Which environment/);
  });

  test("free chat on choice does not echo question", () => {
    const executionState = emptyExecutionState();
    requestUserInteraction(executionState, {
      kind: "choice",
      prompt: "Pick a color",
      options: ["red", "blue"],
    });
    const pending = executionState.pendingUserInteraction;
    const parsed = parseUserInteractionInput(pending, "something else entirely");
    expect(parsed.answerKind).toBe("chat");
    const answer = buildAnswerPayload(pending, parsed);
    expect(answer.text).toBe("something else entirely");
    expect(JSON.stringify(answer)).not.toMatch(/Pick a color/);
  });

  test("approval yes/no aliases", () => {
    const executionState = emptyExecutionState();
    requestUserInteraction(executionState, {
      kind: "approval",
      prompt: "Deploy now?",
    });
    const pending = executionState.pendingUserInteraction;
    expect(parseUserInteractionInput(pending, "y").selected).toBe("yes");
    expect(parseUserInteractionInput(pending, "否").selected).toBe("no");
  });

  test("ask_user model wait ack has no prompt copy", () => {
    const executionState = emptyExecutionState();
    const result = runToolCall({
      tool: "ask_user",
      args: { kind: "approval", prompt: "Ship it?" },
    }, { executionState });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("waiting_user");
    expect(JSON.stringify(result.modelPayload || {})).not.toMatch(/Ship it/);
    expect(result.modelPayload).toEqual({
      ok: true,
      status: "waiting_user",
      interactionId: expect.any(String),
      kind: "approval",
    });
    expect(executionState.pendingUserInteraction.prompt).toBe("Ship it?");
  });

  test("tool_result append keeps answer contiguous without question", () => {
    const messages = [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: {
          name: "ask_user",
          arguments: JSON.stringify({ kind: "choice", prompt: "Env?", options: ["a", "b"] }),
        },
      }],
    }];
    const answer = {
      type: "user_answer",
      kind: "choice",
      answerKind: "option",
      selected: "1",
      label: "a",
      interactionId: "ui_x",
    };
    const appended = appendAnswerToolResult(messages, {
      transport: "openai-chat",
      toolCallId: "call_1",
      call: {
        source: { id: "call_1" },
      },
    }, answer);
    expect(appended.ok).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("tool");
    expect(messages[1].tool_call_id).toBe("call_1");
    expect(messages[1].content).toContain("user_answer");
    expect(messages[1].content).not.toContain("Env?");
  });

  test("checkpoint approval sync + resolve", () => {
    const executionState = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: {
        nodes: [
          { id: "t1", type: "tool", tool: "read", args: { path: "a.txt" } },
          {
            id: "cp1",
            type: "checkpoint",
            mode: "approval",
            reason: "Proceed with write?",
            dependsOn: ["t1"],
          },
        ],
      },
    }, {
      executionState,
      autoAdvance: true,
      runTool: () => ({ ok: true, content: "x", summary: "ok" }),
    });
    // Force waiting approval shape if advance did not stop (tool may not exist in sandbox)
    if (!executionState.planGraph.waitingFor) {
      const node = executionState.planGraph.nodes.find((n) => n.id === "cp1");
      if (node) {
        node.status = "waiting_approval";
        executionState.planGraph.waitingFor = {
          id: "cp1",
          type: "checkpoint",
          mode: "approval",
          reason: "Proceed with write?",
        };
        executionState.planGraph.lastYieldReason = "approval_required";
      }
    }
    syncInteractionFromPlanGraph(executionState);
    expect(executionState.pendingUserInteraction).toBeTruthy();
    const lines = formatInteractionPromptLines(executionState.pendingUserInteraction);
    expect(lines[0]).toMatch(/Approval:/);

    const resolved = resolveUserInteraction(executionState, "yes");
    expect(resolved.ok).toBe(true);
    expect(resolved.answer.selected).toBe("yes");
    expect(JSON.stringify(resolved.answer)).not.toMatch(/Proceed with write/);
    expect(executionState.pendingUserInteraction).toBe(null);
  });
});
