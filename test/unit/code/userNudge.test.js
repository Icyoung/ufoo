"use strict";

jest.mock("../../../src/code/dispatch", () => ({
  runToolCall: jest.fn(() => ({ ok: true, content: "" })),
}));

jest.mock("../../../src/config", () => {
  const fs = require("fs");
  const path = require("path");
  const actual = jest.requireActual("../../../src/config");
  const emptyUcode = {
    ucodeProvider: "",
    ucodeModel: "",
    ucodeBaseUrl: "",
    ucodeApiKey: "",
    ucodeAgentDir: "",
  };
  return {
    ...actual,
    loadGlobalUcodeConfig: () => emptyUcode,
    loadConfig: (projectRoot) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, ".ufoo", "config.json"), "utf8"));
        return { ...raw, ...emptyUcode };
      } catch {
        return { ...emptyUcode };
      }
    },
  };
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  enqueueUserPrompt,
  drainUserPrompts,
  clearUserPrompts,
  hasPendingUserPrompts,
  shouldFrameAsUserReminder,
  formatUserReminderMessage,
  buildContinuationUserPrompt,
} = require("../../../src/code/context/userNudge");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runNativeAgentTask } = require("../../../src/code/nativeRunner");
const { runToolCall } = require("../../../src/code/dispatch");

function makeSseResponse(chunks = []) {
  const lines = [];
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify(chunk)}`);
    lines.push("");
  }
  lines.push("data: [DONE]");
  lines.push("");
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("user nudge queue", () => {
  test("enqueue / drain is atomic and preserves order", () => {
    const state = emptyExecutionState();
    expect(enqueueUserPrompt(state, " first ").enqueued).toBe(true);
    expect(enqueueUserPrompt(state, "second").enqueued).toBe(true);
    expect(enqueueUserPrompt(state, "  ").enqueued).toBe(false);
    expect(hasPendingUserPrompts(state)).toBe(true);
    expect(drainUserPrompts(state)).toEqual(["first", "second"]);
    expect(drainUserPrompts(state)).toEqual([]);
    expect(hasPendingUserPrompts(state)).toBe(false);
  });

  test("clear drops pending prompts", () => {
    const state = emptyExecutionState();
    enqueueUserPrompt(state, "a");
    clearUserPrompts(state);
    expect(drainUserPrompts(state)).toEqual([]);
  });

  test("formatUserReminderMessage labels and waiting hint", () => {
    const single = formatUserReminderMessage(["focus on tests"]);
    expect(single).toMatch(/User reminder \(additional prompt\):/);
    expect(single).toContain("focus on tests");

    const multi = formatUserReminderMessage(["one", "two"], {
      waitingFor: { id: "inspect", type: "task", title: "Locate code" },
    });
    expect(multi).toContain("1. one");
    expect(multi).toContain("2. two");
    expect(multi).toMatch(/waiting task: inspect/);
  });

  test("shouldFrameAsUserReminder for planMode or waitingFor", () => {
    expect(shouldFrameAsUserReminder(emptyExecutionState())).toBe(false);
    expect(shouldFrameAsUserReminder({ planMode: true })).toBe(true);
    expect(shouldFrameAsUserReminder({
      planMode: false,
      planGraph: { waitingFor: { id: "t1", type: "task" } },
    })).toBe(true);
  });

  test("buildContinuationUserPrompt wraps idle plan waiting message", () => {
    const text = buildContinuationUserPrompt("skip the flaky test", {
      planGraph: { waitingFor: { id: "fix", type: "task", title: "Apply fix" } },
    });
    expect(text).toMatch(/User reminder/);
    expect(text).toContain("skip the flaky test");
    expect(text).toMatch(/waiting task: fix/);
  });
});

describe("nativeRunner injects pending reminders before LLM turns", () => {
  const originalFetch = global.fetch;
  let workspaceRoot = "";

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-nudge-runner-"));
    fs.mkdirSync(path.join(workspaceRoot, ".ufoo"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".ufoo", "config.json"), JSON.stringify({
      ucodeProvider: "",
      ucodeModel: "",
      ucodeBaseUrl: "",
      ucodeApiKey: "",
    }, null, 2));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("drains queue into next model request after tool results", async () => {
    const executionState = emptyExecutionState();
    let turn = 0;
    global.fetch.mockImplementation(async (_url, init) => {
      turn += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      if (turn === 1) {
        return makeSseResponse([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"a.txt"}',
                  },
                }],
              },
            }],
          },
        ]);
      }
      const reminder = (body.messages || []).find((m) => (
        m.role === "user"
        && String(m.content || "").includes("User reminder (additional prompt):")
        && String(m.content || "").includes("prefer unit tests")
      ));
      expect(reminder).toBeTruthy();
      return makeSseResponse([
        { choices: [{ delta: { content: "done with reminder" } }] },
      ]);
    });

    runToolCall.mockImplementation(() => {
      enqueueUserPrompt(executionState, "prefer unit tests");
      return { ok: true, content: "file contents" };
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "read a file",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("done with reminder");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(hasPendingUserPrompts(executionState)).toBe(false);
  });

  test("clears pending prompts on cancel", async () => {
    const executionState = emptyExecutionState();
    enqueueUserPrompt(executionState, "should be dropped");
    const controller = new AbortController();
    controller.abort();

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "start",
      provider: "openai",
      model: "gpt-test",
      executionState,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(hasPendingUserPrompts(executionState)).toBe(false);
  });
});

describe("busy submit enqueue helper path", () => {
  test("enqueue mirrors TUI busy-submit behavior", () => {
    const state = { executionState: emptyExecutionState() };
    const queued = enqueueUserPrompt(state.executionState, "mid-run hint");
    expect(queued.enqueued).toBe(true);
    expect(state.executionState.pendingUserPrompts).toHaveLength(1);
    expect(state.executionState.pendingUserPrompts[0].text).toBe("mid-run hint");
  });
});
