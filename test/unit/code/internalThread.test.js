"use strict";

jest.mock("../../../src/code/agent", () => ({
  resolveUcodeProviderModel: () => ({ provider: "openai", model: "test-model" }),
  buildNlContext: () => ({}),
  resumeSessionState: jest.fn(),
  persistSessionState: jest.fn(),
  runNaturalLanguageTask: jest.fn(),
  resumeAfterUserInteraction: jest.fn(),
}));

const agent = require("../../../src/code/agent");
const { createInternalCodingThread } = require("../../../src/code/internalThread");

test("native phases, live context meter and plan callbacks survive the headless adapter", async () => {
  const thread = createInternalCodingThread({ runTask: async (input, state, callbacks) => {
    state.executionState = require("../../../src/code/context/executionSegment").emptyExecutionState();
    require("../../../src/code/context/planGraphService").runPlanGraphCommand({ operation: "create",
      graph: { objective: "fix", nodes: [{ id: "inspect", type: "task", title: "Inspect code" }] } },
      { executionState: state.executionState, autoAdvance: false });
    callbacks.onPhase({ type: "request_start" });
    callbacks.onPhase({ type: "tool_request", name: "read" });
    callbacks.onContextUsage({ label: "10K / 200K" });
    callbacks.onToolEvent({ phase: "start", tool: "read", args: { path: "a.js" } });
    callbacks.onToolEvent({ phase: "end", tool: "read", args: { path: "a.js" }, result: { content: "hello" } });
    return { ok: true, usage: { input: 10000, output: 8 }, contextMeter: { label: "10K / 200K" } };
  } });
  const events = [];
  for await (const event of thread.runStreamed("task")) events.push(event);
  expect(events).toContainEqual({ type: "phase", phase: { type: "request_start" } });
  expect(events).toContainEqual({ type: "context_usage", meter: { label: "10K / 200K" } });
  expect(events.some(event => event.type === "plan" && event.lines.join("\n").includes("Inspect code"))).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "turn_completed", usage: { input: 10000, output: 8 } });
  await thread.close();
});

test("native thread yields partial output before task finishes, and repeated tools keep distinct identities", async () => {
  let finish;
  const paused = new Promise((resolve) => { finish = resolve; });
  const thread = createInternalCodingThread({ workspaceRoot: "/tmp/ucode-surface", runTask: async (input, state, callbacks) => {
    expect(input).toBe("task");
    callbacks.onDelta("partial");
    await paused;
    for (let n = 1; n <= 2; n++) {
      callbacks.onToolEvent({ phase: "start", tool: "bash", args: { command: "ls" } });
      callbacks.onToolEvent({ phase: "end", tool: "bash", args: { command: "ls" }, result: { stdout: `output-${n}` } });
    }
    return { ok: true, streamed: true, summary: "partial" };
  } });
  const stream = thread.runStreamed("task");
  expect((await stream.next()).value.type).toBe("turn_started");
  expect((await stream.next()).value).toEqual({ type: "text_delta", delta: "partial" });
  finish();
  const events = [];
  for await (const event of stream) events.push(event);
  const calls = events.filter((event) => event.type === "tool_call");
  const results = events.filter((event) => event.type === "tool_result");
  expect(calls).toHaveLength(2);
  expect(calls[0].toolCallId).not.toBe(calls[1].toolCallId);
  expect(results.map((event) => event.toolCallId)).toEqual(calls.map((event) => event.toolCallId));
  expect(events.at(-1).type).toBe("turn_completed");
  expect(events.filter((event) => event.type === "text_delta")).toHaveLength(0);
  await thread.close();
});

test("native thread cancellation reaches the runner and permits another turn", async () => {
  const cancelled = jest.fn();
  const thread = createInternalCodingThread({ runTask: async (input, state, callbacks) => {
    callbacks.onDelta(input);
    await new Promise((resolve) => callbacks.signal.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
    return { ok: true, streamed: true };
  } });
  const stream = thread.runStreamed("first");
  await stream.next(); await stream.next();
  await stream.return();
  expect(cancelled).toHaveBeenCalledTimes(1);
  const again = thread.runStreamed("second");
  await again.next();
  expect((await again.next()).value.delta).toBe("second");
  await again.return();
  expect(cancelled).toHaveBeenCalledTimes(2);
  expect(agent.persistSessionState).not.toHaveBeenCalled();
});

test("a pending native question receives the literal reply without bootstrap/task framing", async () => {
  agent.resumeSessionState.mockImplementationOnce((state) => {
    state.executionState = { pendingUserInteraction: { id: "ask", kind: "choice", prompt: "Pick one", status: "pending" } };
  });
  agent.resumeAfterUserInteraction.mockImplementationOnce(async (answer, state) => {
    state.executionState.pendingUserInteraction = null;
    return { ok: true, summary: "accepted", streamed: false };
  });
  const thread = createInternalCodingThread({ sessionId: "resume-ask" });
  const events = [];
  for await (const event of thread.runStreamed("bootstrap + memory + framed answer", { userInput: "1" })) events.push(event);
  expect(agent.resumeAfterUserInteraction).toHaveBeenCalledWith("1", expect.any(Object), expect.any(Object));
  expect(events).toContainEqual({ type: "text_delta", delta: "accepted" });
  await thread.close();
});
