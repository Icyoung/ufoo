"use strict";

jest.mock("../../../../src/code/agent", () => {
  const actual = jest.requireActual("../../../../src/code/agent");
  return {
    ...actual,
    resumeAfterUserInteraction: jest.fn(async () => ({
      ok: true,
      summary: "continued",
      streamed: false,
      waitingUserInteraction: false,
    })),
  };
});

const { emptyExecutionState } = require("../../../../src/code/context/executionSegment");
const { requestUserInteraction } = require("../../../../src/code/context/userInteraction");
const {
  submitUserInteractionAnswer,
  INTERACTION_EVENTS,
} = require("../../../../src/code/protocol/suspension");
const { resumeAfterUserInteraction } = require("../../../../src/code/agent");

describe("submitUserInteractionAnswer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("rejects invalid answers without calling resume", async () => {
    const state = { executionState: emptyExecutionState() };
    requestUserInteraction(state.executionState, {
      kind: "approval",
      prompt: "Ship?",
      allowFreeChat: false,
    });
    const events = [];
    const result = await submitUserInteractionAnswer("maybe", state, {
      onEvent: (e) => events.push(e.type),
    });
    expect(result.ok).toBe(false);
    expect(result.waitingUserInteraction).toBe(true);
    expect(resumeAfterUserInteraction).not.toHaveBeenCalled();
    expect(events).toContain("interaction_rejected");
  });

  test("blocks slash commands while suspended", async () => {
    const state = { executionState: emptyExecutionState() };
    requestUserInteraction(state.executionState, {
      kind: "chat",
      prompt: "?",
    });
    const result = await submitUserInteractionAnswer("/status", state, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("SUSPENDED_BLOCKS_SLASH");
    expect(resumeAfterUserInteraction).not.toHaveBeenCalled();
  });

  test("idempotent when no pending interaction", async () => {
    const state = { executionState: emptyExecutionState() };
    const result = await submitUserInteractionAnswer("hello", state, {});
    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(true);
    expect(result.code).toBe("ALREADY_RESOLVED");
    expect(resumeAfterUserInteraction).not.toHaveBeenCalled();
  });

  test("resumes and reports shouldEchoSummary when not streamed", async () => {
    const state = { executionState: emptyExecutionState() };
    requestUserInteraction(state.executionState, {
      kind: "chat",
      prompt: "Continue?",
      resume: { call: { source: { id: "c1" } } },
    });
    resumeAfterUserInteraction.mockResolvedValueOnce({
      ok: true,
      summary: "done",
      streamed: false,
      waitingUserInteraction: false,
    });
    const events = [];
    const result = await submitUserInteractionAnswer("yes", state, {
      onEvent: (e) => events.push(e.type),
    });
    expect(result.ok).toBe(true);
    expect(result.shouldEchoSummary).toBe(true);
    expect(result.echoSummaryText).toBe("done");
    expect(events).toContain("interaction_resuming");
    expect(events).toContain("interaction_resolved");
    expect(INTERACTION_EVENTS).toContain("interaction_resolved");
  });
});
