const { describe, it, expect } = require("@jest/globals");

jest.mock("../../../src/code/nativeRunner", () => ({
  runNativeAgentTask: jest.fn(),
}));

const { runNativeAgentTask } = require("../../../src/code/nativeRunner");
const {
  decomposeBugFixTask,
  runDecomposedTask,
  compileSummary,
  createBusProgressReporter,
} = require("../../../src/code/taskDecomposer");

describe("taskDecomposer", () => {
  describe("decomposeBugFixTask", () => {
    it("should decompose bug fix tasks into steps", () => {
      const task = "Fix the rendering bug where messages appear together";
      const steps = decomposeBugFixTask(task);

      expect(steps).toHaveLength(4);
      expect(steps[0].id).toBe("identify");
      expect(steps[0].name).toBe("Identifying the issue");
      expect(steps[0].timeoutMs).toBe(30000);
      expect(steps[0].earlyExit).toBe(true);

      expect(steps[1].id).toBe("locate");
      expect(steps[1].name).toBe("Locating relevant code");

      expect(steps[2].id).toBe("fix");
      expect(steps[2].name).toBe("Applying the fix");

      expect(steps[3].id).toBe("verify");
      expect(steps[3].name).toBe("Verifying the fix");
    });

    it("should use single step for non-bug tasks", () => {
      const task = "Explain how the chat system works";
      const steps = decomposeBugFixTask(task);

      expect(steps).toHaveLength(1);
      expect(steps[0].id).toBe("execute");
      expect(steps[0].name).toBe("Executing task");
      expect(steps[0].timeoutMs).toBe(120000);
    });

    it("should recognize various bug-related keywords", () => {
      const bugTasks = [
        "Fix the authentication issue",
        "The chat doesn't work properly",
        "Something is broken in the UI",
        "There's a problem with rendering",
      ];

      for (const task of bugTasks) {
        const steps = decomposeBugFixTask(task);
        expect(steps.length).toBeGreaterThan(1);
        expect(steps[0].id).toBe("identify");
      }
    });
  });

  describe("compileSummary", () => {
    it("should extract key findings from results", () => {
      const results = [
        {
          step: "identify",
          name: "Identifying the issue",
          result: {
            ok: true,
            output: "Found the issue: screen.render() not called after logging\nThe problem is in src/chat/index.js\nThis causes messages to appear together",
          },
        },
        {
          step: "fix",
          name: "Applying the fix",
          result: {
            ok: true,
            output: "Fixed by adding screen.render() call\nEdited src/chat/index.js line 1281",
          },
        },
      ];

      const summary = compileSummary(results);

      expect(summary).toContain("Found the issue");
      expect(summary).toContain("src/chat/index.js");
      expect(summary).toContain("Fixed");
      expect(summary).not.toContain("Let me think");
      expect(summary).not.toContain("Hmm");
    });

    it("should handle empty results", () => {
      const summary = compileSummary([]);
      expect(summary).toBe("No results");
    });

    it("should filter out verbose thinking", () => {
      const results = [
        {
          step: "identify",
          name: "Identifying the issue",
          result: {
            ok: true,
            output: `Let me think about this...
Hmm, interesting
Now let me look at the code
Actually, wait
Found the problem in src/test.js
The issue is a missing semicolon
Let me verify this`,
          },
        },
      ];

      const summary = compileSummary(results);

      expect(summary).toContain("Found the problem");
      expect(summary).toContain("src/test.js");
      expect(summary).toContain("issue");
      expect(summary).not.toContain("Let me");
      expect(summary).not.toContain("Hmm");
      expect(summary).not.toContain("Actually");
    });

    it("should handle null input", () => {
      expect(compileSummary(null)).toBe("No results");
    });

    it("should skip failed results", () => {
      const results = [
        {
          step: "identify",
          name: "Identifying",
          result: { ok: false, output: "Failed" },
        },
      ];
      expect(compileSummary(results)).toBe("");
    });

    it("should limit to 3 key lines per step", () => {
      const results = [
        {
          step: "fix",
          name: "Fix",
          result: {
            ok: true,
            output: "Fixed line 1\nFixed line 2\nFixed line 3\nFixed line 4\nFixed line 5",
          },
        },
      ];
      const summary = compileSummary(results);
      const lines = summary.split("\n");
      expect(lines.length).toBeLessThanOrEqual(3);
    });
  });

  describe("createBusProgressReporter", () => {
    it("creates a reporter function", () => {
      const shell = jest.fn();
      const reporter = createBusProgressReporter(shell, "codex:abc");
      expect(typeof reporter).toBe("function");
    });

    it("throttles calls within MIN_REPORT_INTERVAL (5s)", () => {
      const shell = jest.fn();
      const reporter = createBusProgressReporter(shell, "codex:abc");
      // First call is throttled because lastReportTime = Date.now()
      reporter({ type: "step_start", name: "Step 1", current: 1, total: 2 });
      expect(shell).not.toHaveBeenCalled();
      // Second call also throttled
      reporter({ type: "step_start", name: "Step 2", current: 2, total: 2 });
      expect(shell).not.toHaveBeenCalled();
    });

    it("calls shell after MIN_REPORT_INTERVAL using fake timers", () => {
      jest.useFakeTimers();
      const shell = jest.fn();
      const reporter = createBusProgressReporter(shell, "codex:abc");
      // Advance time past MIN_REPORT_INTERVAL (5000ms)
      jest.advanceTimersByTime(6000);
      reporter({ type: "step_start", name: "Step 1", current: 1, total: 2 });
      expect(shell).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });
  });

  describe("runDecomposedTask", () => {
    beforeEach(() => {
      runNativeAgentTask.mockReset();
    });

    it("returns aborted when signal is already aborted", async () => {
      const result = await runDecomposedTask({
        task: "fix the bug",
        signal: { aborted: true },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Task aborted");
    });

    it("runs all steps for a bug fix task", async () => {
      runNativeAgentTask.mockResolvedValue({ ok: true, output: "done" });
      const onProgress = jest.fn();

      const result = await runDecomposedTask({
        task: "fix the broken login",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
        onProgress,
      });

      expect(result.ok).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(onProgress).toHaveBeenCalled();
      expect(runNativeAgentTask).toHaveBeenCalled();
    });

    it("runs single step for non-bug task", async () => {
      runNativeAgentTask.mockResolvedValue({ ok: true, output: "explained" });

      const result = await runDecomposedTask({
        task: "explain the code",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
      });

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].step).toBe("execute");
    });

    it("stops on error at identify step", async () => {
      runNativeAgentTask.mockResolvedValue({ ok: false, error: "cannot find" });

      const result = await runDecomposedTask({
        task: "fix the bug",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Failed at");
      expect(result.error).toContain("Identifying");
    });

    it("stops on error at fix step instead of continuing to verify", async () => {
      runNativeAgentTask
        .mockResolvedValueOnce({ ok: true, output: "identified issue" })
        .mockResolvedValueOnce({ ok: true, output: "located src/code/file.js" })
        .mockResolvedValueOnce({ ok: false, error: "tool error budget exceeded (1): bash: command exited with 1" })
        .mockResolvedValueOnce({ ok: true, output: "verify should not run" });

      const result = await runDecomposedTask({
        task: "fix the error",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Failed at Applying the fix");
      expect(result.error).toContain("tool error budget exceeded");
      expect(runNativeAgentTask).toHaveBeenCalledTimes(3);
      expect(result.results).toHaveLength(3);
    });

    it("early exits when fix is found in identify step", async () => {
      runNativeAgentTask.mockResolvedValue({
        ok: true,
        output: "I fixed the issue and resolved the bug",
      });

      const result = await runDecomposedTask({
        task: "fix the issue",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
      });

      expect(result.ok).toBe(true);
      // Should have stopped early, not run all 4 steps
      expect(result.results.length).toBeLessThan(4);
    });

    it("handles exception in step execution", async () => {
      runNativeAgentTask.mockRejectedValue(new Error("network error"));
      const onProgress = jest.fn();

      const result = await runDecomposedTask({
        task: "fix the error",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
        onProgress,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("network error");
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: "step_error" })
      );
    });

    it("aborts mid-execution when signal fires", async () => {
      let callCount = 0;
      const signal = { aborted: false };
      runNativeAgentTask.mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) signal.aborted = true;
        return { ok: true, output: "ok" };
      });

      const result = await runDecomposedTask({
        task: "fix the bug",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
        signal,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Task aborted by user");
    });

    it("reports step_complete with success status", async () => {
      runNativeAgentTask.mockResolvedValue({ ok: true, output: "done" });
      const onProgress = jest.fn();

      await runDecomposedTask({
        task: "add a feature",
        workspaceRoot: "/tmp",
        provider: "openai",
        model: "gpt-4",
        onProgress,
      });

      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: "step_start" })
      );
      expect(onProgress).toHaveBeenCalledWith(
        expect.objectContaining({ type: "step_complete", success: true })
      );
    });
  });
});
